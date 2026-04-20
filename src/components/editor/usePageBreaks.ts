import { useState, useEffect, useRef, type RefObject } from 'react';

/**
 * Visual page-break system for the TipTap editor.
 *
 * Two sources of page breaks:
 *   1. Forced breaks — `hr.hwp-page-break` elements from the ODT
 *      `<text:soft-page-break>` markers. Always produce a gap, regardless
 *      of how full the current page is.
 *   2. Overflow breaks — content that crosses an A4 boundary is pushed to
 *      the next page via an injected top-margin.
 *
 * The hook mutates the editor DOM (adds `margin-top` to the first element
 * of each new page) so the `.editor-layer` grows to fit all pages, and
 * returns the total page count + measured A4 height so the consumer can
 * render background `.page-frame` divs (one per page) at the right y-offsets.
 * The gaps between frames are the canvas gray background showing through.
 *
 * All positions are computed via `getBoundingClientRect` diffs against the
 * page element so we don't depend on `offsetParent` (which varies with
 * TipTap's internal positioning of `.ProseMirror`).
 */

const PAGE_GAP_PX = 32;
const GAP_ATTR = 'data-page-gap';

export interface PageGap {
  /** Y of the gray canvas strip (NOT including the page margins above/below it) */
  y: number;
  /** Height of the gray canvas strip (always PAGE_GAP_PX) */
  height: number;
  /** 1-based page number above this gap */
  pageAbove: number;
}

export interface PageBreakInfo {
  gaps: PageGap[];
  totalPages: number;
  /** Measured full page height in px (A4 = ~1122px at 96dpi) */
  pageHeightPx: number;
}

export function usePageBreaks(
  pageRef: RefObject<HTMLElement | null>,
  /** Extra deps (e.g. pageLayout) that should force a recompute */
  deps: ReadonlyArray<unknown> = [],
): PageBreakInfo {
  const [gaps, setGaps] = useState<PageGap[]>([]);
  const [pageHeightPx, setPageHeightPx] = useState<number>(0);
  const appliedRef = useRef<HTMLElement[]>([]);
  const runningRef = useRef(false);

  useEffect(() => {
    const pageEl = pageRef.current;
    if (!pageEl) return;

    const pm = pageEl.querySelector('.ProseMirror') as HTMLElement | null;
    if (!pm) return;

    const compute = () => {
      if (runningRef.current) return;
      runningRef.current = true;
      try {
        computeInner();
      } finally {
        runningRef.current = false;
      }
    };

    const computeInner = () => {
      // ── 1. Clean previous gap margins ──
      for (const el of appliedRef.current) {
        el.style.marginTop = '';
        el.removeAttribute(GAP_ATTR);
      }
      appliedRef.current = [];

      // ── 2. Measure page dimensions (px) ──
      const cs = getComputedStyle(pageEl);
      const padTop = parseFloat(cs.paddingTop) || 0;
      const padBot = parseFloat(cs.paddingBottom) || 0;

      const probe = document.createElement('div');
      probe.style.cssText =
        'height:var(--page-height);position:absolute;visibility:hidden;pointer-events:none;top:0;left:0;';
      pageEl.appendChild(probe);
      const pageHPx = probe.offsetHeight;
      pageEl.removeChild(probe);
      if (pageHPx <= 0) return;

      setPageHeightPx((prev) => (Math.abs(prev - pageHPx) > 0.5 ? pageHPx : prev));

      const contentH = pageHPx - padTop - padBot;
      if (contentH <= 0) return;

      const gapH = padBot + PAGE_GAP_PX + padTop;
      const newGaps: PageGap[] = [];

      // ── Helper: child top/bottom in .editor-layer coord space ──
      const bounds = (child: HTMLElement) => {
        const pr = pageEl.getBoundingClientRect();
        const cr = child.getBoundingClientRect();
        return { top: cr.top - pr.top, bottom: cr.bottom - pr.top };
      };

      // First page content area: [padTop, padTop + contentH]
      let pageEndY = padTop + contentH;

      for (let safety = 0; safety < 500; safety++) {
        let target: HTMLElement | null = null;
        let targetIsForced = false;
        const children = pm.children;

        for (let ci = 0; ci < children.length; ci++) {
          const child = children[ci] as HTMLElement;
          if (child.getAttribute(GAP_ATTR)) continue;

          const { top: cTop, bottom: cBot } = bounds(child);
          const isForced =
            child.tagName === 'HR' &&
            (child.classList.contains('hwp-page-break') ||
              child.hasAttribute('data-page-break'));

          if (isForced) {
            // Skip forced breaks that already sit above the current page's start
            if (cTop < pageEndY - contentH - 2) continue;
            target = child;
            targetIsForced = true;
            break;
          }

          if (cBot <= pageEndY + 2) continue;

          if (cTop >= pageEndY - 2) {
            target = child;
          } else if (cBot - cTop < contentH * 0.8) {
            target = child;
          } else {
            // Element is too tall to push cleanly (e.g. a huge table).
            // Let it straddle and break after it.
            pageEndY = cBot;
            continue;
          }
          break;
        }

        if (!target) break;

        // Natural top (pre-mutation) and natural CSS margin-top of target.
        // We need both because inline `margin-top` REPLACES the CSS value —
        // the target shifts by (inlineMt - naturalMt), not by inlineMt.
        const { top: t0 } = bounds(target);
        const naturalMt = parseFloat(getComputedStyle(target).marginTop) || 0;

        // Forced breaks anchor the page boundary at their own position (hr acts
        // as "page ends here, regardless of how full"). Overflow breaks anchor
        // at the natural pageEndY.
        const anchorY = targetIsForced ? t0 : pageEndY;

        // We want target's new top to land at the next page's content-area start.
        // Canvas layout: [page1 content][padBot][PAGE_GAP][padTop][page2 content]
        // Page 2 content starts at anchorY + padBot + PAGE_GAP_PX + padTop = anchorY + gapH.
        const desiredTop = anchorY + gapH;
        const mt = Math.max(gapH, desiredTop - t0 + naturalMt);

        target.style.marginTop = `${mt}px`;
        target.setAttribute(GAP_ATTR, 'true');
        appliedRef.current.push(target);

        // Gap region (gray canvas strip) sits at the bottom edge of the page rectangle.
        newGaps.push({
          y: anchorY + padBot,
          height: PAGE_GAP_PX,
          pageAbove: newGaps.length + 1,
        });

        // Re-measure to get the actual new top (accounts for margin-collapse etc.),
        // then advance pageEndY to the next page's content-area bottom.
        const { top: newTop } = bounds(target);
        pageEndY = newTop + contentH;
      }

      setGaps((prev) => (gapsEqual(prev, newGaps) ? prev : newGaps));
    };

    let rafId: number | null = null;
    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        compute();
      });
    };

    schedule();

    const ro = new ResizeObserver(() => schedule());
    ro.observe(pm);
    ro.observe(pageEl);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro.disconnect();
      for (const el of appliedRef.current) {
        el.style.marginTop = '';
        el.removeAttribute(GAP_ATTR);
      }
      appliedRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageRef, ...deps]);

  return { gaps, totalPages: gaps.length + 1, pageHeightPx };
}

function gapsEqual(a: PageGap[], b: PageGap[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i].y - b[i].y) > 0.5 || Math.abs(a[i].height - b[i].height) > 0.5) return false;
  }
  return true;
}

export { PAGE_GAP_PX };
