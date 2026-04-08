import { Paragraph as BaseParagraph } from '@tiptap/extension-paragraph';
import { mergeAttributes } from '@tiptap/core';

/**
 * Extended Paragraph that preserves HWP/ODT paragraph-level styles:
 * line-height, margin-top, margin-bottom, text-indent.
 *
 * TipTap's base Paragraph has only `{ tag: 'p' }` in parseHTML with no getAttrs,
 * so it drops all inline styles. This extension captures them.
 */
export const Paragraph = BaseParagraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      'data-hwp-para-id': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-hwp-para-id') || null,
        renderHTML: (attributes) => {
          const value = attributes['data-hwp-para-id'];
          return value ? { 'data-hwp-para-id': value } : {};
        },
      },
      style: {
        default: null,
        parseHTML: (element) => element.getAttribute('style') || null,
        renderHTML: (attributes) => {
          if (!attributes.style) return {};
          return { style: attributes.style };
        },
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    return ['p', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
});
