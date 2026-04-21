import { useState, useEffect, useRef, type RefObject } from 'react';

/**
 * Visual page-break system for the TipTap editor.
 *
 * Two sources of page breaks:
 *   1. Forced breaks — `hr.hwp-page-break` elements from the ODT parser.
 *   2. Overflow breaks — content that crosses an A4 boundary is pushed to
 *      the next page via an injected margin-top.
 *
 * The hook mutates the editor DOM and returns totalPages + pageHeightPx so
 * DocumentEditor can render background .page-frame divs at the right offsets.
 */

export const PAGE_GAP_PX = 32;
const GAP_ATTR = 'data-page-gap';

export interface PageGap {
  y: number;
  height: number;
  pageAbove: number;
}

export interface PageBreakInfo {
  gaps: PageGap[];
  totalPages: number;
  pageHeightPx: number;
}

function cssLengthToPx(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;

  const match = trimmed.match(/^(-?\d+(?:\.\d+)?)(px|pt|mm|cm|in)?$/i);
  if (!match) return 0;

  const amount = parseFloat(match[1]);
  const unit = (match[2] || 'px').toLowerCase();
  if (!Number.isFinite(amount)) return 0;

  switch (unit) {
    case 'px':
      return amount;
    case 'pt':
      return amount * (96 / 72);
    case 'mm':
      return amount * (96 / 25.4);
    case 'cm':
      return amount * (96 / 2.54);
    case 'in':
      return amount * 96;
    default:
      return 0;
  }
}

export function usePageBreaks(
  pageRef: RefObject<HTMLElement | null>,
  deps: ReadonlyArray<unknown> = [],
): PageBreakInfo {
  const [gaps, setGaps] = useState<PageGap[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [pageHeightPx, setPageHeightPx] = useState<number>(0);
  const appliedRef = useRef<HTMLElement[]>([]);
  const runningRef = useRef(false);
  // Suppress ResizeObserver callbacks triggered by our own DOM mutations
  const suppressRef = useRef(false);

  useEffect(() => {
    const pageEl = pageRef.current;
    if (!pageEl) return;
    const metricsRoot = (pageEl.closest('.pages-stack') as HTMLElement | null) ?? pageEl;

    const schedule = () => compute();

    const compute = () => {
      if (runningRef.current) return;
      runningRef.current = true;
      try {
        const pm = pageEl.querySelector('.ProseMirror') as HTMLElement | null;
        if (!pm) return;

        // ── 1. Measure page dimensions from resolved CSS custom properties ──
        const cs = getComputedStyle(metricsRoot);
        const layerStyle = getComputedStyle(pageEl);
        const frameEl = metricsRoot.querySelector('.page-frame') as HTMLElement | null;
        const pageHPx =
          frameEl?.getBoundingClientRect().height ||
          cssLengthToPx(cs.getPropertyValue('--page-height'));
        const padTop = parseFloat(layerStyle.paddingTop) || cssLengthToPx(cs.getPropertyValue('--page-padding-top'));
        const padBot = parseFloat(layerStyle.paddingBottom) || cssLengthToPx(cs.getPropertyValue('--page-padding-bottom'));

        if (pageHPx <= 0) return;
        const contentH = pageHPx - padTop - padBot;
        if (contentH <= 10) return;

        setPageHeightPx(prev => (Math.abs(prev - pageHPx) > 0.5 ? pageHPx : prev));

        const gapH = padBot + PAGE_GAP_PX + padTop;

        // ── 2. Suppress ResizeObserver while we mutate the DOM ──
        suppressRef.current = true;

        // ── 3. Clear all previously injected margins ──
        for (const el of appliedRef.current) {
          el.style.marginTop = '';
          el.removeAttribute(GAP_ATTR);
        }
        appliedRef.current = [];

        // ── 4. Helper: child position relative to editor-layer ──
        const pageRect = pageEl.getBoundingClientRect();
        const childTop = (el: HTMLElement) => el.getBoundingClientRect().top  - pageRect.top;
        const childBot = (el: HTMLElement) => el.getBoundingClientRect().bottom - pageRect.top;

        // First page content area: [padTop, padTop + contentH]
        let pageEndY = padTop + contentH;
        const newGaps: PageGap[] = [];

        // ── 5. Walk children and inject page-break margins ──
        for (let safety = 0; safety < 500; safety++) {
          let target: HTMLElement | null = null;

          for (let ci = 0; ci < pm.children.length; ci++) {
            const child = pm.children[ci] as HTMLElement;
            if (child.getAttribute(GAP_ATTR)) continue;

            const cTop = childTop(child);
            const cBot = childBot(child);

            const isForced =
              child.tagName === 'HR' &&
              (child.classList.contains('hwp-page-break') ||
                child.hasAttribute('data-page-break'));

            if (isForced) {
              // Skip forced breaks that already sit above this page's start
              if (cTop < pageEndY - contentH - 2) continue;
              target = child;
              break;
            }

            // Element fits on current page
            if (cBot <= pageEndY + 2) continue;

            // Element overflows — push it to the next page.
            // For very tall elements (> one page), we still push so the top
            // margin of the next page is correct; overflow past the bottom is
            // unavoidable for elements taller than one content area.
            target = child;
            break;
          }

          if (!target) break;

          // Natural top and CSS margin-top of the target (before our mutation).
          // Setting style.marginTop *replaces* the CSS value, so we must account
          // for the difference.
          const t0        = childTop(target);
          const naturalMt = parseFloat(getComputedStyle(target).marginTop) || 0;

          // anchorY: always the current page's content-area end.
          // Forced breaks mean "start a new page here" — the current page frame
          // still fills the full A4 height, so the gap must be anchored at
          // pageEndY (the frame boundary), not at the hr's own position.
          const anchorY = pageEndY;

          // desiredTop: where the target's top should land (page content start).
          const desiredTop = anchorY + gapH;

          // mt replaces naturalMt, so delta = (mt - naturalMt). We need
          // delta = desiredTop - t0, i.e. mt = desiredTop - t0 + naturalMt.
          // Clamp to at least gapH so we always clear the gap region.
          const mt = Math.max(gapH, desiredTop - t0 + naturalMt);

          target.style.marginTop = `${mt}px`;
          target.setAttribute(GAP_ATTR, 'true');
          appliedRef.current.push(target);

          // Re-measure actual new top after layout so page chrome follows the
          // real layout result, not just the ideal target position.
          const newTop = childTop(target);
          const nextPageTop = Math.max(0, newTop - padTop);

          newGaps.push({
            y: Math.max(0, nextPageTop - PAGE_GAP_PX),
            height: PAGE_GAP_PX,
            pageAbove: newGaps.length + 1,
          });

          pageEndY = newTop + contentH;
        }

        // ── 6. Un-suppress observer after this frame's ResizeObserver fires ──
        // setTimeout(0) runs in the next task, after ResizeObserver callbacks
        // (which fire during the rendering pipeline before paint).
        setTimeout(() => { suppressRef.current = false; }, 0);

        // Infer required frames from the actual laid-out content height as a
        // safety net. This covers cases where DOM structure changes or an
        // oversized element extends beyond the last injected break.
        const contentSpanPx = Math.max(
          0,
          pageEl.scrollHeight - padTop - padBot - newGaps.length * gapH,
        );
        const inferredPages = Math.max(1, Math.ceil(contentSpanPx / contentH));
        const nextTotalPages = Math.max(newGaps.length + 1, inferredPages);

        setGaps(prev => (gapsEqual(prev, newGaps) ? prev : newGaps));
        setTotalPages(prev => (prev === nextTotalPages ? prev : nextTotalPages));
      } finally {
        runningRef.current = false;
      }
    };

    schedule();

    const bootstrapId = window.setInterval(() => {
      const frameEl = metricsRoot.querySelector('.page-frame') as HTMLElement | null;
      const frameHeight = frameEl?.getBoundingClientRect().height ?? 0;
      if (frameHeight > 0) {
        setPageHeightPx(prev => (Math.abs(prev - frameHeight) > 0.5 ? frameHeight : prev));
      }
      schedule();
    }, 250);
    const bootstrapStopId = window.setTimeout(() => {
      window.clearInterval(bootstrapId);
    }, 5000);

    const ro = new ResizeObserver(() => {
      if (!suppressRef.current) schedule();
    });
    const mo = new MutationObserver(() => {
      if (!suppressRef.current) schedule();
    });

    // Observe both the editor content and the page container
    const pm = pageEl.querySelector('.ProseMirror');
    if (pm) {
      ro.observe(pm);
      mo.observe(pm, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    }
    ro.observe(pageEl);
    mo.observe(pageEl, { childList: true, subtree: true });

    return () => {
      ro.disconnect();
      mo.disconnect();
      window.clearInterval(bootstrapId);
      window.clearTimeout(bootstrapStopId);
      suppressRef.current = true;
      for (const el of appliedRef.current) {
        el.style.marginTop = '';
        el.removeAttribute(GAP_ATTR);
      }
      appliedRef.current = [];
      suppressRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageRef, ...deps]);

  return { gaps, totalPages, pageHeightPx };
}

function gapsEqual(a: PageGap[], b: PageGap[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i].y - b[i].y) > 0.5 || Math.abs(a[i].height - b[i].height) > 0.5) return false;
  }
  return true;
}
