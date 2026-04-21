import { Node } from '@tiptap/core';

/**
 * Custom page-break node. Emitted by the ODT parser as
 * `<hr class="hwp-page-break"/>` at each `<text:soft-page-break>` location.
 *
 * Renders as a 0-height HR that the `usePageBreaks` hook targets to force a
 * page-division gap — the visual page separator is drawn by an overlay in
 * `DocumentEditor`, not by this element itself.
 *
 * Priority is set above StarterKit's HorizontalRule so this parser wins for
 * `hr.hwp-page-break` while plain `<hr>` still maps to HorizontalRule.
 */
export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,
  priority: 1000,

  parseHTML() {
    return [
      { tag: 'hr.hwp-page-break' },
      { tag: 'hr[data-page-break]' },
    ];
  },

  renderHTML() {
    return ['hr', { class: 'hwp-page-break', 'data-page-break': 'true' }];
  },
});
