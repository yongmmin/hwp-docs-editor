import JSZip from 'jszip';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { computeParagraphSignature, extractParagraphGroupsFromHtml } from './exportPlan';
import type { HwpxExportContext, HwpxExportPlanEntry } from '../../types';

type OrderedNode = Record<string, unknown>;
type OrderedNodes = OrderedNode[];

interface ParagraphCursor {
  index: number;
  values: string[];
}

const orderedXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  preserveOrder: true,
  ignoreDeclaration: true,
});

const orderedXmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  preserveOrder: true,
  suppressEmptyNode: false,
  format: true,
  indentBy: '  ',
});

/**
 * Export edited content back to HWPX format.
 *
 * Strategy:
 * - HWPX: keep the original package and patch paragraph text back into the
 *   original XML files so tables/images/layout survive the round-trip.
 * - HWP: create a minimal HWPX package as a fallback.
 */
export async function exportToHwpx(
  html: string,
  originalZipData?: ArrayBuffer,
  exportContext?: HwpxExportContext
): Promise<Blob> {
  if (originalZipData) {
    return exportWithOriginalStructure(html, originalZipData, exportContext);
  }
  return exportMinimalHwpx(html);
}

async function exportWithOriginalStructure(
  html: string,
  originalZipData: ArrayBuffer,
  exportContext?: HwpxExportContext
): Promise<Blob> {
  const zip = await JSZip.loadAsync(originalZipData);
  const groups = extractParagraphGroupsFromHtml(html);
  const exportEntries = getContextExportEntries(zip, exportContext);

  if (exportEntries.length > 0) {
    await patchRegionEntries(zip, exportEntries, 'header', groups.headers);
    const bodyEntries = exportEntries.filter((item) => item.region === 'body');
    if (bodyEntries.length === 0) {
      zip.file('Contents/sec0.xml', htmlToHwpxSection(html));
    } else {
      await patchRegionEntries(zip, exportEntries, 'body', groups.body);
    }
    await patchRegionEntries(zip, exportEntries, 'footer', groups.footers);
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }

  const fallbackEntries = await resolveFallbackExportEntries(zip);
  const headerCursor: ParagraphCursor = { index: 0, values: groups.headers };
  const bodyCursor: ParagraphCursor = { index: 0, values: groups.body };
  const footerCursor: ParagraphCursor = { index: 0, values: groups.footers };

  for (const entry of fallbackEntries.filter((item) => item.region === 'header')) {
    await patchXmlFileText(zip, entry.path, headerCursor);
  }

  const bodyEntries = fallbackEntries.filter((item) => item.region === 'body');
  if (bodyEntries.length === 0) {
    zip.file('Contents/sec0.xml', htmlToHwpxSection(html));
  } else {
    for (const entry of bodyEntries) {
      await patchXmlFileText(zip, entry.path, bodyCursor);
    }
  }

  for (const entry of exportEntries.filter((item) => item.region === 'footer')) {
    await patchXmlFileText(zip, entry.path, footerCursor);
  }

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

function getContextExportEntries(
  zip: JSZip,
  exportContext?: HwpxExportContext
): HwpxExportPlanEntry[] {
  return exportContext?.entries
    ?.filter((entry) => Boolean(entry?.path) && Boolean(zip.file(entry.path))) ?? [];
}

async function patchRegionEntries(
  zip: JSZip,
  exportEntries: HwpxExportPlanEntry[],
  region: 'body' | 'header' | 'footer',
  values: string[],
): Promise<void> {
  const entries = exportEntries.filter((item) => item.region === region);
  let index = 0;

  for (const entry of entries) {
    const nextValues = values.slice(index, index + Math.max(0, entry.paragraphCount));
    index += Math.max(0, entry.paragraphCount);

    if (entry.textSignature && computeParagraphSignature(nextValues) === entry.textSignature) {
      continue;
    }

    await patchXmlFileValues(zip, entry.path, nextValues);
  }
}

async function resolveFallbackExportEntries(
  zip: JSZip,
): Promise<HwpxExportPlanEntry[]> {
  const manifestXmlRefs = await collectManifestXmlRefs(zip);
  const sectionPaths = mergeOrderedPaths(
    manifestXmlRefs.filter(isSectionXmlPath),
    collectZipPaths(zip, /Contents\/sec\d+\.xml$/i, /Contents\/section\d+\.xml$/i)
  );
  const headerPaths = mergeOrderedPaths(
    manifestXmlRefs.filter((path) => /(?:^|\/)[^/]*header[^/]*\.xml$/i.test(path)),
    collectZipPaths(zip, /Contents\/[^/]*header[^/]*\.xml$/i)
  );
  const footerPaths = mergeOrderedPaths(
    manifestXmlRefs.filter((path) => /(?:^|\/)[^/]*footer[^/]*\.xml$/i.test(path)),
    collectZipPaths(zip, /Contents\/[^/]*footer[^/]*\.xml$/i)
  );

  return [
    ...headerPaths.map((path): HwpxExportPlanEntry => ({ path, region: 'header', paragraphCount: 0 })),
    ...sectionPaths.map((path): HwpxExportPlanEntry => ({ path, region: 'body', paragraphCount: 0 })),
    ...footerPaths.map((path): HwpxExportPlanEntry => ({ path, region: 'footer', paragraphCount: 0 })),
  ];
}

async function patchXmlFileValues(
  zip: JSZip,
  path: string,
  values: string[],
): Promise<void> {
  const file = zip.file(path);
  if (!file) return;

  const xml = await file.async('string');
  const nextXml = patchXmlParagraphValues(xml, values);
  if (nextXml !== xml) {
    zip.file(path, nextXml);
  }
}

async function patchXmlFileText(
  zip: JSZip,
  path: string,
  cursor: ParagraphCursor
): Promise<void> {
  if (cursor.index >= cursor.values.length) return;

  const file = zip.file(path);
  if (!file) return;

  const xml = await file.async('string');
  const nextXml = patchXmlParagraphText(xml, cursor);
  if (nextXml !== xml) {
    zip.file(path, nextXml);
  }
}

function patchXmlParagraphValues(xml: string, values: string[]): string {
  try {
    const declaration = xml.match(/^\s*<\?xml[^>]*\?>\s*/)?.[0] ?? '';
    const parsed = orderedXmlParser.parse(xml) as OrderedNodes;
    const paragraphs = collectParagraphNodes(parsed);

    for (let i = 0; i < paragraphs.length; i += 1) {
      patchParagraphNodeText(paragraphs[i], values[i] ?? '');
    }

    return `${declaration}${orderedXmlBuilder.build(parsed)}`;
  } catch {
    return xml;
  }
}

function patchXmlParagraphText(xml: string, cursor: ParagraphCursor): string {
  try {
    const declaration = xml.match(/^\s*<\?xml[^>]*\?>\s*/)?.[0] ?? '';
    const parsed = orderedXmlParser.parse(xml) as OrderedNodes;
    const paragraphs = collectParagraphNodes(parsed);
    const startIndex = cursor.index;

    for (const paragraph of paragraphs) {
      if (cursor.index >= cursor.values.length) break;
      patchParagraphNodeText(paragraph, cursor.values[cursor.index]);
      cursor.index += 1;
    }

    if (cursor.index === startIndex) return xml;
    return `${declaration}${orderedXmlBuilder.build(parsed)}`;
  } catch {
    return xml;
  }
}

function collectParagraphNodes(nodes: OrderedNodes, out: OrderedNode[] = []): OrderedNode[] {
  for (const node of nodes) {
    const name = getNodeName(node);
    if (!name) continue;

    if (isParagraphTag(name)) {
      out.push(node);
      continue;
    }

    collectParagraphNodes(getNodeChildren(node), out);
  }

  return out;
}

function patchParagraphNodeText(paragraph: OrderedNode, nextText: string): void {
  const textNodes = collectTextLeafNodes(paragraph);
  const normalizedText = normalizePatchedText(nextText);

  if (textNodes.length === 0) {
    ensureParagraphTextNode(paragraph, normalizedText);
    return;
  }

  const originalLengths = textNodes.map((node) => String(node['#text'] ?? '').length);
  let offset = 0;

  for (let i = 0; i < textNodes.length; i += 1) {
    const node = textNodes[i];
    const take = i === textNodes.length - 1
      ? normalizedText.length - offset
      : Math.min(originalLengths[i], Math.max(0, normalizedText.length - offset));

    node['#text'] = normalizedText.slice(offset, offset + Math.max(0, take));
    offset += Math.max(0, take);
  }
}

function collectTextLeafNodes(node: OrderedNode, out: OrderedNode[] = []): OrderedNode[] {
  const name = getNodeName(node);
  if (name === '#text') {
    out.push(node);
    return out;
  }

  for (const child of getNodeChildren(node)) {
    collectTextLeafNodes(child, out);
  }

  return out;
}

function ensureParagraphTextNode(paragraph: OrderedNode, text: string): void {
  const paragraphKey = getNodeKey(paragraph);
  if (!paragraphKey) return;

  const prefix = paragraphKey.includes(':') ? paragraphKey.split(':')[0] : null;
  const runKey = prefix ? `${prefix}:run` : 'run';
  const textKey = prefix ? `${prefix}:t` : 't';
  const paragraphChildren = getMutableChildren(paragraph);
  const existingRun = paragraphChildren.find((child) => getNodeName(child) === 'run');

  if (existingRun) {
    const runChildren = getMutableChildren(existingRun);
    const existingText = runChildren.find((child) => getNodeName(child) === 't');

    if (existingText) {
      setNodeChildren(existingText, [{ '#text': text }]);
      return;
    }

    runChildren.push({ [textKey]: [{ '#text': text }] });
    return;
  }

  paragraphChildren.push({
    [runKey]: [
      {
        [textKey]: [{ '#text': text }],
      },
    ],
  });
}

function normalizePatchedText(text: string): string {
  return text.replace(/\u00A0/g, ' ').replace(/\r\n?/g, '\n');
}

async function exportMinimalHwpx(html: string): Promise<Blob> {
  const zip = new JSZip();

  zip.file('mimetype', 'application/hwp+zip');

  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container>
  <rootfiles>
    <rootfile full-path="Contents/content.hpf" media-type="application/hwp+xml"/>
  </rootfiles>
</container>`);

  zip.file('Contents/content.hpf', `<?xml version="1.0" encoding="UTF-8"?>
<hp:package xmlns:hp="http://www.hancom.co.kr/hwpml/2011/package">
  <hp:mainSection href="sec0.xml"/>
</hp:package>`);

  zip.file('Contents/sec0.xml', htmlToHwpxSection(html));

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

async function collectManifestXmlRefs(zip: JSZip): Promise<string[]> {
  const manifest = zip.file('Contents/content.hpf');
  if (!manifest) return [];

  try {
    const xml = await manifest.async('string');
    return parseManifestXmlRefs(xml, 'Contents/content.hpf');
  } catch {
    return [];
  }
}

function parseManifestXmlRefs(xml: string, manifestPath: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const baseDir = manifestPath.split('/').slice(0, -1).join('/');

  for (const match of xml.matchAll(/\b(?:href|full-path|target|src)=["']([^"']+\.xml(?:#[^"']*)?)["']/gi)) {
    const ref = match[1]?.split('#')[0];
    if (!ref) continue;

    const resolved = resolveRelativeZipPath(baseDir, ref);
    if (
      !resolved ||
      seen.has(resolved) ||
      /(?:^|\/)(content\.hpf|mimetype|settings\.xml)$/i.test(resolved) ||
      !resolved.toLowerCase().startsWith('contents/')
    ) {
      continue;
    }

    seen.add(resolved);
    refs.push(resolved);
  }

  return refs;
}

function collectZipPaths(zip: JSZip, ...patterns: RegExp[]): string[] {
  const paths: string[] = [];

  zip.forEach((path) => {
    if (patterns.some((pattern) => pattern.test(path))) {
      paths.push(path);
    }
  });

  return paths.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );
}

function mergeOrderedPaths(primary: string[], secondary: string[]): string[] {
  const merged = new Set<string>();

  for (const path of primary) merged.add(path);
  for (const path of secondary) merged.add(path);

  return Array.from(merged);
}

function isSectionXmlPath(path: string): boolean {
  return /(?:^|\/)(sec\d+|section\d+)\.xml$/i.test(path);
}

function normalizeZipPath(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/');
  const normalized: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }

  return normalized.join('/');
}

function resolveRelativeZipPath(baseDir: string, ref: string): string {
  if (!ref) return '';

  const normalizedRef = ref.replace(/\\/g, '/');
  if (/^[A-Za-z]+:\//.test(normalizedRef)) return '';
  if (normalizedRef.startsWith('/')) return normalizeZipPath(normalizedRef.slice(1));
  if (!baseDir) return normalizeZipPath(normalizedRef);
  return normalizeZipPath(`${baseDir}/${normalizedRef}`);
}

function getNodeName(node: OrderedNode): string | null {
  const key = getNodeKey(node);
  if (!key) return null;
  return key === '#text' ? '#text' : getLocalName(key);
}

function getNodeKey(node: OrderedNode): string | null {
  for (const key of Object.keys(node)) {
    if (key === ':@') continue;
    return key;
  }
  return null;
}

function getNodeChildren(node: OrderedNode): OrderedNodes {
  const key = getNodeKey(node);
  if (!key) return [];

  const value = node[key];
  return Array.isArray(value) ? (value as OrderedNodes) : [];
}

function getMutableChildren(node: OrderedNode): OrderedNodes {
  const key = getNodeKey(node);
  if (!key) return [];

  const current = node[key];
  if (Array.isArray(current)) {
    return current as OrderedNodes;
  }

  const children: OrderedNodes = [];
  node[key] = children;
  return children;
}

function setNodeChildren(node: OrderedNode, children: OrderedNodes): void {
  const key = getNodeKey(node);
  if (!key) return;
  node[key] = children;
}

function getLocalName(name: string): string {
  return name.split(':').pop()?.toLowerCase() || name.toLowerCase();
}

function isParagraphTag(name: string): boolean {
  return name === 'p' || name === 'para';
}

// ──────────────────────────────────────────────
// HTML → minimal HWPX XML fallback
// ──────────────────────────────────────────────

function htmlToHwpxSection(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;

  const xmlParts: string[] = [];
  convertNodes(div.childNodes, xmlParts);

  return `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"
        xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"
        xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">
${xmlParts.join('\n')}
</hs:sec>`;
}

function convertNodes(nodes: NodeListOf<ChildNode>, out: string[]): void {
  for (const node of Array.from(nodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) {
        out.push(wrapParagraph([{ text, bold: false, italic: false, underline: false, strike: false, fontSize: 0 }]));
      }
      continue;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    if (tag === 'table') {
      out.push(convertTable(el));
    } else if (tag === 'p' || tag.match(/^h[1-6]$/)) {
      out.push(convertParagraph(el, tag));
    } else if (tag === 'section') {
      const regionBody = el.querySelector(':scope > .document-region-body');
      if (regionBody) {
        convertNodes(regionBody.childNodes, out);
      } else {
        convertNodes(el.childNodes, out);
      }
    } else if (tag === 'ul' || tag === 'ol') {
      convertList(el, out);
    } else if (tag === 'blockquote') {
      convertNodes(el.childNodes, out);
    } else if (tag === 'div') {
      if (el.classList.contains('document-region-label')) {
        continue;
      }
      convertNodes(el.childNodes, out);
    } else if (tag === 'br') {
      out.push(wrapParagraph([]));
    }
  }
}

interface TextRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  fontSize: number;
}

function convertParagraph(el: HTMLElement, tag: string): string {
  const runs = extractRuns(el);
  if (runs.length === 0 && !el.textContent?.trim()) {
    return wrapParagraph([]);
  }

  const headingSizes: Record<string, number> = {
    h1: 18, h2: 14, h3: 12, h4: 11, h5: 10, h6: 9,
  };

  if (headingSizes[tag]) {
    for (const run of runs) {
      run.bold = true;
      if (!run.fontSize) run.fontSize = headingSizes[tag];
    }
  }

  const align = el.style?.textAlign || '';
  return wrapParagraph(runs, align);
}

function extractRuns(node: Node): TextRun[] {
  const runs: TextRun[] = [];
  collectRuns(node, runs, false, false, false, false, 0);
  return runs;
}

function collectRuns(
  node: Node,
  runs: TextRun[],
  bold: boolean,
  italic: boolean,
  underline: boolean,
  strike: boolean,
  fontSize: number,
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || '';
    if (text) {
      runs.push({ text, bold, italic, underline, strike, fontSize });
    }
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  let b = bold, i = italic, u = underline, s = strike, fs = fontSize;
  if (tag === 'strong' || tag === 'b') b = true;
  if (tag === 'em' || tag === 'i') i = true;
  if (tag === 'u') u = true;
  if (tag === 's' || tag === 'del' || tag === 'strike') s = true;

  const style = el.getAttribute('style') || '';
  const fMatch = style.match(/font-size:\s*([\d.]+)pt/);
  if (fMatch) fs = parseFloat(fMatch[1]);

  for (const child of Array.from(el.childNodes)) {
    collectRuns(child, runs, b, i, u, s, fs);
  }
}

function wrapParagraph(runs: TextRun[], align?: string): string {
  if (runs.length === 0) {
    return '  <hp:p><hp:run><hp:t></hp:t></hp:run></hp:p>';
  }

  const alignAttr = align && align !== 'left'
    ? `\n      <hp:paraPr><hp:align horizontal="${escapeXml(align)}"/></hp:paraPr>`
    : '';

  const runXml = runs.map((run) => {
    const prParts: string[] = [];
    if (run.bold) prParts.push('<hp:bold/>');
    if (run.italic) prParts.push('<hp:italic/>');
    if (run.underline) prParts.push('<hp:underline/>');
    if (run.strike) prParts.push('<hp:strikethrough/>');
    if (run.fontSize > 0) prParts.push(`<hp:sz val="${Math.round(run.fontSize * 100)}"/>`);

    const rPr = prParts.length > 0
      ? `\n        <hp:rPr>${prParts.join('')}</hp:rPr>`
      : '';

    return `      <hp:run>${rPr}
        <hp:t>${escapeXml(run.text)}</hp:t>
      </hp:run>`;
  }).join('\n');

  return `  <hp:p>${alignAttr}
${runXml}
  </hp:p>`;
}

function convertTable(table: HTMLElement): string {
  const rows = table.querySelectorAll('tr');
  if (rows.length === 0) return '';

  const trXml: string[] = [];

  for (const tr of Array.from(rows)) {
    const cells = tr.querySelectorAll('td, th');
    const tcXml: string[] = [];

    for (const cell of Array.from(cells)) {
      const colspan = parseInt(cell.getAttribute('colspan') || '1', 10);
      const rowspan = parseInt(cell.getAttribute('rowspan') || '1', 10);

      const cellParts: string[] = [];
      const blockEls = cell.querySelectorAll('p, h1, h2, h3, h4, h5, h6');
      if (blockEls.length > 0) {
        for (const block of Array.from(blockEls)) {
          cellParts.push(convertParagraph(block as HTMLElement, block.tagName.toLowerCase()));
        }
      } else {
        const runs = extractRuns(cell);
        cellParts.push(wrapParagraph(runs.length > 0 ? runs : [{ text: cell.textContent || '', bold: false, italic: false, underline: false, strike: false, fontSize: 0 }]));
      }

      const attrs: string[] = [];
      if (colspan > 1) attrs.push(`colspan="${colspan}"`);
      if (rowspan > 1) attrs.push(`rowspan="${rowspan}"`);
      const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';

      tcXml.push(`      <hp:tc${attrStr}>\n${cellParts.join('\n')}\n      </hp:tc>`);
    }

    trXml.push(`    <hp:tr>\n${tcXml.join('\n')}\n    </hp:tr>`);
  }

  return `  <hp:tbl>\n${trXml.join('\n')}\n  </hp:tbl>`;
}

function convertList(list: HTMLElement, out: string[]): void {
  const items = list.querySelectorAll(':scope > li');
  for (const li of Array.from(items)) {
    const prefix = list.tagName.toLowerCase() === 'ol'
      ? `${Array.from(items).indexOf(li) + 1}. `
      : '• ';
    const runs = extractRuns(li);
    if (runs.length > 0) {
      runs[0].text = prefix + runs[0].text;
    } else {
      runs.push({ text: prefix + (li.textContent || ''), bold: false, italic: false, underline: false, strike: false, fontSize: 0 });
    }
    out.push(wrapParagraph(runs));
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
