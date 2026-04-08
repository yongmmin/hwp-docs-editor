export interface ExportParagraphGroups {
  body: string[];
  headers: string[];
  footers: string[];
}

export function extractParagraphTextById(html: string): Map<string, string> {
  const root = document.createElement('div');
  root.innerHTML = html;

  const values = new Map<string, string>();
  const elements = root.querySelectorAll<HTMLElement>('[data-hwp-para-id]');

  for (const element of Array.from(elements)) {
    const id = element.getAttribute('data-hwp-para-id');
    if (!id) continue;
    values.set(id, extractElementText(element));
  }

  return values;
}

export function extractParagraphGroupsFromHtml(html: string): ExportParagraphGroups {
  const root = document.createElement('div');
  root.innerHTML = html;

  const groups: ExportParagraphGroups = {
    body: [],
    headers: [],
    footers: [],
  };

  for (const child of Array.from(root.childNodes)) {
    collectParagraphTexts(child, groups.body, groups);
  }

  return groups;
}

export function computeParagraphSignature(values: string[]): string {
  let hash = 2166136261;

  for (const value of values) {
    const normalized = normalizeHtmlParagraphText(value);
    for (let i = 0; i < normalized.length; i += 1) {
      hash ^= normalized.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 31;
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

function collectParagraphTexts(
  node: ChildNode,
  target: string[],
  groups: ExportParagraphGroups
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = normalizeHtmlParagraphText(node.textContent || '');
    if (text.trim()) target.push(text);
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  if (tag === 'section') {
    const region = el.getAttribute('data-doc-region');
    if (region === 'header' || region === 'footer') {
      const nextTarget = region === 'header' ? groups.headers : groups.footers;
      const regionBody = el.querySelector(':scope > .document-region-body');
      const children = regionBody ? Array.from(regionBody.childNodes) : Array.from(el.childNodes);
      for (const child of children) {
        collectParagraphTexts(child, nextTarget, groups);
      }
      return;
    }
  }

  if (tag === 'p' || /^h[1-6]$/.test(tag) || tag === 'li') {
    target.push(extractElementText(el));
    return;
  }

  if (tag === 'td' || tag === 'th') {
    const hasBlockChildren = Array.from(el.children).some((child) =>
      /^(p|h[1-6]|ul|ol|table|blockquote|div|section)$/i.test(child.tagName)
    );

    if (!hasBlockChildren) {
      const text = extractElementText(el);
      if (text.trim()) target.push(text);
      return;
    }
  }

  if (tag === 'div' && el.classList.contains('document-region-label')) return;
  if (tag === 'img' || tag === 'hr') return;

  for (const child of Array.from(el.childNodes)) {
    collectParagraphTexts(child, target, groups);
  }
}

function extractElementText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || '';
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  if (tag === 'br') return '\n';
  if (tag === 'img' || tag === 'hr') return '';
  if (tag === 'div' && el.classList.contains('document-region-label')) return '';

  let text = '';
  for (const child of Array.from(el.childNodes)) {
    text += extractElementText(child);
  }

  return normalizeHtmlParagraphText(text);
}

function normalizeHtmlParagraphText(text: string): string {
  return text.replace(/\u00A0/g, ' ');
}
