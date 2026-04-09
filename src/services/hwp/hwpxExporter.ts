import JSZip from 'jszip';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { computeParagraphSignature, extractParagraphGroupsFromHtml, extractParagraphTextById } from './exportPlan';
import type { HwpxExportContext, HwpxExportPlanEntry } from '../../types';

// ODT XML namespaces — mirrors odtParser.ts NS constants
const ODT_NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  text:   'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table:  'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  style:  'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  fo:     'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
} as const;

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
 * - HWPX origin: keep the original package and patch paragraph text back into
 *   the original XML files so tables/images/layout survive the round-trip.
 * - HWP origin with ODT data: convert ODT XML → HWPX using structural data
 *   from pyhwp (column widths, cell spans) combined with user's edited text.
 * - HWP origin without ODT data (fallback): generate minimal HWPX from HTML.
 */
export async function exportToHwpx(
  html: string,
  originalZipData?: ArrayBuffer,
  exportContext?: HwpxExportContext,
  rawOdtContentXml?: string,
  rawOdtStylesXml?: string,
): Promise<Blob> {
  if (originalZipData) {
    return exportWithOriginalStructure(html, originalZipData, exportContext);
  }
  return exportMinimalHwpx(html, rawOdtContentXml, rawOdtStylesXml);
}

async function exportWithOriginalStructure(
  html: string,
  originalZipData: ArrayBuffer,
  exportContext?: HwpxExportContext
): Promise<Blob> {
  const zip = await JSZip.loadAsync(originalZipData);
  const groups = extractParagraphGroupsFromHtml(html);
  const paragraphTextById = extractParagraphTextById(html);
  const exportEntries = getContextExportEntries(zip, exportContext);

  if (exportEntries.length > 0) {
    await patchRegionEntries(zip, exportEntries, 'header', groups.headers, paragraphTextById);
    const bodyEntries = exportEntries.filter((item) => item.region === 'body');
    if (bodyEntries.length === 0) {
      zip.file('Contents/sec0.xml', htmlToHwpxSection(html));
    } else {
      await patchRegionEntries(zip, exportEntries, 'body', groups.body, paragraphTextById);
    }
    await patchRegionEntries(zip, exportEntries, 'footer', groups.footers, paragraphTextById);
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

  for (const entry of fallbackEntries.filter((item) => item.region === 'footer')) {
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
  paragraphTextById: Map<string, string>,
): Promise<void> {
  const entries = exportEntries.filter((item) => item.region === region);
  let index = 0;

  for (const entry of entries) {
    const nextValues = getEntryValues(entry, values, paragraphTextById, index);
    index += Math.max(0, entry.paragraphCount);

    if (entry.textSignature && computeParagraphSignature(nextValues) === entry.textSignature) {
      continue;
    }

    await patchXmlFileValues(zip, entry.path, nextValues);
  }
}

function getEntryValues(
  entry: HwpxExportPlanEntry,
  regionValues: string[],
  paragraphTextById: Map<string, string>,
  offset: number
): string[] {
  if (entry.paragraphIds && entry.paragraphIds.length > 0) {
    return entry.paragraphIds.map((id) => paragraphTextById.get(id) ?? '');
  }

  return regionValues.slice(offset, offset + Math.max(0, entry.paragraphCount));
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

    let valueIndex = 0;
    for (const paragraph of paragraphs) {
      if (valueIndex >= values.length) break;

      // Skip originally-empty paragraphs (spacing/line-breaks in the XML).
      // They have no text content and no paragraph ID was assigned to them,
      // so consuming a value slot here would shift all subsequent mappings.
      const textNodes = collectTextLeafNodes(paragraph);
      const hasOriginalText = textNodes.some((n) => String(n['#text'] ?? '').trim());
      if (!hasOriginalText) continue;

      patchParagraphNodeText(paragraph, values[valueIndex]);
      valueIndex += 1;
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

      // Skip originally-empty paragraphs (same fix as patchXmlParagraphValues).
      const textNodes = collectTextLeafNodes(paragraph);
      const hasOriginalText = textNodes.some((n) => String(n['#text'] ?? '').trim());
      if (!hasOriginalText) continue;

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

  // Put the entire new text into the first text leaf node and clear the rest.
  // Proportional splitting by original run lengths causes garbled output when the
  // edited text differs significantly in length, so a single-run approach is safer.
  textNodes[0]['#text'] = normalizedText;
  for (let i = 1; i < textNodes.length; i += 1) {
    textNodes[i]['#text'] = '';
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

async function exportMinimalHwpx(
  html: string,
  rawOdtContentXml?: string,
  rawOdtStylesXml?: string,
): Promise<Blob> {
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

  // When ODT data is available (HWP origin with pyhwp bridge), use it for
  // structure-preserving export: ODT provides exact table geometry while
  // the edited HTML provides the user's updated text.
  const sectionXml = rawOdtContentXml
    ? odtToHwpxSection(rawOdtContentXml, rawOdtStylesXml ?? '', html)
    : htmlToHwpxSection(html);

  zip.file('Contents/sec0.xml', sectionXml);

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
  _sectionObjectIdCounter = 0; // reset per section
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

// ─── HWPX unit constants (1 HWPU = 1/100 mm) ─────────────────────────────────
// 1pt = 25.4/72 mm → ×100 = 35.28 HWPU
const PT_TO_HWPU = (25.4 / 72) * 100;
const DEFAULT_TABLE_WIDTH_HWPU = 14000; // ≈140mm — standard A4 content width
const DEFAULT_CELL_HEIGHT_HWPU = 850;   // ≈8.5mm row height
// Cell margin: use 1% of cell width (adaptive) with 141 HWPU floor.
// Fixed 510 HWPU (5.1mm) consumed 51% of a 2000 HWPU narrow cell, causing wrapping.
const CELL_MARGIN_TB_HWPU = 141;        // ≈1.4mm top/bottom cell padding

// Per-section object ID counter — reset at start of each section generation.
// Each inline object (table, image, etc.) must have a unique ID within the section.
let _sectionObjectIdCounter = 0;
function nextSectionObjectId(): number { return ++_sectionObjectIdCounter; }

function convertTable(table: HTMLElement): string {
  const rows = table.querySelectorAll('tr');
  if (rows.length === 0) return '';

  // ── Determine column widths ──────────────────────────────────────────────
  const colWidthsPt = parseTableColWidthsPt(table);

  // Count logical columns from the first row's cells + spans
  const firstRowCells = rows[0].querySelectorAll('td, th');
  const totalCols = Math.max(
    colWidthsPt?.length ?? 0,
    Array.from(firstRowCells).reduce(
      (sum, c) => sum + Math.max(1, parseInt(c.getAttribute('colspan') || '1', 10)),
      0,
    ),
    1,
  );

  // Total table width in HWPU
  const tableWidthHwpu = colWidthsPt
    ? Math.round(colWidthsPt.reduce((s, w) => s + w, 0) * PT_TO_HWPU)
    : DEFAULT_TABLE_WIDTH_HWPU;

  // Per-column widths in HWPU
  const colWidthsHwpu: number[] =
    colWidthsPt && colWidthsPt.length === totalCols
      ? colWidthsPt.map((w) => Math.max(500, Math.round(w * PT_TO_HWPU)))
      : Array.from({ length: totalCols }, () =>
          Math.max(500, Math.floor(tableWidthHwpu / totalCols)),
        );

  // ── Build rows/cells ─────────────────────────────────────────────────────
  const trXml: string[] = [];
  let rowAddr = 0;

  for (const tr of Array.from(rows)) {
    const cells = tr.querySelectorAll('td, th');
    const tcXml: string[] = [];
    let colAddr = 0;

    for (const cell of Array.from(cells)) {
      const colspan = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10));
      const rowspan = Math.max(1, parseInt(cell.getAttribute('rowspan') || '1', 10));

      // Cell width = sum of the spanned columns
      const cellWidthHwpu = colWidthsHwpu
        .slice(colAddr, colAddr + colspan)
        .reduce((s, w) => s + w, 0);

      // Adaptive left/right margin: 1% of cell width, but at least 141 HWPU (1.4mm).
      // Avoids consuming too much space in narrow cells.
      const cellMarginLR = Math.max(141, Math.floor(cellWidthHwpu * 0.01));
      const textWidthHwpu = Math.max(200, cellWidthHwpu - cellMarginLR * 2);
      const textHeightHwpu = Math.max(100, DEFAULT_CELL_HEIGHT_HWPU - CELL_MARGIN_TB_HWPU * 2);

      // Cell content paragraphs
      const cellParts: string[] = [];
      const blockEls = cell.querySelectorAll('p, h1, h2, h3, h4, h5, h6');
      if (blockEls.length > 0) {
        for (const block of Array.from(blockEls)) {
          cellParts.push(convertParagraph(block as HTMLElement, block.tagName.toLowerCase()));
        }
      } else {
        const runs = extractRuns(cell);
        cellParts.push(
          wrapParagraph(
            runs.length > 0
              ? runs
              : [{ text: cell.textContent || '', bold: false, italic: false, underline: false, strike: false, fontSize: 0 }],
          ),
        );
      }
      if (cellParts.length === 0) {
        cellParts.push('  <hp:p><hp:run><hp:t></hp:t></hp:run></hp:p>');
      }

      tcXml.push(
        [
          `    <hp:tc name="" header="false" hasMargin="false" protect="false" editable="true" lineWrap="true" borderFill="0">`,
          `      <hp:cellAddr colAddr="${colAddr}" rowAddr="${rowAddr}"/>`,
          `      <hp:cellSpan colSpan="${colspan}" rowSpan="${rowspan}"/>`,
          `      <hp:cellSz width="${cellWidthHwpu}" height="${DEFAULT_CELL_HEIGHT_HWPU}"/>`,
          `      <hp:cellMargin left="${cellMarginLR}" right="${cellMarginLR}" top="${CELL_MARGIN_TB_HWPU}" bottom="${CELL_MARGIN_TB_HWPU}"/>`,
          `      <hp:subList textDirection="LTRB" lineWrap="Break" vertAlign="Center" linkListIDRef="0" linkListNextIDRef="0" textWidth="${textWidthHwpu}" textHeight="${textHeightHwpu}">`,
          cellParts.join('\n'),
          `      </hp:subList>`,
          `    </hp:tc>`,
        ].join('\n'),
      );

      colAddr += colspan;
    }

    trXml.push(`  <hp:tr>\n${tcXml.join('\n')}\n  </hp:tr>`);
    rowAddr += 1;
  }

  const tableHeight = rows.length * DEFAULT_CELL_HEIGHT_HWPU;
  const tblId = nextSectionObjectId();

  return [
    // widthRelTo/horzRelTo/vertRelTo are required for HWP to treat the table as a
    // block-level element. Without them HWP floats the table and text flows beside it.
    `<hp:tbl style="0" id="${tblId}" zOrder="${tblId}" lock="false" instantiate="false" numberingType="None" textWrap="TopAndBottom" blockReverse="false" allowOverlap="false" holdAnchorAndSO="false" widthRelTo="Para" horzRelTo="Para" vertRelTo="Para">`,
    `  <hp:sz width="${tableWidthHwpu}" widthRelTo="Fixed" height="${tableHeight}" heightRelTo="Fixed" protect="false"/>`,
    // leftRelTo/topRelTo/vertAlign/horzAlign anchor the table to the paragraph flow.
    `  <hp:pos left="0" top="0" leftRelTo="Para" topRelTo="Para" vertAlign="Top" horzAlign="Left"/>`,
    `  <hp:outerMargin left="0" right="0" top="0" bottom="0"/>`,
    ...trXml,
    `</hp:tbl>`,
  ].join('\n');
}

/**
 * Extract per-column widths in pt from the table element.
 * Tries data-hwp-col-widths first (set by HWP legacy/ODT parser),
 * then falls back to <colgroup> col elements.
 */
function parseTableColWidthsPt(table: HTMLElement): number[] | null {
  const raw = table.getAttribute('data-hwp-col-widths');
  if (raw) {
    const widths = raw
      .split(',')
      .map((w) => parseFloat(w.trim()))
      .filter((w) => Number.isFinite(w) && w > 0);
    if (widths.length > 0) return widths;
  }

  const cols = table.querySelectorAll('colgroup col');
  if (cols.length > 0) {
    const widths: number[] = [];
    for (const col of Array.from(cols)) {
      const style = col.getAttribute('style') || '';
      const m = style.match(/width:\s*([\d.]+)pt/);
      if (m) widths.push(parseFloat(m[1]));
    }
    if (widths.length === cols.length && widths.every((w) => w > 0)) return widths;
  }

  return null;
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

// ──────────────────────────────────────────────────────────────────────────────
// ODT XML → HWPX section XML
//
// Converts pyhwp bridge output (ODT content.xml + styles.xml) directly to a
// HWPX section XML. Uses ODT for structural data (table column widths, cell
// spans) which are lost when going through HTML. User's edited text from the
// TipTap HTML is injected in document order, replacing ODT's original text.
//
// Why: HTML → HWPX is lossy. ODT has exact cell widths, border info, span
// coordinates. Going ODT → HWPX directly preserves all structural fidelity.
// ──────────────────────────────────────────────────────────────────────────────

interface OdtExportStyles {
  // text style name → formatting flags
  textStyles: Map<string, { bold?: boolean; italic?: boolean; underline?: boolean; fontSize?: number }>;
  // table-column style name → width in pt
  colStyles: Map<string, number>;
}

function collectOdtExportStyles(contentDoc: Document, stylesDoc: Document): OdtExportStyles {
  const textStyles = new Map<string, { bold?: boolean; italic?: boolean; underline?: boolean; fontSize?: number }>();
  const colStyles = new Map<string, number>();

  const sources = [
    contentDoc.getElementsByTagNameNS(ODT_NS.office, 'automatic-styles')[0],
    contentDoc.getElementsByTagNameNS(ODT_NS.office, 'styles')[0],
    stylesDoc.getElementsByTagNameNS(ODT_NS.office, 'automatic-styles')[0],
    stylesDoc.getElementsByTagNameNS(ODT_NS.office, 'styles')[0],
  ];

  for (const container of sources) {
    if (!container) continue;

    for (const styleEl of Array.from(container.getElementsByTagNameNS(ODT_NS.style, 'style'))) {
      const name = styleEl.getAttributeNS(ODT_NS.style, 'name') || '';
      const family = styleEl.getAttributeNS(ODT_NS.style, 'family') || '';
      if (!name) continue;

      if (family === 'text' && !textStyles.has(name)) {
        const props = styleEl.getElementsByTagNameNS(ODT_NS.style, 'text-properties')[0];
        if (!props) continue;
        const ts: { bold?: boolean; italic?: boolean; underline?: boolean; fontSize?: number } = {};
        if (props.getAttributeNS(ODT_NS.fo, 'font-weight') === 'bold') ts.bold = true;
        if (props.getAttributeNS(ODT_NS.fo, 'font-style') === 'italic') ts.italic = true;
        const ul = props.getAttributeNS(ODT_NS.style, 'text-underline-type') ||
                   props.getAttributeNS(ODT_NS.style, 'text-underline-style');
        if (ul && ul !== 'none') ts.underline = true;
        const fs = props.getAttributeNS(ODT_NS.fo, 'font-size');
        if (fs) {
          const m = fs.match(/^([\d.]+)pt$/);
          if (m) ts.fontSize = parseFloat(m[1]);
        }
        if (Object.keys(ts).length > 0) textStyles.set(name, ts);

      } else if (family === 'table-column' && !colStyles.has(name)) {
        const props = styleEl.getElementsByTagNameNS(ODT_NS.style, 'table-column-properties')[0];
        if (!props) continue;
        const w = props.getAttributeNS(ODT_NS.style, 'column-width');
        if (w) {
          const pt = odtLengthToPt(w);
          if (pt > 0) colStyles.set(name, pt);
        }
      }
    }
  }

  return { textStyles, colStyles };
}

function odtLengthToPt(value: string): number {
  const num = parseFloat(value);
  if (isNaN(num)) return -1;
  if (value.endsWith('pt')) return num;
  if (value.endsWith('mm')) return num * 2.83465;
  if (value.endsWith('cm')) return num * 28.3465;
  if (value.endsWith('in')) return num * 72;
  return -1;
}

/**
 * Convert ODT XML (from pyhwp bridge) to a HWPX section XML string.
 *
 * @param contentXml  ODT content.xml string
 * @param stylesXml   ODT styles.xml string
 * @param editedHtml  TipTap innerHTML — provides user-edited text in document order
 */
function odtToHwpxSection(contentXml: string, stylesXml: string, editedHtml: string): string {
  _sectionObjectIdCounter = 0; // reset per section
  const domParser = new DOMParser();
  const contentDoc = domParser.parseFromString(contentXml, 'application/xml');
  const stylesDoc = stylesXml
    ? domParser.parseFromString(stylesXml, 'application/xml')
    : contentDoc;

  const exportStyles = collectOdtExportStyles(contentDoc, stylesDoc);

  // Build an ordered queue of paragraph texts from the user's edited HTML.
  // extractParagraphGroupsFromHtml traverses in document order including cell
  // paragraphs, matching the same order as ODT's office:text traversal.
  const textQueue = extractParagraphGroupsFromHtml(editedHtml).body;
  const cursor = { index: 0 };

  const officeText = contentDoc.getElementsByTagNameNS(ODT_NS.office, 'text')[0];
  if (!officeText) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"
        xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"
        xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">
  <hp:p><hp:run><hp:t></hp:t></hp:run></hp:p>
</hs:sec>`;
  }

  const parts: string[] = [];
  odtChildrenToHwpx(officeText, exportStyles, textQueue, cursor, parts);

  return `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"
        xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"
        xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">
${parts.join('\n')}
</hs:sec>`;
}

/** Recursively convert ODT child elements to HWPX XML strings. */
function odtChildrenToHwpx(
  parent: Element,
  styles: OdtExportStyles,
  textQueue: string[],
  cursor: { index: number },
  out: string[],
): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const ns = el.namespaceURI;
    const tag = el.localName;

    if (ns === ODT_NS.text && (tag === 'p' || tag === 'h')) {
      // Consume next text from the queue (user's edited version of this paragraph).
      // Use empty paragraph when queue is exhausted or text is empty.
      const text = cursor.index < textQueue.length ? textQueue[cursor.index++] : '';
      out.push(text.trim()
        ? wrapParagraph([{ text, bold: false, italic: false, underline: false, strike: false, fontSize: 0 }])
        : wrapParagraph([]),
      );
    } else if (ns === ODT_NS.table && tag === 'table') {
      out.push(odtTableNodeToHwpx(el, styles, textQueue, cursor));
    } else if (ns === ODT_NS.text && tag === 'soft-page-break') {
      // Skip soft page breaks — don't consume from queue
    } else {
      // Recurse for text:section, text:sequence-decls, office:forms, etc.
      odtChildrenToHwpx(el, styles, textQueue, cursor, out);
    }
  }
}

/** Convert an ODT table element to a HWPX hp:tbl XML string. */
function odtTableNodeToHwpx(
  tableEl: Element,
  styles: OdtExportStyles,
  textQueue: string[],
  cursor: { index: number },
): string {
  // ── Collect column widths from ODT table-column declarations ───────────────
  const colWidthsPt: number[] = [];
  const rows: Element[] = [];

  for (const child of Array.from(tableEl.childNodes)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    if (el.namespaceURI !== ODT_NS.table) continue;

    if (el.localName === 'table-column') {
      const repeat = Math.max(1, parseInt(el.getAttributeNS(ODT_NS.table, 'number-columns-repeated') || '1', 10));
      const styleName = el.getAttributeNS(ODT_NS.table, 'style-name') || '';
      const widthPt = styles.colStyles.get(styleName) ?? -1;
      for (let i = 0; i < repeat; i++) colWidthsPt.push(widthPt);

    } else if (el.localName === 'table-row') {
      rows.push(el);

    } else if (['table-row-group', 'table-header-rows', 'table-rows', 'table-footer-rows'].includes(el.localName)) {
      for (const rowChild of Array.from(el.childNodes)) {
        if (rowChild.nodeType === Node.ELEMENT_NODE) {
          const rowEl = rowChild as Element;
          if (rowEl.namespaceURI === ODT_NS.table && rowEl.localName === 'table-row') {
            rows.push(rowEl);
          }
        }
      }
    }
  }

  if (rows.length === 0) return '';

  // ── Compute HWPU column widths ─────────────────────────────────────────────
  const totalCols = colWidthsPt.length || 1;
  const hasActualWidths = colWidthsPt.length > 0 && colWidthsPt.every(w => w > 0);

  const tableWidthHwpu = hasActualWidths
    ? Math.round(colWidthsPt.reduce((s, w) => s + w, 0) * PT_TO_HWPU)
    : DEFAULT_TABLE_WIDTH_HWPU;

  const colWidthsHwpu: number[] = hasActualWidths
    ? colWidthsPt.map(w => Math.max(500, Math.round(w * PT_TO_HWPU)))
    : Array.from({ length: totalCols }, () => Math.max(500, Math.floor(tableWidthHwpu / totalCols)));

  // ── Build rows ─────────────────────────────────────────────────────────────
  const trXml: string[] = [];
  let rowAddr = 0;

  for (const row of rows) {
    const tcXml: string[] = [];
    let colAddr = 0;

    for (const child of Array.from(row.childNodes)) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const cell = child as Element;
      if (cell.namespaceURI !== ODT_NS.table) continue;

      // covered-table-cell = occupied by a spanning cell — skip but track colAddr
      if (cell.localName === 'covered-table-cell') {
        const repeat = Math.max(1, parseInt(cell.getAttributeNS(ODT_NS.table, 'number-columns-repeated') || '1', 10));
        colAddr += repeat;
        continue;
      }
      if (cell.localName !== 'table-cell') continue;

      const colspan = Math.max(1, parseInt(cell.getAttributeNS(ODT_NS.table, 'number-columns-spanned') || '1', 10));
      const rowspan = Math.max(1, parseInt(cell.getAttributeNS(ODT_NS.table, 'number-rows-spanned') || '1', 10));
      // number-columns-repeated: emit N identical cells (rare in HWP tables)
      const colRepeat = Math.max(1, parseInt(cell.getAttributeNS(ODT_NS.table, 'number-columns-repeated') || '1', 10));

      for (let r = 0; r < colRepeat; r++) {
        const effectiveColAddr = colAddr + r * colspan;
        const cellWidthHwpu = Math.max(500,
          colWidthsHwpu.slice(effectiveColAddr, effectiveColAddr + colspan).reduce((s, w) => s + w, 0),
        );

        const cellMarginLR = Math.max(141, Math.floor(cellWidthHwpu * 0.01));
        const textWidthHwpu = Math.max(200, cellWidthHwpu - cellMarginLR * 2);
        const textHeightHwpu = Math.max(100, DEFAULT_CELL_HEIGHT_HWPU - CELL_MARGIN_TB_HWPU * 2);

        // Build cell paragraphs: each text:p in the cell consumes one slot from the queue
        const cellParts: string[] = [];
        for (const cellChild of Array.from(cell.childNodes)) {
          if (cellChild.nodeType !== Node.ELEMENT_NODE) continue;
          const cellChildEl = cellChild as Element;
          if (cellChildEl.namespaceURI === ODT_NS.text &&
              (cellChildEl.localName === 'p' || cellChildEl.localName === 'h')) {
            const text = cursor.index < textQueue.length ? textQueue[cursor.index++] : '';
            cellParts.push(text.trim()
              ? wrapParagraph([{ text, bold: false, italic: false, underline: false, strike: false, fontSize: 0 }])
              : wrapParagraph([]),
            );
          }
        }
        if (cellParts.length === 0) {
          cellParts.push('  <hp:p><hp:run><hp:t></hp:t></hp:run></hp:p>');
        }

        tcXml.push([
          `    <hp:tc name="" header="false" hasMargin="false" protect="false" editable="true" lineWrap="true" borderFill="0">`,
          `      <hp:cellAddr colAddr="${effectiveColAddr}" rowAddr="${rowAddr}"/>`,
          `      <hp:cellSpan colSpan="${colspan}" rowSpan="${rowspan}"/>`,
          `      <hp:cellSz width="${cellWidthHwpu}" height="${DEFAULT_CELL_HEIGHT_HWPU}"/>`,
          `      <hp:cellMargin left="${cellMarginLR}" right="${cellMarginLR}" top="${CELL_MARGIN_TB_HWPU}" bottom="${CELL_MARGIN_TB_HWPU}"/>`,
          `      <hp:subList textDirection="LTRB" lineWrap="Break" vertAlign="Center" linkListIDRef="0" linkListNextIDRef="0" textWidth="${textWidthHwpu}" textHeight="${textHeightHwpu}">`,
          cellParts.join('\n'),
          `      </hp:subList>`,
          `    </hp:tc>`,
        ].join('\n'));
      }

      colAddr += colspan * colRepeat;
    }

    if (tcXml.length > 0) {
      trXml.push(`  <hp:tr>\n${tcXml.join('\n')}\n  </hp:tr>`);
    }
    rowAddr += 1;
  }

  if (trXml.length === 0) return '';

  const tableHeight = rows.length * DEFAULT_CELL_HEIGHT_HWPU;
  const tblId = nextSectionObjectId();

  return [
    `<hp:tbl style="0" id="${tblId}" zOrder="${tblId}" lock="false" instantiate="false" numberingType="None" textWrap="TopAndBottom" blockReverse="false" allowOverlap="false" holdAnchorAndSO="false" widthRelTo="Para" horzRelTo="Para" vertRelTo="Para">`,
    `  <hp:sz width="${tableWidthHwpu}" widthRelTo="Fixed" height="${tableHeight}" heightRelTo="Fixed" protect="false"/>`,
    `  <hp:pos left="0" top="0" leftRelTo="Para" topRelTo="Para" vertAlign="Top" horzAlign="Left"/>`,
    `  <hp:outerMargin left="0" right="0" top="0" bottom="0"/>`,
    ...trXml,
    `</hp:tbl>`,
  ].join('\n');
}
