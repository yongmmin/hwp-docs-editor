import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type {
  DocumentMetadata,
  HwpxExportMeta,
  PageLayout,
  ParsedDocument,
} from '../../types';

const metadataParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

const orderedXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  preserveOrder: true,
});

type OrderedNode = Record<string, unknown>;
type OrderedNodes = OrderedNode[];

interface InlineStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  fontSize: number | null;
}

interface HwpxParseContext {
  imageSources: Map<string, string>;
}

interface ParagraphRenderState {
  path: string;
  paragraphIds: string[];
  paragraphTexts: string[];
  nextParagraphIndex: number;
}

interface ParsedXmlContent {
  html: string;
  paragraphCount: number;
  paragraphIds: string[];
}

interface ExtractedContent {
  html: string;
  exportMeta: HwpxExportMeta;
}

const EMPTY_STYLE: InlineStyle = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  fontSize: null,
};

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'];

export async function parseHwpx(buffer: ArrayBuffer): Promise<ParsedDocument> {
  const zip = await JSZip.loadAsync(buffer);
  const [metadata, imageSources] = await Promise.all([
    extractMetadata(zip),
    buildImageSourceMap(zip),
  ]);
  const { html, exportMeta } = await extractContent(zip, { imageSources });
  const pageLayout = await extractPageLayout(zip, exportMeta.sectionPaths);

  return {
    title: metadata.title || '제목 없음',
    html: html || '<p>문서 내용을 읽을 수 없습니다.</p>',
    metadata,
    originalFormat: 'hwpx',
    rawZipData: buffer,
    hwpxExportMeta: exportMeta,
    pageLayout,
  };
}

/**
 * Extract `<hp:pagePr>` + `<hp:margin>` from the first section XML and
 * convert HWPUNIT (1/7200 inch) values to pt (1/72 inch ⇒ divide by 100).
 */
async function extractPageLayout(zip: JSZip, sectionPaths: string[]): Promise<PageLayout | undefined> {
  for (const path of sectionPaths) {
    if (!/sec\d+\.xml$|section\d+\.xml$/i.test(path)) continue;
    const file = zip.file(path);
    if (!file) continue;

    try {
      const xml = await file.async('string');
      const layout = parsePagePrFromXml(xml);
      if (layout) return layout;
    } catch {
      // fall through to next section
    }
  }
  return undefined;
}

function parsePagePrFromXml(xml: string): PageLayout | undefined {
  // Tolerant regex-based extraction — we don't need the full DOM for a handful
  // of attributes on two elements.
  const pageMatch = xml.match(/<[^<>]*pagePr\b[^<>]*>/i);
  if (!pageMatch) return undefined;

  const pageWidth = pickNumericAttr(pageMatch[0], 'width');
  const pageHeight = pickNumericAttr(pageMatch[0], 'height');
  if (!pageWidth || !pageHeight) return undefined;

  const marginMatch = xml.match(/<[^<>]*margin\b[^<>]*\/?>/i);
  const marginAttrs = marginMatch ? marginMatch[0] : '';

  const layout: PageLayout = {
    widthPt: hwpUnitToPt(pageWidth),
    heightPt: hwpUnitToPt(pageHeight),
    paddingLeftPt: hwpUnitToPt(pickNumericAttr(marginAttrs, 'left') ?? 0),
    paddingRightPt: hwpUnitToPt(pickNumericAttr(marginAttrs, 'right') ?? 0),
    paddingTopPt: hwpUnitToPt(pickNumericAttr(marginAttrs, 'top') ?? 0),
    paddingBottomPt: hwpUnitToPt(pickNumericAttr(marginAttrs, 'bottom') ?? 0),
    headerPaddingPt: hwpUnitToPt(pickNumericAttr(marginAttrs, 'header') ?? 0),
    footerPaddingPt: hwpUnitToPt(pickNumericAttr(marginAttrs, 'footer') ?? 0),
  };

  if (!layout.widthPt || !layout.heightPt) return undefined;
  return layout;
}

function pickNumericAttr(source: string, name: string): number | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = source.match(re);
  if (!match) return undefined;
  const n = parseFloat(match[1]);
  return Number.isFinite(n) ? n : undefined;
}

function hwpUnitToPt(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const pt = value / 100;
  if (pt > 3000) return undefined;
  return Number(pt.toFixed(2));
}

async function extractMetadata(zip: JSZip): Promise<DocumentMetadata> {
  const metaFile = zip.file('META-INF/container.xml') || zip.file('meta.xml');
  if (!metaFile) return {};

  try {
    const xml = await metaFile.async('string');
    const parsed = metadataParser.parse(xml);
    return {
      title: findValue(parsed, 'dc:title') || findValue(parsed, 'title'),
      author: findValue(parsed, 'dc:creator') || findValue(parsed, 'creator'),
      date: findValue(parsed, 'dc:date') || findValue(parsed, 'date'),
      description: findValue(parsed, 'dc:description') || findValue(parsed, 'description'),
    };
  } catch {
    return {};
  }
}

async function extractContent(zip: JSZip, ctx: HwpxParseContext): Promise<ExtractedContent> {
  const manifestXmlRefs = await collectManifestXmlRefs(zip);
  const sectionPaths = mergeOrderedPaths(
    manifestXmlRefs.filter(isSectionXmlPath),
    collectZipPaths(
      zip,
      /Contents\/sec\d+\.xml$/i,
      /Contents\/section\d+\.xml$/i
    )
  );
  const headerPaths = mergeOrderedPaths(
    manifestXmlRefs.filter((path) => /(?:^|\/)[^/]*header[^/]*\.xml$/i.test(path)),
    collectZipPaths(zip, /Contents\/[^/]*header[^/]*\.xml$/i)
  );
  const footerPaths = mergeOrderedPaths(
    manifestXmlRefs.filter((path) => /(?:^|\/)[^/]*footer[^/]*\.xml$/i.test(path)),
    collectZipPaths(zip, /Contents\/[^/]*footer[^/]*\.xml$/i)
  );
  const fallbackContentXmls = manifestXmlRefs.filter(isFallbackBodyXmlPath);

  const fallbackSectionPaths = collectZipPaths(
    zip,
    /Contents\/sec\d+\.xml$/i,
    /Contents\/section\d+\.xml$/i
  );

  const htmlParts: string[] = [];
  const metaPaths: string[] = [];
  const metaParagraphs: HwpxExportMeta['paragraphs'] = [];

  const collectMeta = (
    path: string,
    region: 'body' | 'header' | 'footer',
    paragraphIds: string[]
  ) => {
    if (!metaPaths.includes(path)) metaPaths.push(path);
    paragraphIds.forEach((id, orderInSection) => {
      metaParagraphs.push({ id, sectionPath: path, region, orderInSection });
    });
  };

  for (let i = 0; i < headerPaths.length; i++) {
    const result = await parseRegionFile(zip, headerPaths[i], 'header', i + 1, ctx);
    if (result.html) htmlParts.push(result.html);
    collectMeta(headerPaths[i], 'header', result.paragraphIds);
  }

  if (sectionPaths.length > 0) {
    for (const path of sectionPaths) {
      const result = await parseXmlFile(zip, path, ctx);
      if (result.html) htmlParts.push(result.html);
      collectMeta(path, 'body', result.paragraphIds);
    }
  } else if (fallbackSectionPaths.length > 0) {
    for (const path of fallbackSectionPaths) {
      const result = await parseXmlFile(zip, path, ctx);
      if (result.html) htmlParts.push(result.html);
      collectMeta(path, 'body', result.paragraphIds);
    }
  } else if (fallbackContentXmls.length > 0) {
    for (const path of fallbackContentXmls) {
      const result = await parseXmlFile(zip, path, ctx);
      if (result.html) htmlParts.push(result.html);
      collectMeta(path, 'body', result.paragraphIds);
    }
  } else {
    const contentXml = zip.file('Contents/content.xml');
    if (contentXml) {
      const xml = await contentXml.async('string');
      const fallback = parseXmlContent(xml, ctx, 'Contents/content.xml');
      if (fallback.html) htmlParts.push(fallback.html);
      collectMeta('Contents/content.xml', 'body', fallback.paragraphIds);
    }
  }

  for (let i = 0; i < footerPaths.length; i++) {
    const result = await parseRegionFile(zip, footerPaths[i], 'footer', i + 1, ctx);
    if (result.html) htmlParts.push(result.html);
    collectMeta(footerPaths[i], 'footer', result.paragraphIds);
  }

  return {
    html: htmlParts.join(''),
    exportMeta: { sectionPaths: metaPaths, paragraphs: metaParagraphs },
  };
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

async function parseXmlFile(
  zip: JSZip,
  path: string,
  ctx: HwpxParseContext
) : Promise<ParsedXmlContent> {
  const file = zip.file(path);
  if (!file) {
    return { html: '', paragraphCount: 0, paragraphIds: [] };
  }

  const xml = await file.async('string');
  return parseXmlContent(xml, ctx, path);
}

async function parseRegionFile(
  zip: JSZip,
  path: string,
  kind: 'header' | 'footer',
  index: number,
  ctx: HwpxParseContext
): Promise<ParsedXmlContent> {
  const file = zip.file(path);
  if (!file) {
    return { html: '', paragraphCount: 0, paragraphIds: [] };
  }

  const xml = await file.async('string');
  const content = parseXmlContent(xml, ctx, path);
  if (!content.html) return content;

  const title = `${kind === 'header' ? '머리글' : '바닥글'} ${index}`;
  return {
    html: wrapRegion(kind, title, content.html),
    paragraphCount: content.paragraphCount,
    paragraphIds: content.paragraphIds,
  };
}

function parseXmlContent(xml: string, ctx: HwpxParseContext, path: string): ParsedXmlContent {
  try {
    const parsed = orderedXmlParser.parse(xml) as OrderedNodes;
    const renderState: ParagraphRenderState = {
      path,
      paragraphIds: [],
      paragraphTexts: [],
      nextParagraphIndex: 0,
    };
    const html = renderBlocks(parsed, ctx, renderState).join('');
    const paragraphCount = renderState.paragraphIds.length;

    if (html) {
      return { html, paragraphCount, paragraphIds: renderState.paragraphIds };
    }

    const fallbackHtml = extractTextFromXml(xml);
    return {
      html: fallbackHtml,
      paragraphCount: fallbackHtml ? 1 : paragraphCount,
      paragraphIds: renderState.paragraphIds,
    };
  } catch {
    const fallbackHtml = extractTextFromXml(xml);
    return {
      html: fallbackHtml,
      paragraphCount: fallbackHtml ? 1 : 0,
      paragraphIds: [],
    };
  }
}

async function buildImageSourceMap(zip: JSZip): Promise<Map<string, string>> {
  const imageSources = new Map<string, string>();
  const pathToDataUrl = new Map<string, string>();
  const imageFiles: Array<{ path: string; ext: string; file: JSZip.JSZipObject }> = [];

  zip.forEach((path, file) => {
    const normalizedPath = normalizeZipPath(path);
    const ext = normalizedPath.split('.').pop()?.toLowerCase();

    if (ext && IMAGE_EXTENSIONS.includes(ext) && normalizedPath.includes('bindata/')) {
      imageFiles.push({ path: normalizedPath, ext, file });
    }
  });

  for (const { path, ext, file } of imageFiles) {
    const bytes = await file.async('uint8array');
    if (bytes.length === 0 || bytes.length > 5_000_000) continue;

    const dataUrl = bytesToDataUrl(bytes, ext);
    if (!dataUrl) continue;

    pathToDataUrl.set(path, dataUrl);
    registerImagePathAliases(imageSources, path, dataUrl);
  }

  const manifest = zip.file('Contents/content.hpf');
  if (!manifest) return imageSources;

  try {
    const manifestXml = await manifest.async('string');
    const refs = parseManifestImageRefs(manifestXml);
    for (const { id, href } of refs) {
      const src = resolveImageSourceFromValue(href, imageSources, pathToDataUrl);
      if (src) {
        registerImagePathAliases(imageSources, id, src);
        registerImagePathAliases(imageSources, href, src);
      }
    }
  } catch {
    // Ignore manifest issues and rely on direct BinData aliases.
  }

  return imageSources;
}

function bytesToDataUrl(bytes: Uint8Array, ext: string): string | null {
  const mimeTypes: Record<string, string> = {
    bmp: 'image/bmp',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    webp: 'image/webp',
  };

  const mimeType = mimeTypes[ext];
  if (!mimeType) return null;

  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return `data:${mimeType};base64,${btoa(binary)}`;
}

function parseManifestImageRefs(xml: string): Array<{ id: string; href: string }> {
  const refs = new Map<string, string>();
  const patterns = [
    /\b(?:id|xml:id)=["']([^"']+)["'][^>]*\b(?:href|full-path|target|src)=["']([^"']+)["']/gi,
    /\b(?:href|full-path|target|src)=["']([^"']+)["'][^>]*\b(?:id|xml:id)=["']([^"']+)["']/gi,
  ];

  for (const pattern of patterns) {
    for (const match of xml.matchAll(pattern)) {
      const id = pattern === patterns[0] ? match[1] : match[2];
      const href = pattern === patterns[0] ? match[2] : match[1];

      if (!id || !href) continue;
      const normalizedHref = normalizeZipPath(href);
      if (!normalizedHref.includes('bindata/') && !IMAGE_EXTENSIONS.some((ext) => normalizedHref.endsWith(`.${ext}`))) {
        continue;
      }

      refs.set(id, href);
    }
  }

  return Array.from(refs.entries()).map(([id, href]) => ({ id, href }));
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

function renderBlocks(
  nodes: OrderedNodes,
  ctx: HwpxParseContext,
  renderState: ParagraphRenderState
): string[] {
  const html: string[] = [];

  for (const node of nodes) {
    const name = getNodeName(node);
    if (!name) continue;

    if (name === '#text') {
      const text = normalizeWhitespace(String(node['#text'] || ''));
      if (text.trim()) html.push(`<p>${escapeHtml(text)}</p>`);
      continue;
    }

    if (isParagraphTag(name)) {
      html.push(...renderParagraph(node, ctx, renderState));
      continue;
    }

    if (isTableTag(name)) {
      const table = renderTable(node, ctx, renderState);
      if (table) html.push(table);
      continue;
    }

    if (name === 'header' || name === 'footer') {
      const content = renderBlocks(getNodeChildren(node), ctx, renderState).join('');
      if (content) {
        html.push(wrapRegion(name, name === 'header' ? '머리글' : '바닥글', content));
      }
      continue;
    }

    if (isImageNode(node, ctx)) {
      html.push(renderImage(node, ctx));
      continue;
    }

    html.push(...renderBlocks(getNodeChildren(node), ctx, renderState));
  }

  return html;
}

function renderParagraph(
  node: OrderedNode,
  ctx: HwpxParseContext,
  renderState: ParagraphRenderState
): string[] {
  const paragraphContent = renderInlineNodes(getNodeChildren(node), ctx, EMPTY_STYLE);
  const images = collectEmbeddedImages(getNodeChildren(node), ctx);
  const html: string[] = [];
  const plainText = stripHtml(paragraphContent).replace(/\u00A0/g, ' ').trim();
  const align = extractParagraphAlign(node);
  const style = align && align !== 'left' ? ` style="text-align:${align}"` : '';

  if (plainText) {
    const paraId = buildParagraphId(renderState.path, renderState.nextParagraphIndex);
    renderState.nextParagraphIndex += 1;
    renderState.paragraphIds.push(paraId);
    renderState.paragraphTexts.push(plainText);
    html.push(`<p data-hwp-para-id="${escapeHtml(paraId)}"${style}>${paragraphContent}</p>`);
  }

  html.push(...images);
  return html;
}

function renderInlineNodes(
  nodes: OrderedNodes,
  ctx: HwpxParseContext,
  inheritedStyle: InlineStyle
): string {
  const parts: string[] = [];

  for (const node of nodes) {
    const name = getNodeName(node);
    if (!name) continue;

    if (name === '#text') {
      const text = normalizeInlineText(String(node['#text'] || ''));
      if (text) parts.push(applyInlineStyle(escapeHtml(text), inheritedStyle));
      continue;
    }

    if (name === 'tab') {
      parts.push('&emsp;');
      continue;
    }

    if (name === 'linebreak' || name === 'br') {
      parts.push('<br>');
      continue;
    }

    if (isTableTag(name) || name === 'header' || name === 'footer' || isImageNode(node, ctx)) {
      continue;
    }

    if (name === 'run' || name === 'r') {
      const runStyle = mergeInlineStyles(inheritedStyle, extractInlineStyle(node));
      parts.push(renderInlineNodes(getNodeChildren(node), ctx, runStyle));
      continue;
    }

    if (isStyleOnlyNode(name)) {
      continue;
    }

    parts.push(renderInlineNodes(getNodeChildren(node), ctx, inheritedStyle));
  }

  return parts.join('');
}

function renderTable(node: OrderedNode, ctx: HwpxParseContext, renderState: ParagraphRenderState): string {
  const rows = collectDirectDescendants(node, (name) => name === 'tr', true);
  if (rows.length === 0) return '';

  const body = rows
    .map((row) => renderTableRow(row, ctx, renderState))
    .filter(Boolean)
    .join('');

  if (!body) return '';
  return `<table style="width:100%;table-layout:fixed"><tbody>${body}</tbody></table>`;
}

function renderTableRow(row: OrderedNode, ctx: HwpxParseContext, renderState: ParagraphRenderState): string {
  const cells = collectDirectDescendants(
    row,
    (name) => name === 'tc' || name === 'td' || name === 'th',
    true
  );

  const html = cells
    .map((cell) => renderTableCell(cell, ctx, renderState))
    .filter(Boolean)
    .join('');

  return html ? `<tr>${html}</tr>` : '';
}

function renderTableCell(
  cell: OrderedNode,
  ctx: HwpxParseContext,
  renderState: ParagraphRenderState
): string {
  const name = getNodeName(cell);
  if (!name) return '';

  const attrs = getNodeAttributes(cell);
  const colspan = getNumericAttribute(attrs, 'colspan', 'colSpan');
  const rowspan = getNumericAttribute(attrs, 'rowspan', 'rowSpan');
  const content = renderBlocks(getNodeChildren(cell), ctx, renderState).join('') || '<p>&nbsp;</p>';
  const tag = name === 'th' ? 'th' : 'td';

  const htmlAttrs = [
    colspan > 1 ? `colspan="${colspan}"` : '',
    rowspan > 1 ? `rowspan="${rowspan}"` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return `<${tag}${htmlAttrs ? ` ${htmlAttrs}` : ''}>${content}</${tag}>`;
}

function renderImage(node: OrderedNode, ctx: HwpxParseContext): string {
  const src = resolveImageSource(node, ctx);
  if (!src) {
    return '<p>[이미지를 불러오지 못했습니다]</p>';
  }

  const alt = stripHtml(renderInlineNodes(getNodeChildren(node), ctx, EMPTY_STYLE)).trim();
  const altAttr = alt ? ` alt="${escapeHtml(alt)}"` : '';
  return `<img src="${escapeHtml(src)}"${altAttr}>`;
}

function collectEmbeddedImages(nodes: OrderedNodes, ctx: HwpxParseContext): string[] {
  const html: string[] = [];

  for (const node of nodes) {
    const name = getNodeName(node);
    if (!name) continue;

    if (isImageNode(node, ctx)) {
      html.push(renderImage(node, ctx));
      continue;
    }

    if (isParagraphTag(name) || isTableTag(name) || name === 'header' || name === 'footer') {
      continue;
    }

    html.push(...collectEmbeddedImages(getNodeChildren(node), ctx));
  }

  return html;
}

function resolveImageSource(node: OrderedNode, ctx: HwpxParseContext): string | null {
  const candidates = collectImageCandidates(node);

  for (const candidate of candidates) {
    const src = resolveImageSourceFromValue(candidate, ctx.imageSources);
    if (src) return src;
  }

  return null;
}

function resolveImageSourceFromValue(
  value: string,
  imageSources: Map<string, string>,
  pathToDataUrl?: Map<string, string>
): string | null {
  if (!value) return null;

  const trimmed = value.trim();
  const normalizedPath = normalizeZipPath(trimmed);
  const normalizedKey = normalizeLookupKey(trimmed);
  const baseName = normalizeLookupKey(normalizedPath.split('/').pop() || '');
  const baseWithoutExt = normalizeLookupKey(baseName.replace(/\.[^.]+$/, ''));
  const numericId = baseWithoutExt.match(/(\d{1,8})$/)?.[1];
  const candidates = new Set([
    normalizedKey,
    normalizeLookupKey(normalizedPath),
    baseName,
    baseWithoutExt,
    normalizeLookupKey(trimmed.replace(/^#/, '')),
  ]);

  if (numericId) {
    candidates.add(normalizeLookupKey(numericId));
    candidates.add(normalizeLookupKey(String(parseInt(numericId, 10))));
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    const src = imageSources.get(candidate);
    if (src) return src;
  }

  if (pathToDataUrl) {
    return pathToDataUrl.get(normalizedPath) || null;
  }

  return null;
}

function collectImageCandidates(node: OrderedNode): string[] {
  const candidates = new Set<string>();

  walkNode(node, (entry) => {
    const attrs = getNodeAttributes(entry);
    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value !== 'string') continue;
      if (/(binaryitemidref|bindata|href|src|idref|refid|ref|id)$/i.test(key)) {
        candidates.add(value);
      }
    }
  });

  return Array.from(candidates);
}

function walkNode(node: OrderedNode, visit: (entry: OrderedNode) => void): void {
  visit(node);
  for (const child of getNodeChildren(node)) {
    walkNode(child, visit);
  }
}

function collectDirectDescendants(
  root: OrderedNode,
  predicate: (name: string) => boolean,
  isRoot = false
): OrderedNode[] {
  const matches: OrderedNode[] = [];

  for (const child of getNodeChildren(root)) {
    const name = getNodeName(child);
    if (!name || name === '#text') continue;

    if (!isRoot && isTableTag(name)) {
      continue;
    }

    if (predicate(name)) {
      matches.push(child);
      continue;
    }

    matches.push(...collectDirectDescendants(child, predicate, false));
  }

  return matches;
}

function extractInlineStyle(node: OrderedNode): Partial<InlineStyle> {
  const style: Partial<InlineStyle> = {};

  walkNode(node, (entry) => {
    const name = getNodeName(entry);
    if (!name || name === '#text') return;

    if (name === 'bold') style.bold = true;
    if (name === 'italic') style.italic = true;
    if (name === 'underline') style.underline = true;
    if (name === 'strikethrough' || name === 'strike' || name === 'strikeout') style.strike = true;

    if (name === 'sz' || name === 'fontsize') {
      const attrs = getNodeAttributes(entry);
      const raw = firstDefinedAttribute(attrs, 'val', 'value', 'size', 'pt');
      if (raw) {
        const numeric = parseFloat(raw);
        if (!Number.isNaN(numeric)) {
          style.fontSize = numeric > 100 ? numeric / 100 : numeric;
        }
      }
    }

    const attrs = getNodeAttributes(entry);
    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value !== 'string') continue;
      const normalized = value.toLowerCase();
      if (/bold/i.test(key) && isTruthyAttribute(normalized)) style.bold = true;
      if (/italic/i.test(key) && isTruthyAttribute(normalized)) style.italic = true;
      if (/underline/i.test(key) && isTruthyAttribute(normalized)) style.underline = true;
      if (/strike/i.test(key) && isTruthyAttribute(normalized)) style.strike = true;
      if (/font.?size|sz/i.test(key)) {
        const numeric = parseFloat(value);
        if (!Number.isNaN(numeric)) {
          style.fontSize = numeric > 100 ? numeric / 100 : numeric;
        }
      }
    }
  });

  return style;
}

function extractParagraphAlign(node: OrderedNode): string | null {
  let alignment: string | null = null;

  walkNode(node, (entry) => {
    if (alignment) return;

    const attrs = getNodeAttributes(entry);
    const raw = firstDefinedAttribute(attrs, 'horizontal', 'align', 'textAlign', 'text-align');
    if (!raw) return;

    const normalized = raw.toLowerCase();
    if (['left', 'right', 'center', 'justify'].includes(normalized)) {
      alignment = normalized;
    }
  });

  return alignment;
}

function mergeInlineStyles(
  inherited: InlineStyle,
  next: Partial<InlineStyle>
): InlineStyle {
  return {
    bold: next.bold ?? inherited.bold,
    italic: next.italic ?? inherited.italic,
    underline: next.underline ?? inherited.underline,
    strike: next.strike ?? inherited.strike,
    fontSize: next.fontSize ?? inherited.fontSize,
  };
}

function applyInlineStyle(text: string, style: InlineStyle): string {
  let html = text;
  if (!html) return html;

  if (style.bold) html = `<strong>${html}</strong>`;
  if (style.italic) html = `<em>${html}</em>`;
  if (style.underline) html = `<u>${html}</u>`;
  if (style.strike) html = `<s>${html}</s>`;
  if (style.fontSize && style.fontSize !== 10) {
    html = `<span style="font-size:${style.fontSize}pt">${html}</span>`;
  }

  return html;
}

function isParagraphTag(name: string): boolean {
  return name === 'p' || name === 'para';
}

function buildParagraphId(path: string, index: number): string {
  const base = path
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

  return `${base || 'paragraph'}_p${index}`;
}

function isSectionXmlPath(path: string): boolean {
  return /(?:^|\/)(sec\d+|section\d+)\.xml$/i.test(path);
}

function isFallbackBodyXmlPath(path: string): boolean {
  if (isSectionXmlPath(path)) return false;
  if (/(?:^|\/)[^/]*(header|footer)[^/]*\.xml$/i.test(path)) return false;
  if (/(?:^|\/)(content\.xml|settings\.xml|version\.xml|manifest\.xml)$/i.test(path)) return false;
  return /(?:^|\/)[^/]+\.xml$/i.test(path);
}

function isTableTag(name: string): boolean {
  return name === 'tbl' || name === 'table';
}

function isImageNode(node: OrderedNode, ctx: HwpxParseContext): boolean {
  const name = getNodeName(node);
  if (!name || name === '#text') return false;

  if (['img', 'pic', 'image', 'shape', 'drawingobject'].includes(name)) {
    return resolveImageSource(node, ctx) !== null;
  }

  const attrs = getNodeAttributes(node);
  const hasImageRef = Object.keys(attrs).some((key) =>
    /(binaryitemidref|bindata|href|src)/i.test(key)
  );

  return hasImageRef && resolveImageSource(node, ctx) !== null;
}

function isStyleOnlyNode(name: string): boolean {
  return [
    'rpr',
    'charpr',
    'parapr',
    'sz',
    'bold',
    'italic',
    'underline',
    'strikethrough',
    'strike',
    'strikeout',
    'align',
  ].includes(name);
}

function getNodeName(node: OrderedNode): string | null {
  for (const key of Object.keys(node)) {
    if (key === ':@') continue;
    return key === '#text' ? '#text' : getLocalName(key);
  }
  return null;
}

function getNodeChildren(node: OrderedNode): OrderedNodes {
  for (const [key, value] of Object.entries(node)) {
    if (key === ':@') continue;
    return Array.isArray(value) ? (value as OrderedNodes) : [];
  }
  return [];
}

function getNodeAttributes(node: OrderedNode): Record<string, string> {
  const attrs = node[':@'];
  if (!attrs || typeof attrs !== 'object') return {};
  return attrs as Record<string, string>;
}

function getLocalName(name: string): string {
  return name.split(':').pop()?.toLowerCase() || name.toLowerCase();
}

function getNumericAttribute(
  attrs: Record<string, string>,
  ...keys: string[]
): number {
  const raw = firstDefinedAttribute(attrs, ...keys);
  if (!raw) return 1;

  const numeric = parseInt(raw, 10);
  return Number.isNaN(numeric) || numeric < 1 ? 1 : numeric;
}

function firstDefinedAttribute(
  attrs: Record<string, string>,
  ...keys: string[]
): string | null {
  for (const [key, value] of Object.entries(attrs)) {
    const normalizedKey = key.replace(/^@_/, '').toLowerCase();
    if (keys.some((candidate) => normalizedKey === candidate.toLowerCase())) {
      return value;
    }
  }
  return null;
}

function registerImagePathAliases(
  imageSources: Map<string, string>,
  key: string,
  value: string
): void {
  const normalizedPath = normalizeZipPath(key);
  const baseName = normalizedPath.split('/').pop() || normalizedPath;
  const baseWithoutExt = baseName.replace(/\.[^.]+$/, '');

  addImageAlias(imageSources, normalizedPath, value);
  addImageAlias(imageSources, key, value);
  addImageAlias(imageSources, baseName, value);
  addImageAlias(imageSources, baseWithoutExt, value);

  const numericId = baseWithoutExt.match(/(\d{1,8})$/)?.[1];
  if (numericId) {
    addImageAlias(imageSources, numericId, value);
    addImageAlias(imageSources, String(parseInt(numericId, 10)), value);
  }
}

function addImageAlias(
  imageSources: Map<string, string>,
  key: string,
  value: string
): void {
  const normalized = normalizeLookupKey(key);
  if (!normalized || imageSources.has(normalized)) return;
  imageSources.set(normalized, value);
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

function normalizeLookupKey(value: string): string {
  return normalizeZipPath(value).toLowerCase();
}

function resolveRelativeZipPath(baseDir: string, ref: string): string {
  if (!ref) return '';

  const normalizedRef = ref.replace(/\\/g, '/');
  if (/^[A-Za-z]+:\//.test(normalizedRef)) return '';
  if (normalizedRef.startsWith('/')) return normalizeZipPath(normalizedRef.slice(1));
  if (!baseDir) return normalizeZipPath(normalizedRef);
  return normalizeZipPath(`${baseDir}/${normalizedRef}`);
}

function wrapRegion(kind: string, title: string, content: string): string {
  return `<section data-doc-region="${kind}" data-title="${escapeHtml(title)}"><div class="document-region-body">${content}</div></section>`;
}

function extractTextFromXml(xml: string): string {
  const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return `<p>${escapeHtml(text)}</p>`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeInlineText(text: string): string {
  return text.replace(/\r/g, '').replace(/\n/g, ' ');
}

function isTruthyAttribute(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function findValue(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;

  const record = obj as Record<string, unknown>;
  if (key in record) {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
  }

  for (const nested of Object.values(record)) {
    if (nested && typeof nested === 'object') {
      const result = findValue(nested, key);
      if (result) return result;
    }
  }

  return undefined;
}
