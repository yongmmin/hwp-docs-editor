import CFB from 'cfb';
import pako from 'pako';
import type { Hwp5ExportMeta, PageLayout, ParsedDocument } from '../../types';
import {
  collectParagraphBlocks,
  readRecordHeaders,
  TAG_PARA_HEADER,
} from '../export/hwp5Records';

// ─── HWP 태그 ID — shared with src/services/export/hwp5Records.ts ───
// TAG_PARA_HEADER is imported from hwp5Records; the rest remain local.
const TAG_CHAR_SHAPE = 21;
const TAG_BORDER_FILL = 20;
const TAG_FACE_NAME = 19;
const TAG_PARA_SHAPE = 25;
const TAG_PARA_TEXT = 67;
const TAG_PARA_CHAR_SHAPE = 68;
const TAG_CTRL_HEADER = 71;
const TAG_LIST_HEADER = 72;
const TAG_PAGE_DEF = 73;
const TAG_TABLE = 77;
const TAG_SHAPE_COMPONENT = 76;
const TAG_BIN_DATA = 18;
const TAG_SHAPE_PICTURE = 85;

const TAB_CHAR = 0x09;
const UTF16LE_DECODER = new TextDecoder('utf-16le');

interface ExtractedText {
  text: string;
  logicalToDisplayPos: (logicalPos: number) => number;
}

interface CharShapeDef {
  ptSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  fontFamily?: string;
  faceIds?: number[];
  textColor?: string;
  shadeColor?: string;
}

interface ParaShapeDef {
  align: number;
  lineHeight?: number;
  marginLeftPx?: number;
  marginRightPx?: number;
  indentPx?: number;
  paddingLeftPx?: number;
  marginTopPx?: number;
  marginBottomPx?: number;
  marginLeftHwp?: number;
  marginRightHwp?: number;
}

interface BorderLineDef {
  type: number;
  width: number;
  color?: string;
}

interface BorderFillDef {
  attribute?: number;
  backgroundColor?: string;
  style: {
    left: BorderLineDef;
    right: BorderLineDef;
    top: BorderLineDef;
    bottom: BorderLineDef;
  };
}

interface Rec {
  tagId: number;
  level: number;
  data: Uint8Array;
  offset: number;
  size: number;
}

interface Ctx {
  charShapes: CharShapeDef[];
  paraShapes: ParaShapeDef[];
  borderFills: BorderFillDef[];
  images: Map<number, string>; // binDataId → data URL
}

// ──────────────────────────────────────────────
// 공개 API
// ──────────────────────────────────────────────

export async function parseHwpLegacy(buffer: ArrayBuffer): Promise<ParsedDocument> {
  try {
    const cfb = CFB.read(new Uint8Array(buffer), { type: 'array' });
    const compressed = isCompressed(cfb);

    const docInfo = parseDocInfo(cfb, compressed);
    const ctx: Ctx = {
      charShapes: docInfo.charShapes,
      paraShapes: docInfo.paraShapes,
      borderFills: docInfo.borderFills,
      images: extractImages(cfb, compressed, docInfo.binDataEntries),
    };

    const rendered = renderAllSections(cfb, compressed, ctx);
    const html = rendered.html;
    const metadata = extractMetadata(cfb);

    return {
      title: metadata.title || '한글 문서',
      html: html || '<p>문서 내용을 추출할 수 없습니다.</p>',
      pageLayout: rendered.pageLayout,
      metadata,
      originalFormat: 'hwp',
      hwp5ExportMeta: rendered.exportMeta,
    };
  } catch (e) {
    console.error('HWP 파싱 오류:', e);
    return {
      title: '한글 문서',
      html: '<p>HWP 파일을 읽는 중 오류가 발생했습니다. HWPX로 저장 후 다시 시도해주세요.</p>',
      metadata: {},
      originalFormat: 'hwp',
    };
  }
}

// ──────────────────────────────────────────────
// 유틸리티
// ──────────────────────────────────────────────

function isCompressed(cfb: CFB.CFB$Container): boolean {
  const fh = CFB.find(cfb, '/FileHeader');
  if (!fh?.content || fh.content.length < 37) return true;
  return (fh.content[36] & 0x01) !== 0;
}

function decompress(raw: Uint8Array): Uint8Array {
  try { return pako.inflateRaw(raw); } catch { /* */ }
  try { return pako.inflate(raw); } catch { /* */ }
  return raw;
}

function getStream(cfb: CFB.CFB$Container, path: string, comp: boolean): Uint8Array | null {
  const e = CFB.find(cfb, path);
  if (!e?.content) return null;
  const raw = e.content instanceof Uint8Array ? e.content : new Uint8Array(e.content);
  return comp ? decompress(raw) : raw;
}

function readRecords(data: Uint8Array): Rec[] {
  const recs: Rec[] = [];
  let off = 0;
  while (off < data.length - 3) {
    const h = data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24);
    off += 4;
    const tagId = h & 0x3FF;
    const level = (h >>> 10) & 0x3FF;
    let size = (h >>> 20) & 0xFFF;
    if (size === 0xFFF) {
      if (off + 4 > data.length) break;
      size = data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24);
      off += 4;
    }
    if (off + size > data.length) break;
    recs.push({ tagId, level, data, offset: off, size });
    off += size;
  }
  return recs;
}

function u16(d: Uint8Array, o: number) { return d[o] | (d[o + 1] << 8); }
function u32(d: Uint8Array, o: number) { return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0; }
function i16(d: Uint8Array, o: number) {
  const v = u16(d, o);
  return v > 0x7fff ? v - 0x10000 : v;
}
function i32(d: Uint8Array, o: number) {
  const v = u32(d, o);
  return v > 0x7fffffff ? v - 0x100000000 : v;
}

function escapeHtml(t: string) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeHtmlWithBreaks(t: string) {
  return escapeHtml(t)
    .replace(/\t/g, '&emsp;')
    .replace(/\n/g, '<br/>');
}

function decodeUtf16Le(data: Uint8Array): string {
  try {
    return UTF16LE_DECODER.decode(data);
  } catch {
    let out = '';
    for (let i = 0; i + 1 < data.length; i += 2) {
      out += String.fromCharCode(data[i] | (data[i + 1] << 8));
    }
    return out;
  }
}

function sanitizeFontName(value: string): string {
  return value.replace(/\u0000/g, '').trim();
}

function isPlausibleFontName(value: string): boolean {
  if (!value) return false;
  if (value.length > 80) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (/\uFFFD/.test(value)) return false;
  return /[A-Za-z0-9\u00C0-\u024F\u0400-\u04FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/.test(value);
}

function parseFaceNameRecord(rec: Rec): string | undefined {
  const d = rec.data;
  const recordEnd = rec.offset + rec.size;
  let best = '';

  for (let rel = 0; rel + 2 < rec.size; rel++) {
    const length = u16(d, rec.offset + rel);
    if (!Number.isFinite(length) || length <= 0) continue;

    const start = rec.offset + rel + 2;
    const end = start + length * 2;
    if (end !== recordEnd) continue;

    const name = sanitizeFontName(decodeUtf16Le(d.subarray(start, end)));
    if (isPlausibleFontName(name) && name.length > best.length) {
      best = name;
    }
  }

  if (best) return best;

  for (let start = rec.offset; start + 4 <= recordEnd; start++) {
    const byteLength = recordEnd - start;
    if (byteLength % 2 !== 0) continue;

    const name = sanitizeFontName(decodeUtf16Le(d.subarray(start, recordEnd)));
    if (isPlausibleFontName(name) && name.length > best.length) {
      best = name;
    }
  }

  return best || undefined;
}

function quoteFontFamily(name: string): string {
  return `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function buildFontFamily(faceIds: number[] | undefined, faceNames: string[]): string | undefined {
  if (!faceIds || faceIds.length === 0 || faceNames.length === 0) return undefined;

  const names: string[] = [];
  const seen = new Set<string>();

  for (const rawId of faceIds) {
    const resolved = sanitizeFontName(faceNames[rawId] || faceNames[rawId - 1] || '');
    if (!isPlausibleFontName(resolved) || seen.has(resolved)) continue;
    seen.add(resolved);
    names.push(resolved);
  }

  if (names.length === 0) return undefined;

  const generic = names.some((name) => /gothic|gulim|dotum|sans|고딕|돋움/i.test(name))
    ? 'sans-serif'
    : 'serif';

  return [...names.map(quoteFontFamily), generic].join(',');
}

function getCtrlId(rec: Rec): string {
  if (rec.size < 4) return '';
  const d = rec.data, o = rec.offset;
  return String.fromCharCode(d[o + 3], d[o + 2], d[o + 1], d[o]);
}

/** 주어진 인덱스부터, level > baseLevel인 레코드들의 끝 인덱스(exclusive) 반환 */
function findChildrenEnd(recs: Rec[], start: number, baseLevel: number): number {
  let i = start;
  while (i < recs.length && recs[i].level > baseLevel) i++;
  return i;
}

// ──────────────────────────────────────────────
// DocInfo 파싱
// ──────────────────────────────────────────────

interface BinDataEntry {
  binDataId: number;
  ext: string;
}

function parseDocInfo(cfb: CFB.CFB$Container, comp: boolean) {
  const faceNames: string[] = [];
  const charShapes: CharShapeDef[] = [];
  const paraShapes: ParaShapeDef[] = [];
  const borderFills: BorderFillDef[] = [];
  const binDataEntries: BinDataEntry[] = []; // 0-based array, GSO refs are 1-based index
  const data = getStream(cfb, '/DocInfo', comp);
  if (!data) return { charShapes, paraShapes, borderFills, binDataEntries };
  for (const rec of readRecords(data)) {
    const d = rec.data, o = rec.offset;
    if (rec.tagId === TAG_FACE_NAME) {
      faceNames.push(parseFaceNameRecord(rec) || '');
    }
    if (rec.tagId === TAG_CHAR_SHAPE && rec.size >= 50) {
      const height = u32(d, o + 42);
      const props = u32(d, o + 46);
      const textColorRef = rec.size >= 62 ? u32(d, o + 58) : 0;
      const shadeColorRef = rec.size >= 66 ? u32(d, o + 62) : 0;
      const faceIds = rec.size >= 14
        ? Array.from({ length: 7 }, (_, idx) => u16(d, o + idx * 2))
        : [];
      charShapes.push({
        ptSize: height / 100,
        bold: (props & 1) !== 0,
        italic: (props & 2) !== 0,
        underline: ((props >>> 2) & 7) > 0,
        strikethrough: ((props >>> 6) & 7) > 0,
        faceIds,
        textColor: parseHwpColorRef(textColorRef),
        shadeColor: parseHwpColorRef(shadeColorRef),
      });
    }
    if (rec.tagId === TAG_PARA_SHAPE && rec.size >= 4) {
      const lineHeightRaw = rec.size >= 28 ? u32(d, o + 24) : 0;
      const doubledMarginLeftRaw = rec.size >= 8 ? i32(d, o + 4) : undefined;
      const doubledMarginRightRaw = rec.size >= 12 ? i32(d, o + 8) : undefined;
      const marginLeftPx = doubledMarginLeftRaw !== undefined ? parseParaMetricToPx(doubledMarginLeftRaw / 2) : undefined;
      const marginRightPx = doubledMarginRightRaw !== undefined ? parseParaMetricToPx(doubledMarginRightRaw / 2) : undefined;
      const indentRaw = rec.size >= 16 ? i32(d, o + 12) : undefined;
      const indentPx = indentRaw !== undefined ? parseParaMetricToPx(indentRaw / 2) : undefined;
      const doubledMarginTopRaw = rec.size >= 20 ? i32(d, o + 16) : undefined;
      const doubledMarginBottomRaw = rec.size >= 24 ? i32(d, o + 20) : undefined;
      const marginTopPx = doubledMarginTopRaw !== undefined ? parseParaMetricToPx(doubledMarginTopRaw / 2) : undefined;
      const marginBottomPx = doubledMarginBottomRaw !== undefined ? parseParaMetricToPx(doubledMarginBottomRaw / 2) : undefined;
      const attribute = u32(d, o);
      paraShapes.push({
        align: (attribute >>> 2) & 0x7,
        lineHeight: parseLineHeightRatio(lineHeightRaw),
        marginLeftPx,
        marginRightPx,
        indentPx,
        paddingLeftPx: indentPx !== undefined && indentPx < 0 ? Math.abs(indentPx) : undefined,
        marginTopPx,
        marginBottomPx,
        marginLeftHwp: doubledMarginLeftRaw !== undefined ? doubledMarginLeftRaw / 2 : undefined,
        marginRightHwp: doubledMarginRightRaw !== undefined ? doubledMarginRightRaw / 2 : undefined,
      });
    }
    if (rec.tagId === TAG_BORDER_FILL) {
      let cursor = o;
      const attribute = rec.size >= 2 ? u16(d, cursor) : 0;
      cursor += 2;

      const readBorderLine = (): BorderLineDef => {
        if (cursor + 6 > o + rec.size) return { type: 0, width: 0 };
        const type = d[cursor];
        const width = d[cursor + 1];
        const color = parseHwpRgbColorRef(u32(d, cursor + 2));
        cursor += 6;
        return { type, width, color };
      };

      const style = {
        left: readBorderLine(),
        right: readBorderLine(),
        top: readBorderLine(),
        bottom: readBorderLine(),
      };

      if (cursor + 6 <= o + rec.size) cursor += 6;

      let backgroundColor: string | undefined;
      if (cursor + 4 <= o + rec.size) {
        const fillType = u32(d, cursor);
        cursor += 4;
        if (fillType === 0x00000001 && cursor + 4 <= o + rec.size) {
          backgroundColor = parseHwpRgbColorRef(u32(d, cursor));
        }
      }

      borderFills.push({ attribute, style, backgroundColor });
    }
    if (rec.tagId === TAG_BIN_DATA && rec.size >= 6) {
      const binDataId = u16(d, o + 2);
      const extLen = u16(d, o + 4);
      let ext = '';
      for (let k = 0; k < extLen && o + 6 + k * 2 + 1 < d.length; k++) {
        ext += String.fromCharCode(u16(d, o + 6 + k * 2));
      }
      binDataEntries.push({ binDataId, ext: ext.toLowerCase() });
    }
  }
  const resolvedCharShapes = charShapes.map((shape) => ({
    ...shape,
    fontFamily: buildFontFamily(shape.faceIds, faceNames),
  }));

  return { charShapes: resolvedCharShapes, paraShapes, borderFills, binDataEntries };
}

// ──────────────────────────────────────────────
// 이미지 추출
// ──────────────────────────────────────────────

/** BIN_DATA 1-based index → data URL 매핑 (DocInfo BIN_DATA 레코드 기반) */
function extractImages(
  cfb: CFB.CFB$Container,
  comp: boolean,
  binDataEntries: BinDataEntry[]
): Map<number, string> {
  const images = new Map<number, string>();
  const mimeMap: Record<string, string> = {
    bmp: 'image/bmp', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', gif: 'image/gif',
    tif: 'image/tiff', tiff: 'image/tiff',
  };

  binDataEntries.forEach((entry) => {
    if (!mimeMap[entry.ext]) return; // wmf/emf/tiff 스킵

    const hex = entry.binDataId.toString(16).toUpperCase().padStart(4, '0');
    const fileName = `BIN${hex}.${entry.ext}`;
    const cfbEntry = CFB.find(cfb, '/' + fileName) || CFB.find(cfb, fileName);
    if (!cfbEntry?.content) return;

    const raw = cfbEntry.content instanceof Uint8Array
      ? cfbEntry.content
      : new Uint8Array(cfbEntry.content);
    const imgData = comp ? decompress(raw) : raw;
    if (imgData.length < 100) return;

    try {
      // 대용량 이미지는 Blob URL 대신 base64 (브라우저 호환)
      // very large binary images can blow up parsing time/memory in browser
      if (imgData.length > 12_000_000) return;
      let binary = '';
      for (let i = 0; i < imgData.length; i++) binary += String.fromCharCode(imgData[i]);
      images.set(entry.binDataId, `data:${mimeMap[entry.ext]};base64,${btoa(binary)}`);
    } catch { /* skip */ }
  });

  return images;
}

// ──────────────────────────────────────────────
// Section 렌더링 — 핵심 로직
// ──────────────────────────────────────────────

function renderAllSections(
  cfb: CFB.CFB$Container,
  comp: boolean,
  ctx: Ctx
): { html: string; pageLayout?: PageLayout; exportMeta: Hwp5ExportMeta } {
  const parts: string[] = [];
  let pageLayout: PageLayout | undefined;
  const exportSections: Hwp5ExportMeta['sections'] = [];
  for (let s = 0; s < 256; s++) {
    const data = getStream(cfb, `/BodyText/Section${s}`, comp);
    if (!data) break;
    const recs = readRecords(data);
    const sectionPageLayout = extractSectionPageLayout(recs);
    if (!pageLayout) pageLayout = sectionPageLayout;
    // 섹션 간 페이지 분리 삽입 (첫 섹션 제외)
    if (parts.length > 0) parts.push('<hr class="hwp-page-break" />');
    parts.push(renderSection(recs, ctx, sectionPageLayout ?? pageLayout));

    // Collect per-section paragraph byte ranges for in-place export.
    // We re-walk the stream via the shared record header scanner so the
    // offsets come from the exact same bytes the writer will patch later.
    const headers = readRecordHeaders(data);
    const blocks = collectParagraphBlocks(headers, data.length);
    exportSections.push({
      streamPath: `/BodyText/Section${s}`,
      paragraphs: blocks.map((b) => ({
        startOffset: b.startOffset,
        endOffset: b.endOffset,
        hasControls: b.hasControls,
        origText: extractBlockOrigText(data, headers, b),
      })),
    });
  }
  return {
    html: parts.join(''),
    pageLayout,
    exportMeta: { sections: exportSections },
  };
}

/**
 * Decode the plaintext contained in a paragraph block by concatenating every
 * level-1 PARA_TEXT record inside [block.startOffset, block.endOffset).
 *
 * Used by the HWP5 export writer for text-based matching between TipTap
 * paragraphs and the original HWP5 structure when paragraph counts disagree
 * (which is the norm when the edit HTML came from the pyhwp ODT bridge).
 */
function extractBlockOrigText(
  data: Uint8Array,
  headers: ReturnType<typeof readRecordHeaders>,
  block: { startOffset: number; endOffset: number },
): string {
  let out = '';
  for (const rec of headers) {
    if (rec.headerOffset < block.startOffset) continue;
    if (rec.headerOffset >= block.endOffset) break;
    if (rec.tagId !== TAG_PARA_TEXT || rec.level !== 1) continue;
    const bytes = data.subarray(rec.dataOffset, rec.dataOffset + rec.size);
    out += decodeHwpParaText(bytes);
  }
  // HWP5 paragraphs typically end with a trailing newline; strip for matching.
  return out.endsWith('\n') ? out.slice(0, -1) : out;
}

/**
 * Decode a PARA_TEXT payload (UTF-16LE) while skipping the inline control
 * markers HWP5 embeds (codes < 0x20 except TAB/LF/CR). Returns plain text
 * suitable for comparison with editor-produced paragraph text.
 */
function decodeHwpParaText(bytes: Uint8Array): string {
  // Filter out control codes so comparison is stable.
  const chars: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    chars.push(code);
  }
  try {
    const buf = new Uint8Array(chars.length * 2);
    for (let i = 0; i < chars.length; i += 1) {
      buf[i * 2] = chars[i] & 0xff;
      buf[i * 2 + 1] = (chars[i] >>> 8) & 0xff;
    }
    return UTF16LE_DECODER.decode(buf);
  } catch {
    return String.fromCharCode(...chars);
  }
}


function renderSection(recs: Rec[], ctx: Ctx, pageLayout?: PageLayout): string {
  const out: string[] = [];
  let i = 0;
  while (i < recs.length) {
    if (recs[i].tagId === TAG_PARA_HEADER && recs[i].level === 0) {
      i = renderTopParagraph(recs, i, ctx, out, pageLayout);
    } else {
      i++;
    }
  }
  return out.join('\n');
}

/**
 * 최상위(Level 0) PARA_HEADER 처리.
 * 이 문단이 table/image 컨트롤을 포함하면 그에 맞게 렌더링.
 */
function renderTopParagraph(recs: Rec[], idx: number, ctx: Ctx, out: string[], pageLayout?: PageLayout): number {
  const hdr = recs[idx];
  const paraShapeId = u16(hdr.data, hdr.offset + 8);
  const childEnd = findNextSameLevel(recs, idx + 1, 0);

  // 자식 레코드 스캔 — 테이블/이미지를 모두 수집 (하나의 문단에 여러 개 가능)
  const paraTextRecs: Rec[] = [];
  const paraCharShapeRecs: Rec[] = [];
  let extracted: ExtractedText = createEmptyExtractedText();
  let charRuns: { pos: number; csId: number }[] = [];
  const tblCtrlIndices: number[] = [];
  const gsoCtrlIndices: number[] = [];
  const otherCtrlIds = new Set<string>();
  let pageBreakDetected = false;

  for (let j = idx + 1; j < childEnd; j++) {
    const r = recs[j];
    if (r.tagId === TAG_PARA_TEXT && r.level === 1) paraTextRecs.push(r);
    if (r.tagId === TAG_PARA_CHAR_SHAPE && r.level === 1) paraCharShapeRecs.push(r);
    if (r.tagId === TAG_CTRL_HEADER && r.level === 1) {
      const cid = getCtrlId(r);
      if (cid === 'tbl ') tblCtrlIndices.push(j);
      else if (cid === 'gso ') gsoCtrlIndices.push(j);
      else {
        otherCtrlIds.add(cid);
        if (cid === 'pghd' || cid === 'nwno') pageBreakDetected = true;
      }
    }
  }

  extracted = extractTextFromRecords(paraTextRecs);
  charRuns = parseMergedCharRuns(paraCharShapeRecs);

  // 테이블 (여러 개 가능) — 테이블과 동일 문단의 텍스트도 보존
  if (tblCtrlIndices.length > 0) {
    const inlineTblIndices: number[] = [];
    const blockTblIndices: number[] = [];
    for (const ti of tblCtrlIndices) {
      if (parseTableLayoutFromCtrlHeader(recs[ti]).inline) inlineTblIndices.push(ti);
      else blockTblIndices.push(ti);
    }

    if (inlineTblIndices.length > 0) {
      out.push(renderInlineTableParagraph(recs, inlineTblIndices, extracted, charRuns, ctx, paraShapeId));
    } else if (extracted.text.trim()) {
      out.push(renderParaHtml(extracted.text, charRuns, ctx, paraShapeId, extracted.logicalToDisplayPos));
    }
    for (const ti of blockTblIndices) {
      out.push(renderTable(recs, ti, ctx, { paraShapeId, pageLayout }));
    }
    appendPageBreaks(out, pageBreakDetected ? 1 : 0);
    return childEnd;
  }

  // 이미지 (GSO)
  if (gsoCtrlIndices.length > 0) {
    if (extracted.text.trim()) {
      out.push(renderParaHtml(extracted.text, charRuns, ctx, paraShapeId, extracted.logicalToDisplayPos));
    }
    for (const gi of gsoCtrlIndices) {
      out.push(renderGso(recs, gi, ctx, { inTableCell: false }));
    }
    appendPageBreaks(out, pageBreakDetected ? 1 : 0);
    return childEnd;
  }

  // section/column definition paragraphs — 제어 노이즈는 스킵하되 가시 텍스트는 보존
  if (otherCtrlIds.has('secd') || otherCtrlIds.has('cold')) {
    if (extracted.text.trim()) {
      out.push(renderParaHtml(extracted.text, charRuns, ctx, paraShapeId, extracted.logicalToDisplayPos));
    }
    appendPageBreaks(out, pageBreakDetected ? 1 : 0);
    return childEnd;
  }

  // 일반 문단: 빈 문단도 레이아웃 유지 목적으로 보존
  out.push(renderParaHtml(extracted.text, charRuns, ctx, paraShapeId, extracted.logicalToDisplayPos));

  appendPageBreaks(out, pageBreakDetected ? 1 : 0);

  return childEnd;
}

function appendPageBreaks(out: string[], count: number) {
  for (let i = 0; i < count; i++) {
    if (out.length > 0 && out[out.length - 1] === '<hr class="hwp-page-break" />') continue;
    out.push('<hr class="hwp-page-break" />');
  }
}

/** 같은 레벨의 다음 PARA_HEADER를 찾거나, 끝 반환 */
function findNextSameLevel(recs: Rec[], from: number, level: number): number {
  for (let i = from; i < recs.length; i++) {
    if (recs[i].tagId === TAG_PARA_HEADER && recs[i].level <= level) return i;
  }
  return recs.length;
}

// ──────────────────────────────────────────────
// 테이블 렌더링
// ──────────────────────────────────────────────

interface CellInfo {
  row: number;
  col: number;
  colSpan: number;
  rowSpan: number;
  width: number;
  height: number;
  html: string;
  paddingLeftPx?: number;
  paddingRightPx?: number;
  paddingTopPx?: number;
  paddingBottomPx?: number;
  borderFill?: BorderFillDef;
}

interface GsoLayout {
  widthPx?: number;
  heightPx?: number;
  offsetXPx?: number;
  offsetYPx?: number;
  ctrlOffsetXPx?: number;
  ctrlOffsetYPx?: number;
  hRelTo?: number;
  vRelTo?: number;
  textFlowMethod?: number;
}

interface TableLayout {
  inline?: boolean;
  offsetXHwp?: number;
  offsetYHwp?: number;
  marginLeftHwp?: number;
  marginRightHwp?: number;
  marginTopHwp?: number;
  marginBottomHwp?: number;
  hRelTo?: number;
  vRelTo?: number;
  hAlign?: number;
  vAlign?: number;
  textFlowMethod?: number;
}

interface TableModel {
  nRows: number;
  nCols: number;
  tableWidthPt?: number;
  tableHeightPt?: number;
  tableBorderFill?: BorderFillDef;
  tableLayout?: TableLayout;
  cells: CellInfo[];
}

function renderTable(
  recs: Rec[],
  ctrlIdx: number,
  ctx: Ctx,
  opts?: { inTableCell?: boolean; paraShapeId?: number; pageLayout?: PageLayout }
): string {
  const model = buildTableModel(recs, ctrlIdx, ctx);
  const { nRows, nCols, tableWidthPt, tableBorderFill, tableLayout } = model;
  const normalizedCells = model.cells;

  // HTML 테이블 빌드 — 셀 merge 고려
  const occupied: boolean[][] = [];
  for (let r = 0; r < nRows; r++) occupied.push(new Array(nCols).fill(false));

  const cellsByRow = new Map<number, CellInfo[]>();
  for (const cell of normalizedCells) {
    if (!cellsByRow.has(cell.row)) cellsByRow.set(cell.row, []);
    cellsByRow.get(cell.row)!.push(cell);
  }

  // A4 기준 콘텐츠 폭 (210mm - 여백 25mm×2 = 160mm ≈ 454pt)
  const A4_CONTENT_PT = 454;
  const paraShape = opts?.paraShapeId !== undefined ? ctx.paraShapes[opts.paraShapeId] : undefined;
  const pageContentWidthPt = resolvePageContentWidthPt(opts?.pageLayout) ?? A4_CONTENT_PT;
  const colWidthsPt = resolveColumnWidthsPt(normalizedCells, nCols, tableWidthPt);
  const rowHeightsPt = estimateRowHeightsPt(normalizedCells, nRows);
  const rawTotalW = colWidthsPt.reduce((s, w) => s + w, 0);
  let renderedTableWidthPt = resolveRequestedTableWidthPt(tableWidthPt, rawTotalW, pageContentWidthPt);
  let marginLeftPt = !opts?.inTableCell && !tableLayout?.inline
    ? resolveTableMarginLeftPt(tableLayout, renderedTableWidthPt, paraShape, opts?.pageLayout)
    : undefined;
  const maxRenderableWidthPt = !opts?.inTableCell
    ? resolveMaxRenderableTableWidthPt(pageContentWidthPt, marginLeftPt)
    : undefined;
  if (maxRenderableWidthPt !== undefined && renderedTableWidthPt > maxRenderableWidthPt + 0.05) {
    renderedTableWidthPt = maxRenderableWidthPt;
    marginLeftPt = !opts?.inTableCell && !tableLayout?.inline
      ? resolveTableMarginLeftPt(tableLayout, renderedTableWidthPt, paraShape, opts?.pageLayout)
      : undefined;
  }
  const renderedColWidthsPt = scaleTrackSizesToFit(colWidthsPt, renderedTableWidthPt);
  const totalW = renderedColWidthsPt.reduce((s, w) => s + w, 0);

  const tableStyles: string[] = [];
  tableStyles.push(`width:${renderedTableWidthPt.toFixed(2)}pt`);
  tableStyles.push('max-width:100%');
  tableStyles.push('border-collapse:collapse');
  tableStyles.push('border-spacing:0');
  if (totalW > 0) tableStyles.push('table-layout:fixed');
  if (marginLeftPt !== undefined && Math.abs(marginLeftPt) > 0.01) {
    tableStyles.push(`margin-left:${marginLeftPt}pt`);
  }
  const tableAttrs: string[] = [`cellspacing="0"`, `style="${tableStyles.join(';')}"`];
  if (totalW > 0) {
    tableAttrs.push(`data-hwp-col-widths="${renderedColWidthsPt.map((w) => w.toFixed(2)).join(',')}"`);
  }
  let html = `<table ${tableAttrs.join(' ')}>`;
  if (totalW > 0) {
    html += '<colgroup>';
    for (const w of renderedColWidthsPt) {
      html += `<col style="width:${w.toFixed(2)}pt">`;
    }
    html += '</colgroup>';
  }

  for (let r = 0; r < nRows; r++) {
    const rowHeightPt = rowHeightsPt[r];
    html += '<tr>';
    const rowCells = cellsByRow.get(r) || [];
    rowCells.sort((a, b) => a.col - b.col);
    let c = 0;

    for (const cell of rowCells) {
      while (c < nCols && c < cell.col) {
        if (!occupied[r][c]) {
          const fillerWidthPt = renderedColWidthsPt[c];
          const fillerStyles: string[] = [];
          if (Number.isFinite(fillerWidthPt) && fillerWidthPt > 0) fillerStyles.push(`width:${fillerWidthPt.toFixed(2)}pt`);
          if (Number.isFinite(rowHeightPt) && rowHeightPt > 0) fillerStyles.push(`height:${rowHeightPt.toFixed(2)}pt`);
          html += fillerStyles.length > 0
            ? `<td style="${fillerStyles.join(';')}">&nbsp;</td>`
            : '<td>&nbsp;</td>';
        }
        c++;
      }

      if (cell.col >= nCols) continue;
      if (occupied[r][cell.col]) continue;

      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          const rr = r + dr;
          const cc = cell.col + dc;
          if (rr < nRows && cc < nCols) occupied[rr][cc] = true;
        }
      }

      const attrs: string[] = [];
      if (cell.colSpan > 1) attrs.push(`colspan="${cell.colSpan}"`);
      if (cell.rowSpan > 1) attrs.push(`rowspan="${cell.rowSpan}"`);
      const tdStyles: string[] = [];
      if (cell.paddingLeftPx !== undefined) tdStyles.push(`padding-left:${cell.paddingLeftPx}px`);
      if (cell.paddingRightPx !== undefined) tdStyles.push(`padding-right:${cell.paddingRightPx}px`);
      if (cell.paddingTopPx !== undefined) tdStyles.push(`padding-top:${cell.paddingTopPx}px`);
      if (cell.paddingBottomPx !== undefined) tdStyles.push(`padding-bottom:${cell.paddingBottomPx}px`);
      let widthPt = 0;
      for (let cc = cell.col; cc < Math.min(nCols, cell.col + cell.colSpan); cc++) {
        widthPt += renderedColWidthsPt[cc] ?? 0;
      }
      if (widthPt > 0) tdStyles.push(`width:${widthPt.toFixed(2)}pt`);
      const cellHeightPt = hwpPt100ToPt(cell.height);
      if (cellHeightPt !== undefined) {
        tdStyles.push(`height:${cellHeightPt}pt`);
        tdStyles.push(`min-height:${cellHeightPt}pt`);
      }
      applyBorderFillCss(tdStyles, cell.borderFill ?? tableBorderFill);
      if (tdStyles.length) attrs.push(`style="${tdStyles.join(';')}"`);
      html += `<td${attrs.length ? ' ' + attrs.join(' ') : ''}>${cell.html || '&nbsp;'}</td>`;
      c = Math.max(c, cell.col + cell.colSpan);
    }

    while (c < nCols) {
      if (!occupied[r][c]) {
        const fillerWidthPt = renderedColWidthsPt[c];
        const fillerStyles: string[] = [];
        if (Number.isFinite(fillerWidthPt) && fillerWidthPt > 0) fillerStyles.push(`width:${fillerWidthPt.toFixed(2)}pt`);
        if (Number.isFinite(rowHeightPt) && rowHeightPt > 0) fillerStyles.push(`height:${rowHeightPt.toFixed(2)}pt`);
        html += fillerStyles.length > 0
          ? `<td style="${fillerStyles.join(';')}">&nbsp;</td>`
          : '<td>&nbsp;</td>';
      }
      c++;
    }

    html += '</tr>';
  }
  html += '</table>';
  return html;
}

function buildTableModel(recs: Rec[], ctrlIdx: number, ctx: Ctx): TableModel {
  const ctrlLevel = recs[ctrlIdx].level;
  const childStart = ctrlIdx + 1;
  const childEnd = findChildrenEnd(recs, childStart, ctrlLevel);
  const { widthPt: tableWidthPt, heightPt: tableHeightPt } = parseTableDimensionsFromCtrlHeader(recs[ctrlIdx]);
  const tableLayout = parseTableLayoutFromCtrlHeader(recs[ctrlIdx]);

  // TABLE 태그에서 rows/cols 가져오기
  let nRows = 0, nCols = 0;
  let tableBorderFill: BorderFillDef | undefined;
  for (let i = childStart; i < childEnd; i++) {
    if (recs[i].tagId === TAG_TABLE && recs[i].size >= 8) {
      const d = recs[i].data, o = recs[i].offset;
      nRows = u16(d, o + 4);
      nCols = u16(d, o + 6);
      const tableBorderFillId = parseTableBorderFillId(recs[i], nRows);
      tableBorderFill = resolveBorderFill(ctx.borderFills, tableBorderFillId);
      break;
    }
  }

  // LIST_HEADER(셀) 수집 — merge 정보 포함
  const listHdrPositions: number[] = [];
  for (let i = childStart; i < childEnd; i++) {
    if (recs[i].tagId === TAG_LIST_HEADER && recs[i].level === ctrlLevel + 1) {
      listHdrPositions.push(i);
    }
  }

  // 각 셀의 위치/크기/내용 추출
  const cells: CellInfo[] = [];
  for (let k = 0; k < listHdrPositions.length; k++) {
    const lhIdx = listHdrPositions[k];
    const lh = recs[lhIdx];
    const cellStart = lhIdx + 1;
    const cellEnd = k + 1 < listHdrPositions.length ? listHdrPositions[k + 1] : childEnd;

    // LIST_HEADER에서 셀 위치 정보 읽기 (offset 8~)
    let col = 0, row = 0, colSpan = 1, rowSpan = 1, width = 0, height = 0;
    let paddingLeftPx: number | undefined;
    let paddingRightPx: number | undefined;
    let paddingTopPx: number | undefined;
    let paddingBottomPx: number | undefined;
    let borderFill: BorderFillDef | undefined;
    if (lh.size >= 16) {
      col = u16(lh.data, lh.offset + 8);
      row = u16(lh.data, lh.offset + 10);
      colSpan = u16(lh.data, lh.offset + 12);
      rowSpan = u16(lh.data, lh.offset + 14);
    }
    if (lh.size >= 20) {
      width = u32(lh.data, lh.offset + 16);
    }
    if (lh.size >= 24) {
      height = u32(lh.data, lh.offset + 20);
    }
    if (lh.size >= 32) {
      paddingLeftPx = hwpLengthToPx(u16(lh.data, lh.offset + 24));
      paddingRightPx = hwpLengthToPx(u16(lh.data, lh.offset + 26));
      paddingTopPx = hwpLengthToPx(u16(lh.data, lh.offset + 28));
      paddingBottomPx = hwpLengthToPx(u16(lh.data, lh.offset + 30));
    }
    if (lh.size >= 34) {
      const borderFillId = u16(lh.data, lh.offset + 32);
      borderFill = resolveBorderFill(ctx.borderFills, borderFillId);
    }

    cells.push({
      row, col, colSpan, rowSpan, width, height,
      html: renderCellContent(recs, cellStart, cellEnd, ctx),
      paddingLeftPx,
      paddingRightPx,
      paddingTopPx,
      paddingBottomPx,
      borderFill,
    });
  }

  // fallback sizing from cell coordinates when table header is missing/invalid
  const inferredCols = inferTrackCount(
    cells,
    (cell) => cell.col,
    (cell) => cell.colSpan,
    nCols > 0 && nCols <= 200 ? nCols : undefined,
    64
  );
  const inferredRows = inferTrackCount(
    cells,
    (cell) => cell.row,
    (cell) => cell.rowSpan,
    nRows > 0 && nRows <= 2000 ? nRows : undefined,
    512
  );
  if (nCols <= 0 || nCols > 200) nCols = inferredCols || 1;
  if (nRows <= 0 || nRows > 2000) nRows = inferredRows || Math.max(1, cells.length);
  if (inferredCols > 0 && inferredCols <= 200) nCols = inferredCols;
  if (inferredRows > 0 && inferredRows <= 2000) nRows = inferredRows;
  nCols = Math.max(1, Math.min(nCols, 200));
  nRows = Math.max(1, Math.min(nRows, 2000));

  const normalizedCells = normalizeCellInfos(cells, nRows, nCols);
  return {
    nRows,
    nCols,
    tableWidthPt,
    tableHeightPt,
    tableBorderFill,
    tableLayout,
    cells: normalizedCells,
  };
}

/** LIST_HEADER 내부의 문단들을 HTML로 렌더링 */
function renderCellContent(recs: Rec[], start: number, end: number, ctx: Ctx): string {
  const parts: string[] = [];
  let i = start;

  while (i < end) {
    if (recs[i].tagId === TAG_PARA_HEADER) {
      const paraLevel = recs[i].level;
      const paraShapeId = u16(recs[i].data, recs[i].offset + 8);
      const paraEnd = findNextSameLevel(recs, i + 1, paraLevel);
      const clampedEnd = Math.min(paraEnd, end);

      const paraTextRecs: Rec[] = [];
      const paraCharShapeRecs: Rec[] = [];
      let extracted: ExtractedText = createEmptyExtractedText();
      let charRuns: { pos: number; csId: number }[] = [];
      let innerTbl = -1;
      let innerGso = -1;

      for (let j = i + 1; j < clampedEnd; j++) {
        const r = recs[j];
        if (r.tagId === TAG_PARA_TEXT) paraTextRecs.push(r);
        if (r.tagId === TAG_PARA_CHAR_SHAPE) paraCharShapeRecs.push(r);
        if (r.tagId === TAG_CTRL_HEADER) {
          const cid = getCtrlId(r);
          if (cid === 'tbl ') innerTbl = j;
          if (cid === 'gso ') innerGso = j;
        }
      }

      extracted = extractTextFromRecords(paraTextRecs);
      charRuns = parseMergedCharRuns(paraCharShapeRecs);

      if (innerTbl >= 0) {
        parts.push(renderTable(recs, innerTbl, ctx, { inTableCell: true }));
      } else if (innerGso >= 0) {
        parts.push(renderParaHtml(extracted.text, charRuns, ctx, paraShapeId, extracted.logicalToDisplayPos));
        parts.push(renderGso(recs, innerGso, ctx, { inTableCell: true }));
      } else {
        parts.push(renderParaHtml(extracted.text, charRuns, ctx, paraShapeId, extracted.logicalToDisplayPos));
      }

      i = clampedEnd;
    } else {
      i++;
    }
  }

  return parts.join('');
}

// ──────────────────────────────────────────────
// GSO(이미지) 렌더링
// ──────────────────────────────────────────────

function renderGso(recs: Rec[], ctrlIdx: number, ctx: Ctx, opts?: { inTableCell?: boolean }): string {
  const rec = recs[ctrlIdx];
  const imageId = resolveGsoImageId(recs, ctrlIdx, ctx.images) ?? (rec.size >= 28 ? u32(rec.data, rec.offset + 24) : 0);
  const layout = findGsoLayout(recs, ctrlIdx);

  if (imageId > 0) {
    const src = ctx.images.get(imageId);
    if (src) {
      const styleParts = ['display:inline-block', 'vertical-align:top'];
      if (layout.widthPx && layout.widthPx > 0) styleParts.push(`width:${layout.widthPx}px`);
      if (layout.heightPx && layout.heightPx > 0) styleParts.push(`height:${layout.heightPx}px`);
      if (!(layout.widthPx && layout.widthPx > 0) && !(layout.heightPx && layout.heightPx > 0)) {
        styleParts.push('height:auto');
      }
      if (!opts?.inTableCell) {
        const x = layout.offsetXPx ?? layout.ctrlOffsetXPx;
        const y = layout.offsetYPx ?? layout.ctrlOffsetYPx;
        if (x !== undefined) styleParts.push(`margin-left:${x}px`);
        if (y !== undefined) styleParts.push(`margin-top:${y}px`);
        if (layout.textFlowMethod === 0) styleParts.push('display:block');
      }
      return `<img src="${src}" style="${styleParts.join(';')}" />`;
    }
  }

  // Skip unresolved images/shapes instead of flooding the document with placeholders.
  return '';
}

function resolveGsoImageId(recs: Rec[], ctrlIdx: number, images: Map<number, string>): number | null {
  const candidates = findGsoImageCandidates(recs, ctrlIdx);
  for (const c of candidates) {
    if (c > 0 && images.has(c)) return c;
  }
  for (const c of candidates) {
    if (c > 0) return c;
  }
  return null;
}

function findGsoImageCandidates(recs: Rec[], ctrlIdx: number): number[] {
  const ctrl = recs[ctrlIdx];
  const childStart = ctrlIdx + 1;
  const childEnd = findChildrenEnd(recs, childStart, ctrl.level);
  const candidates = new Set<number>();

  for (let i = childStart; i < childEnd; i++) {
    const rec = recs[i];
    if (rec.tagId === TAG_SHAPE_PICTURE) {
      // Legacy heuristic used in this project.
      if (rec.size >= 72) {
        const packed = u16(rec.data, rec.offset + 70);
        candidates.add(packed >>> 8);
      }
      // hwp.js parser uses skip((4*17)+3) then readUInt16() - 1.
      if (rec.size >= 73) {
        const binLike = u16(rec.data, rec.offset + 71);
        if (binLike > 0) {
          candidates.add(binLike);
          candidates.add(binLike - 1);
        }
      }
      // conservative fallback
      if (rec.size >= 72) candidates.add(u16(rec.data, rec.offset + 70));
    }
  }

  return Array.from(candidates).filter((v) => Number.isFinite(v) && v > 0);
}

function findGsoLayout(recs: Rec[], ctrlIdx: number): GsoLayout {
  const ctrl = recs[ctrlIdx];
  const ctrlLayout = parseGsoCtrlHeaderLayout(ctrl);
  const childStart = ctrlIdx + 1;
  const childEnd = findChildrenEnd(recs, childStart, ctrl.level);

  for (let i = childStart; i < childEnd; i++) {
    const rec = recs[i];
    // SHAPE_COMPONENT: width/height are usually stored at offset 28/32 (HWPUNIT)
    if (rec.tagId === TAG_SHAPE_COMPONENT && rec.size >= 36) {
      const widthHwpUnit = u32(rec.data, rec.offset + 28);
      const heightHwpUnit = u32(rec.data, rec.offset + 32);
      const widthPx = hwpUnitToPx(widthHwpUnit);
      const heightPx = hwpUnitToPx(heightHwpUnit);
      const offsetXPx = hwpOffsetToPx(i32(rec.data, rec.offset + 20));
      const offsetYPx = hwpOffsetToPx(i32(rec.data, rec.offset + 24));
      return { ...ctrlLayout, widthPx, heightPx, offsetXPx, offsetYPx };
    }
  }

  return ctrlLayout;
}

function parseGsoCtrlHeaderLayout(ctrl: Rec): GsoLayout {
  if (getCtrlId(ctrl) !== 'gso ') return {};
  // common control: ctrlId(4), attr(4), verticalOffset(4), horizontalOffset(4), width(4), height(4)...
  if (ctrl.size < 24) return {};
  const attr = u32(ctrl.data, ctrl.offset + 4);
  const vRelTo = (attr >>> 3) & 0x3;
  const hRelTo = (attr >>> 8) & 0x3;
  const textFlowMethod = (attr >>> 21) & 0x7;
  const ctrlOffsetYPx = hwpOffsetToPx(i32(ctrl.data, ctrl.offset + 8));
  const ctrlOffsetXPx = hwpOffsetToPx(i32(ctrl.data, ctrl.offset + 12));
  return { ctrlOffsetXPx, ctrlOffsetYPx, hRelTo, vRelTo, textFlowMethod };
}

function hwpUnitToPx(value: number): number | undefined {
  // HWPUNIT is 1/7200 inch. At 96dpi: 75 HWPUNIT == 1px
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const px = Math.round(value / 75);
  if (px <= 0 || px > 5000) return undefined;
  return px;
}

function hwpOffsetToPx(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  let px = Math.round(abs / 75);
  // Some files store shape offsets in a 10x finer unit than width/height.
  // If the value is implausibly large for page layout, downscale once.
  if (px > 1200) px = Math.round(abs / 750);
  if (px <= 0 || px > 1200) return undefined;
  return px * sign;
}

function hwpUnitToPt(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Number((value / 100).toFixed(2));
}

function hwpLengthToPx(value: number): number | undefined {
  if (!Number.isFinite(value) || value === 0) return undefined;
  const px = Math.round(value / 75);
  if (!Number.isFinite(px) || px < -2000 || px > 2000) return undefined;
  return px;
}

function hwpPt100ToPt(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const pt = value / 100;
  if (!Number.isFinite(pt) || pt <= 0 || pt > 3000) return undefined;
  return Number(pt.toFixed(2));
}

function parseParaMetricToPx(raw: number): number | undefined {
  if (!Number.isFinite(raw) || raw === 0) return undefined;
  // Some para metrics are in HWPUNIT(1/7200 inch), some are pt*100.
  // Try HWPUNIT first; if implausible, fallback to pt*100.
  const byHwpUnit = raw / 75;
  if (Math.abs(byHwpUnit) <= 300) return Number(byHwpUnit.toFixed(2));
  const byPt100 = (raw / 100) * (96 / 72);
  if (Math.abs(byPt100) <= 300) return Number(byPt100.toFixed(2));
  return undefined;
}

function parseLineHeightRatio(raw: number): number | undefined {
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  // HWP para shape often stores line spacing as a percent value (100, 130, 160 ...)
  if (raw >= 60 && raw <= 300) return Number((raw / 100).toFixed(2));
  return undefined;
}

function parseTableDimensionsFromCtrlHeader(rec: Rec): { widthPt?: number; heightPt?: number } {
  if (getCtrlId(rec) !== 'tbl ') return {};
  // CTRL_HEADER common control: ctrlId(4) + attribute(4) + vert(4) + horz(4) + width(4) + height(4)
  if (rec.size < 24) return {};
  const widthRaw = u32(rec.data, rec.offset + 16);
  const heightRaw = u32(rec.data, rec.offset + 20);
  return {
    widthPt: hwpPt100ToPt(widthRaw),
    heightPt: hwpPt100ToPt(heightRaw),
  };
}

function parseTableLayoutFromCtrlHeader(rec: Rec): TableLayout {
  if (getCtrlId(rec) !== 'tbl ') return {};
  if (rec.size < 24) return {};
  const attr = u32(rec.data, rec.offset + 4);
  const inline = (attr & 0x1) !== 0;
  const vRelTo = (attr >>> 3) & 0x3;
  const vAlign = (attr >>> 5) & 0x7;
  const hRelTo = (attr >>> 8) & 0x3;
  const hAlign = (attr >>> 10) & 0x7;
  const textFlowMethod = (attr >>> 21) & 0x7;
  const offsetYHwp = i32(rec.data, rec.offset + 8);
  const offsetXHwp = i32(rec.data, rec.offset + 12);
  const marginLeftHwp = rec.size >= 30 ? i16(rec.data, rec.offset + 28) : undefined;
  const marginRightHwp = rec.size >= 32 ? i16(rec.data, rec.offset + 30) : undefined;
  const marginTopHwp = rec.size >= 34 ? i16(rec.data, rec.offset + 32) : undefined;
  const marginBottomHwp = rec.size >= 36 ? i16(rec.data, rec.offset + 34) : undefined;
  return {
    inline,
    offsetXHwp,
    offsetYHwp,
    marginLeftHwp,
    marginRightHwp,
    marginTopHwp,
    marginBottomHwp,
    hRelTo,
    vRelTo,
    hAlign,
    vAlign,
    textFlowMethod,
  };
}

function resolveTableMarginLeftPt(
  layout: TableLayout | undefined,
  tableWidthPt: number | undefined,
  paraShape: ParaShapeDef | undefined,
  pageLayout: PageLayout | undefined
): number | undefined {
  if (!layout || layout.inline) return undefined;

  const x = layout.offsetXHwp ?? 0;
  const marginLeft = layout.marginLeftHwp ?? 0;
  const marginRight = layout.marginRightHwp ?? 0;
  const paraMarginLeft = paraShape?.marginLeftHwp ?? 0;
  const paraMarginRight = paraShape?.marginRightHwp ?? 0;
  const pageWidth = pageLayout?.widthPt !== undefined ? Math.round(pageLayout.widthPt * 100) : undefined;
  const leftOffset = pageLayout?.paddingLeftPt !== undefined ? Math.round(pageLayout.paddingLeftPt * 100) : 0;
  const rightOffset = pageLayout?.paddingRightPt !== undefined ? Math.round(pageLayout.paddingRightPt * 100) : 0;
  const tableWidth = tableWidthPt !== undefined ? Math.round(tableWidthPt * 100) : 0;

  let marginLeftHwp: number | undefined;
  switch (layout.hRelTo) {
    case 3: // paragraph
      switch (layout.hAlign) {
        case 0:
          marginLeftHwp = paraMarginLeft + marginLeft + x;
          break;
        case 1:
          if (pageWidth !== undefined && tableWidth > 0) {
            marginLeftHwp = Math.round((pageWidth - leftOffset - rightOffset) / 2 - tableWidth / 2 + x + paraMarginLeft);
          }
          break;
        case 2:
          if (pageWidth !== undefined && tableWidth > 0) {
            marginLeftHwp = pageWidth - rightOffset - paraMarginRight - x - marginRight - tableWidth - leftOffset;
          }
          break;
      }
      break;
    case 2: // column
    case 1: // page
      switch (layout.hAlign) {
        case 0:
          marginLeftHwp = marginLeft + x;
          break;
        case 1:
          if (pageWidth !== undefined && tableWidth > 0) {
            marginLeftHwp = Math.round((pageWidth - leftOffset - rightOffset) / 2 - tableWidth / 2 + x);
          }
          break;
        case 2:
          if (pageWidth !== undefined && tableWidth > 0) {
            marginLeftHwp = pageWidth - rightOffset - x - marginRight - tableWidth - leftOffset;
          }
          break;
      }
      break;
    case 0: // paper
      switch (layout.hAlign) {
        case 0:
          marginLeftHwp = marginLeft + x - leftOffset;
          break;
        case 1:
          if (pageWidth !== undefined && tableWidth > 0) {
            marginLeftHwp = Math.round(pageWidth / 2 - tableWidth / 2 + x - leftOffset);
          }
          break;
        case 2:
          if (pageWidth !== undefined && tableWidth > 0) {
            marginLeftHwp = pageWidth - x - marginRight - tableWidth - leftOffset;
          }
          break;
      }
      break;
  }

  if (marginLeftHwp === undefined) {
    marginLeftHwp = marginLeft + x;
  }
  return hwpUnitToPt(marginLeftHwp);
}

function extractSectionPageLayout(recs: Rec[]): PageLayout | undefined {
  for (const rec of recs) {
    if (rec.tagId !== TAG_PAGE_DEF || rec.size < 36) continue;

    const layout: PageLayout = {
      widthPt: hwpPt100ToPt(u32(rec.data, rec.offset)),
      heightPt: hwpPt100ToPt(u32(rec.data, rec.offset + 4)),
      paddingLeftPt: hwpPt100ToPt(u32(rec.data, rec.offset + 8)),
      paddingRightPt: hwpPt100ToPt(u32(rec.data, rec.offset + 12)),
      paddingTopPt: hwpPt100ToPt(u32(rec.data, rec.offset + 16)),
      paddingBottomPt: hwpPt100ToPt(u32(rec.data, rec.offset + 20)),
      headerPaddingPt: hwpPt100ToPt(u32(rec.data, rec.offset + 24)),
      footerPaddingPt: hwpPt100ToPt(u32(rec.data, rec.offset + 28)),
    };

    if (!layout.widthPt || !layout.heightPt) continue;
    return layout;
  }

  return undefined;
}

function parseTableBorderFillId(rec: Rec, rowCount: number): number {
  const minBase = 4 + 2 + 2 + 10;
  const offset = rec.offset + minBase + (Math.max(0, rowCount) * 2);
  if (offset + 2 > rec.offset + rec.size) return 0;
  return u16(rec.data, offset);
}

function resolveBorderFill(borderFills: BorderFillDef[], rawId: number): BorderFillDef | undefined {
  if (!Number.isFinite(rawId) || rawId <= 0) return undefined;
  if (rawId - 1 >= 0 && rawId - 1 < borderFills.length) return borderFills[rawId - 1];
  if (rawId >= 0 && rawId < borderFills.length) return borderFills[rawId];
  return undefined;
}

function borderStyleFromCode(type: number): string {
  const styleMap: Record<number, string> = {
    0: 'none',
    1: 'solid',
    2: 'dashed',
    3: 'dotted',
    8: 'double',
  };
  return styleMap[type] ?? 'solid';
}

function borderWidthPxFromCode(widthCode: number): number {
  // hwp.js viewer uses mm-based width tokens.
  const widthMm = [
    0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5,
    0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0,
  ];
  const clamped = Math.max(0, Math.min(widthCode, widthMm.length - 1));
  return Number((widthMm[clamped] * 3.7795275591).toFixed(2));
}

function applyBorderFillCss(styles: string[], borderFill?: BorderFillDef) {
  if (!borderFill) return;
  if (borderFill.backgroundColor) styles.push(`background-color:${borderFill.backgroundColor}`);

  const { top, right, bottom, left } = borderFill.style;

  // 모든 면이 동일하면 shorthand 사용
  const allSame = top.type === right.type && top.type === bottom.type && top.type === left.type
    && top.width === right.width && top.width === bottom.width && top.width === left.width
    && top.color === right.color && top.color === bottom.color && top.color === left.color;

  if (allSame) {
    if (top.type === 0) return; // 모든 면 none → 스킵
    const style = borderStyleFromCode(top.type);
    const width = borderWidthPxFromCode(top.width);
    const color = top.color || '#000000';
    styles.push(`border:${width}px ${style} ${color}`);
    return;
  }

  // 면별 shorthand (none이면 스킵)
  const pushSide = (side: 'top' | 'right' | 'bottom' | 'left', line: BorderLineDef) => {
    if (line.type === 0) return; // none → 스킵
    const style = borderStyleFromCode(line.type);
    const width = borderWidthPxFromCode(line.width);
    const color = line.color || '#000000';
    styles.push(`border-${side}:${width}px ${style} ${color}`);
  };

  pushSide('top', top);
  pushSide('right', right);
  pushSide('bottom', bottom);
  pushSide('left', left);
}

function parseHwpColorRef(raw: number, allowGrayPalette = false): string | undefined {
  if (!Number.isFinite(raw)) return undefined;
  if (raw === 0 || raw === 0xffffffff) return undefined;
  // Auto color / sentinel-like values (commonly FFFF0000 in HWP char shape)
  if ((raw & 0xffff0000) === 0xffff0000) return undefined;
  // In sampled files, non-zero alpha-byte values are palette/system refs.
  // Only trust plain 0x00BBGGRR literal colors for now.
  if (((raw >>> 24) & 0xff) !== 0) return undefined;

  // Windows COLORREF-like low 24bit: 0x00BBGGRR
  const r = raw & 0xff;
  const g = (raw >>> 8) & 0xff;
  const b = (raw >>> 16) & 0xff;
  if (r === 0 && g === 0 && b === 0) return undefined;

  // Most sampled shade colors are neutral grays used as non-text auxiliaries.
  if (!allowGrayPalette && r === g && g === b) return undefined;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function parseHwpRgbColorRef(raw: number): string | undefined {
  if (!Number.isFinite(raw)) return undefined;
  const r = raw & 0xff;
  const g = (raw >>> 8) & 0xff;
  const b = (raw >>> 16) & 0xff;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function normalizeCellInfos(cells: CellInfo[], nRows: number, nCols: number): CellInfo[] {
  const out: CellInfo[] = [];

  for (const cell of cells) {
    let row = Number.isFinite(cell.row) ? cell.row : 0;
    let col = Number.isFinite(cell.col) ? cell.col : 0;
    let colSpan = Number.isFinite(cell.colSpan) ? cell.colSpan : 1;
    let rowSpan = Number.isFinite(cell.rowSpan) ? cell.rowSpan : 1;

    if (row < 0) row = 0;
    if (col < 0) col = 0;
    if (row >= nRows || col >= nCols) continue;

    if (colSpan < 1 || colSpan > nCols) colSpan = 1;
    if (rowSpan < 1 || rowSpan > nRows) rowSpan = 1;

    if (col + colSpan > nCols) colSpan = Math.max(1, nCols - col);
    if (row + rowSpan > nRows) rowSpan = Math.max(1, nRows - row);

    out.push({ ...cell, row, col, colSpan, rowSpan });
  }

  return out;
}

function estimateColumnWidths(
  cells: CellInfo[],
  nCols: number,
  tableWidthPt?: number
): number[] {
  const maxValidWidthPt = Math.max((tableWidthPt ?? 480) * 2, 48);
  return resolveTrackSizes(
    cells,
    nCols,
    (cell) => cell.col,
    (cell) => cell.colSpan,
    (cell) => sanitizeTrackSizePt(hwpPt100ToPt(cell.width), maxValidWidthPt),
  );
}

function estimateRowHeightsPt(cells: CellInfo[], nRows: number): number[] {
  const maxValidHeightPt = 2000;
  return resolveTrackSizes(
    cells,
    nRows,
    (cell) => cell.row,
    (cell) => cell.rowSpan,
    (cell) => sanitizeTrackSizePt(hwpPt100ToPt(cell.height), maxValidHeightPt),
  );
}

function resolveColumnWidthsPt(
  cells: CellInfo[],
  nCols: number,
  tableWidthPt?: number
): number[] {
  return normalizeResolvedTrackSizes(
    estimateColumnWidths(cells, nCols, tableWidthPt),
    tableWidthPt
  );
}

function inferTrackCount(
  cells: CellInfo[],
  getStart: (cell: CellInfo) => number,
  getSpan: (cell: CellInfo) => number,
  knownTrackCount?: number,
  fallbackTrackCount = 64
): number {
  let inferred = 0;

  for (const cell of cells) {
    const start = Number.isFinite(getStart(cell)) ? Math.max(0, Math.trunc(getStart(cell))) : 0;
    const span = sanitizeTrackSpan(getSpan(cell), start, knownTrackCount, fallbackTrackCount);
    inferred = Math.max(inferred, start + span);
  }

  return inferred;
}

function sanitizeTrackSpan(
  rawSpan: number | undefined,
  start: number,
  knownTrackCount?: number,
  fallbackTrackCount = 64
): number {
  const safeSpan = Number.isFinite(rawSpan) && rawSpan !== undefined ? Math.trunc(rawSpan) : 1;
  const boundedTrackCount = knownTrackCount !== undefined && knownTrackCount > 0
    ? knownTrackCount
    : fallbackTrackCount;
  const remainingTracks = Math.max(1, boundedTrackCount - Math.max(0, start));

  if (!Number.isFinite(safeSpan) || safeSpan < 1) return 1;
  return Math.max(1, Math.min(safeSpan, remainingTracks));
}

function sanitizeTrackSizePt(sizePt: number | undefined, maxSizePt: number): number | undefined {
  if (!Number.isFinite(sizePt) || sizePt === undefined || sizePt <= 0) return undefined;
  if (!Number.isFinite(maxSizePt) || maxSizePt <= 0) return sizePt;
  if (sizePt > maxSizePt) return undefined;
  return sizePt;
}

function resolveTrackSizes(
  cells: CellInfo[],
  trackCount: number,
  getStart: (cell: CellInfo) => number,
  getSpan: (cell: CellInfo) => number,
  getSizePt: (cell: CellInfo) => number | undefined,
): number[] {
  const directSamples = Array.from({ length: trackCount }, () => [] as number[]);
  const constraints: Array<{ start: number; span: number; sizePt: number }> = [];

  for (const cell of cells) {
    const sizePt = getSizePt(cell);
    if (!Number.isFinite(sizePt) || sizePt === undefined || sizePt <= 0) continue;

    const start = Math.max(0, Math.min(trackCount - 1, getStart(cell)));
    const span = Math.max(1, Math.min(trackCount - start, getSpan(cell)));
    constraints.push({ start, span, sizePt });

    if (span === 1) {
      directSamples[start].push(sizePt);
    }
  }

  const sizes = new Array(trackCount).fill(0);
  let seeded = 0;
  let seededSum = 0;

  for (let i = 0; i < trackCount; i++) {
    if (directSamples[i].length === 0) continue;
    const resolved = median(directSamples[i]);
    if (!Number.isFinite(resolved) || resolved <= 0) continue;
    sizes[i] = resolved;
    seeded += 1;
    seededSum += resolved;
  }

  let fallback = seeded > 0 ? seededSum / seeded : 24;
  if (!Number.isFinite(fallback) || fallback <= 0) fallback = 24;

  constraints.sort((a, b) => a.span - b.span);
  for (let pass = 0; pass < 6; pass++) {
    for (const constraint of constraints) {
      const trackIndexes: number[] = [];
      let sum = 0;
      let zeroCount = 0;

      for (let idx = constraint.start; idx < constraint.start + constraint.span; idx++) {
        trackIndexes.push(idx);
        sum += sizes[idx];
        if (sizes[idx] <= 0) zeroCount += 1;
      }

      if (zeroCount > 0) {
        const remainder = Math.max(0, constraint.sizePt - sum);
        const seedSize = remainder > 0 ? remainder / zeroCount : constraint.sizePt / constraint.span;
        for (const idx of trackIndexes) {
          if (sizes[idx] <= 0) sizes[idx] = seedSize;
        }
        sum = trackIndexes.reduce((acc, idx) => acc + sizes[idx], 0);
      }

      if (sum + 0.05 < constraint.sizePt) {
        const delta = constraint.sizePt - sum;
        const weightSum = trackIndexes.reduce((acc, idx) => acc + Math.max(sizes[idx], 1), 0);
        for (const idx of trackIndexes) {
          const weight = Math.max(sizes[idx], 1);
          sizes[idx] += delta * (weight / weightSum);
        }
      }
    }
  }

  for (let i = 0; i < trackCount; i++) {
    if (!Number.isFinite(sizes[i]) || sizes[i] <= 0) {
      sizes[i] = fallback;
    }
  }

  return sizes.map((size) => Number(size.toFixed(2)));
}

function normalizeResolvedTrackSizes(
  sizes: number[],
  totalSizePt?: number
): number[] {
  const normalized = sizes.map((size) => (
    Number.isFinite(size) && size > 0 ? size : 0
  ));
  const total = normalized.reduce((acc, size) => acc + size, 0);

  if (totalSizePt !== undefined && total > 0) {
    const scale = totalSizePt / total;
    if (Number.isFinite(scale) && scale > 0 && scale < 5) {
      return normalized.map((size) => Number((size * scale).toFixed(2)));
    }
  }

  return normalized.map((size) => Number(size.toFixed(2)));
}

function resolvePageContentWidthPt(pageLayout?: PageLayout): number | undefined {
  if (!pageLayout?.widthPt) return undefined;
  const left = pageLayout.paddingLeftPt ?? 0;
  const right = pageLayout.paddingRightPt ?? 0;
  const contentWidthPt = pageLayout.widthPt - left - right;
  if (!Number.isFinite(contentWidthPt) || contentWidthPt <= 0) return undefined;
  return Number(contentWidthPt.toFixed(2));
}

function resolveRequestedTableWidthPt(
  tableWidthPt: number | undefined,
  totalColumnWidthPt: number,
  fallbackWidthPt: number
): number {
  const requestedWidthPt = Number.isFinite(tableWidthPt) && tableWidthPt !== undefined && tableWidthPt > 0
    ? tableWidthPt
    : totalColumnWidthPt;
  if (Number.isFinite(requestedWidthPt) && requestedWidthPt > 0) {
    return Number(requestedWidthPt.toFixed(2));
  }
  return Number(fallbackWidthPt.toFixed(2));
}

function resolveMaxRenderableTableWidthPt(
  pageContentWidthPt: number,
  marginLeftPt?: number
): number | undefined {
  if (!Number.isFinite(pageContentWidthPt) || pageContentWidthPt <= 0) return undefined;
  const remainingWidthPt = pageContentWidthPt - Math.max(0, marginLeftPt ?? 0);
  if (!Number.isFinite(remainingWidthPt) || remainingWidthPt <= 0) return undefined;
  return Number(remainingWidthPt.toFixed(2));
}

function scaleTrackSizesToFit(sizes: number[], targetTotalPt: number): number[] {
  const normalized = sizes.map((size) => (
    Number.isFinite(size) && size > 0 ? size : 0
  ));
  const total = normalized.reduce((acc, size) => acc + size, 0);

  if (!Number.isFinite(targetTotalPt) || targetTotalPt <= 0 || total <= 0) {
    return normalized.map((size) => Number(size.toFixed(2)));
  }

  if (total <= targetTotalPt + 0.05) {
    return normalized.map((size) => Number(size.toFixed(2)));
  }

  const scale = targetTotalPt / total;
  if (!Number.isFinite(scale) || scale <= 0) {
    return normalized.map((size) => Number(size.toFixed(2)));
  }

  return normalized.map((size) => Number((size * scale).toFixed(2)));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

// ──────────────────────────────────────────────
// 텍스트 / 서식
// ──────────────────────────────────────────────

function createEmptyExtractedText(): ExtractedText {
  return {
    text: '',
    logicalToDisplayPos: () => 0,
  };
}

function extractText(rec: Rec): ExtractedText {
  const d = rec.data;
  const o = rec.offset;
  const sz = rec.size;

  const chars: string[] = [];
  const checkpoints: Array<{ logical: number; display: number }> = [{ logical: 0, display: 0 }];

  let byteOffset = 0;
  let logicalPos = 0;
  let displayPos = 0;

  while (byteOffset < sz - 1) {
    const cc = d[o + byteOffset] | (d[o + byteOffset + 1] << 8);
    byteOffset += 2;

    // hwp.js SectionParser 기준: PARA_TEXT control codes 처리
    switch (cc) {
      case 10:
      case 13: {
        chars.push('\n');
        logicalPos += 1;
        displayPos += 1;
        checkpoints.push({ logical: logicalPos, display: displayPos });
        continue;
      }
      case 0: {
        logicalPos += 1;
        checkpoints.push({ logical: logicalPos, display: displayPos });
        continue;
      }
      case TAB_CHAR: { // 0x09 — 탭은 16바이트 확장 제어이지만 표시 문자로 출력
        chars.push('\t');
        if (byteOffset + 14 <= sz) byteOffset += 14;
        logicalPos += 8;
        displayPos += 1;
        checkpoints.push({ logical: logicalPos, display: displayPos });
        continue;
      }
      case 4:
      case 5:
      case 6:
      case 7:
      case 8:
      case 19:
      case 20:
      case 1:
      case 2:
      case 3:
      case 11:
      case 12:
      case 14:
      case 15:
      case 16:
      case 17:
      case 18:
      case 21:
      case 22:
      case 23: {
        // control payload 14 bytes + charCode 2 bytes = 16 bytes token
        if (byteOffset + 14 > sz) {
          logicalPos += 8;
          checkpoints.push({ logical: logicalPos, display: displayPos });
          byteOffset = sz;
          continue;
        }
        byteOffset += 14;
        logicalPos += 8;
        checkpoints.push({ logical: logicalPos, display: displayPos });
        continue;
      }
      case 24: case 25: case 26: case 27:
      case 28: case 29: case 30: case 31: {
        // char controls (24-31): 2바이트만 차지, 추가 데이터 없음
        logicalPos += 1;
        checkpoints.push({ logical: logicalPos, display: displayPos });
        continue;
      }
      default:
        break;
    }

    if (cc >= 0x20) {
      chars.push(String.fromCharCode(cc));
      logicalPos += 1;
      displayPos += 1;
      checkpoints.push({ logical: logicalPos, display: displayPos });
    }
  }

  const text = chars.join('');
  const logicalToDisplayPos = (pos: number): number => {
    if (!Number.isFinite(pos) || pos <= 0) return 0;
    let lo = 0;
    let hi = checkpoints.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (checkpoints[mid].logical <= pos) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const display = checkpoints[best]?.display ?? 0;
    if (display < 0) return 0;
    if (display > text.length) return text.length;
    return display;
  };

  return { text, logicalToDisplayPos };
}

function extractTextFromRecords(recs: Rec[]): ExtractedText {
  if (!recs.length) return createEmptyExtractedText();
  if (recs.length === 1) return extractText(recs[0]);

  let text = '';
  const segments: Array<{ start: number; end: number; mapper: (logicalPos: number) => number }> = [];
  let logicalBase = 0;

  for (const rec of recs) {
    const seg = extractText(rec);
    const segText = seg.text;
    // Estimate logical span upper-bound from raw record bytes.
    // This keeps mapper monotonic even when control tokens are present.
    const logicalSpan = Math.max(segText.length, Math.floor(rec.size / 2));
    segments.push({
      start: logicalBase,
      end: logicalBase + logicalSpan,
      mapper: seg.logicalToDisplayPos,
    });
    logicalBase += logicalSpan;
    text += segText;
  }

  const logicalToDisplayPos = (pos: number): number => {
    if (!Number.isFinite(pos) || pos <= 0) return 0;
    let displayBase = 0;
    for (const s of segments) {
      if (pos < s.start) break;
      if (pos <= s.end) {
        const inner = Math.max(0, pos - s.start);
        return Math.min(text.length, displayBase + s.mapper(inner));
      }
      // advance display base by this segment text length
      displayBase += Math.max(0, s.mapper(s.end - s.start));
    }
    return Math.min(text.length, text.length);
  };

  return { text, logicalToDisplayPos };
}

function parseCharRuns(rec: Rec): { pos: number; csId: number }[] {
  const runs: { pos: number; csId: number }[] = [];
  const d = rec.data, o = rec.offset;
  for (let i = 0; i + 7 < rec.size; i += 8) {
    runs.push({
      pos: d[o + i] | (d[o + i + 1] << 8) | (d[o + i + 2] << 16) | (d[o + i + 3] << 24),
      csId: d[o + i + 4] | (d[o + i + 5] << 8) | (d[o + i + 6] << 16) | (d[o + i + 7] << 24),
    });
  }
  return runs;
}

function parseMergedCharRuns(recs: Rec[]): { pos: number; csId: number }[] {
  if (!recs.length) return [];
  if (recs.length === 1) return parseCharRuns(recs[0]);
  const merged: { pos: number; csId: number }[] = [];
  for (const rec of recs) merged.push(...parseCharRuns(rec));
  merged.sort((a, b) => a.pos - b.pos);
  const deduped: { pos: number; csId: number }[] = [];
  for (const run of merged) {
    const last = deduped[deduped.length - 1];
    if (last && last.pos === run.pos) {
      last.csId = run.csId;
    } else {
      deduped.push({ ...run });
    }
  }
  return deduped;
}

function buildParaStyleAttr(ctx: Ctx, paraShapeId: number): string {
  const ps = ctx.paraShapes[paraShapeId];
  const alignMap: Record<number, string> = { 0: 'justify', 1: 'left', 2: 'right', 3: 'center', 4: 'justify' };
  const paraStyles: string[] = [];
  if (ps) {
    const align = alignMap[ps.align] || '';
    if (align && align !== 'left') paraStyles.push(`text-align:${align}`);
    if (ps.lineHeight) {
      paraStyles.push(`line-height:${ps.lineHeight}`);
      paraStyles.push(`min-height:${ps.lineHeight}em`);
    }
    if (ps.marginLeftPx !== undefined && Math.abs(ps.marginLeftPx) > 1) paraStyles.push(`margin-left:${ps.marginLeftPx}px`);
    if (ps.marginRightPx !== undefined && Math.abs(ps.marginRightPx) > 1) paraStyles.push(`margin-right:${ps.marginRightPx}px`);
    if (ps.indentPx !== undefined && Math.abs(ps.indentPx) > 1) paraStyles.push(`text-indent:${ps.indentPx}px`);
    if (ps.paddingLeftPx !== undefined && ps.paddingLeftPx > 0.5) paraStyles.push(`padding-left:${ps.paddingLeftPx}px`);
    if (ps.marginTopPx !== undefined && Math.abs(ps.marginTopPx) > 1) paraStyles.push(`margin-top:${ps.marginTopPx}px`);
    if (ps.marginBottomPx !== undefined && Math.abs(ps.marginBottomPx) > 1) paraStyles.push(`margin-bottom:${ps.marginBottomPx}px`);
  }
  return paraStyles.length ? ` style="${paraStyles.join(';')}"` : '';
}

function renderStyledTextHtml(
  text: string,
  charRuns: { pos: number; csId: number }[],
  ctx: Ctx,
  logicalToDisplayPos?: (logicalPos: number) => number
): string {
  if (charRuns.length === 0) return escapeHtmlWithBreaks(text);

  const mappedRuns = charRuns
    .map((run) => ({
      pos: logicalToDisplayPos ? logicalToDisplayPos(run.pos) : run.pos,
      csId: run.csId,
    }))
    .filter((run) => Number.isFinite(run.pos) && run.pos >= 0 && run.pos <= text.length)
    .sort((a, b) => a.pos - b.pos);

  if (mappedRuns.length === 0) return escapeHtmlWithBreaks(text);

  const spans: string[] = [];
  let cursor = 0;

  for (let i = 0; i < mappedRuns.length; i++) {
    const run = mappedRuns[i];
    const nextPos = i + 1 < mappedRuns.length ? mappedRuns[i + 1].pos : text.length;
    const startPos = Math.max(0, Math.min(run.pos, text.length));
    const endPos = Math.max(startPos, Math.min(nextPos, text.length));

    if (startPos > cursor) {
      spans.push(escapeHtmlWithBreaks(text.slice(cursor, startPos)));
    }

    const seg = text.slice(startPos, endPos);
    if (seg) {
      const cs = ctx.charShapes[run.csId] ?? ctx.charShapes[run.csId - 1];
      if (!cs) {
        spans.push(escapeHtmlWithBreaks(seg));
      } else {
        const spanStyles: string[] = [];
        if (cs.fontFamily) spanStyles.push(`font-family:${cs.fontFamily}`);
        if (cs.ptSize && cs.ptSize !== 10) spanStyles.push(`font-size:${cs.ptSize}pt`);
        if (cs.bold) spanStyles.push('font-weight:700');
        if (cs.italic) spanStyles.push('font-style:italic');
        if (cs.textColor) spanStyles.push(`color:${cs.textColor}`);
        if (cs.underline && cs.strikethrough) spanStyles.push('text-decoration:underline line-through');
        else if (cs.underline) spanStyles.push('text-decoration:underline');
        else if (cs.strikethrough) spanStyles.push('text-decoration:line-through');

        if (spanStyles.length) {
          spans.push(`<span style="${spanStyles.join(';')}">${escapeHtmlWithBreaks(seg)}</span>`);
        } else {
          spans.push(escapeHtmlWithBreaks(seg));
        }
      }
    }

    cursor = Math.max(cursor, endPos);
  }

  if (cursor < text.length) spans.push(escapeHtmlWithBreaks(text.slice(cursor)));
  return spans.join('');
}

function renderParaHtml(
  text: string,
  charRuns: { pos: number; csId: number }[],
  ctx: Ctx,
  paraShapeId: number,
  logicalToDisplayPos?: (logicalPos: number) => number
): string {
  const displayText = text.replace(/\n+$/g, '');
  const paraStyleAttr = buildParaStyleAttr(ctx, paraShapeId);
  return `<p${paraStyleAttr}>${renderStyledTextHtml(displayText, charRuns, ctx, logicalToDisplayPos)}</p>`;
}

function renderInlineTableParagraph(
  recs: Rec[],
  tableIndices: number[],
  extracted: ExtractedText,
  charRuns: { pos: number; csId: number }[],
  ctx: Ctx,
  paraShapeId: number
): string {
  const displayText = extracted.text.replace(/\n+$/g, '');
  const paraStyleAttr = buildParaStyleAttr(ctx, paraShapeId);
  const textHtml = displayText
    ? renderStyledTextHtml(displayText, charRuns, ctx, extracted.logicalToDisplayPos)
    : '';
  const wrappedTextHtml = /^\s+$/.test(displayText)
    ? `<span style="white-space:pre-wrap">${textHtml}</span>`
    : textHtml;
  const tablesHtml = tableIndices
    .map((ti) => `<span class="TableControl" style="display:inline-block;vertical-align:top">${renderTable(recs, ti, ctx, { inTableCell: true })}</span>`)
    .join('');
  return `<p${paraStyleAttr}>${wrappedTextHtml}${tablesHtml}</p>`;
}

// ──────────────────────────────────────────────
// 메타데이터
// ──────────────────────────────────────────────

function extractMetadata(cfb: CFB.CFB$Container): Record<string, string> {
  const meta: Record<string, string> = {};
  const entry = CFB.find(cfb, '/\x05HwpSummaryInformation');
  if (!entry?.content) return meta;
  try {
    const raw = entry.content instanceof Uint8Array ? entry.content : new Uint8Array(entry.content);
    if (raw.length < 48) return meta;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const secOff = view.getUint32(44, true);
    if (secOff >= raw.length) return meta;
    const cnt = view.getUint32(secOff + 4, true);
    for (let i = 0; i < cnt && i < 20; i++) {
      const eo = secOff + 8 + i * 8;
      if (eo + 8 > raw.length) break;
      const pid = view.getUint32(eo, true);
      const ao = secOff + view.getUint32(eo + 4, true);
      if (ao + 8 > raw.length) continue;
      if (view.getUint32(ao, true) === 30) {
        const sl = view.getUint32(ao + 4, true);
        if (ao + 8 + sl > raw.length) continue;
        const s = new TextDecoder('euc-kr').decode(raw.slice(ao + 8, ao + 8 + sl - 1)).trim();
        if (s) { if (pid === 2) meta.title = s; if (pid === 4) meta.author = s; }
      }
    }
  } catch { /* */ }
  return meta;
}
