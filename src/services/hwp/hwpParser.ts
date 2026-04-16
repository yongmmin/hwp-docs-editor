import type { ParsedDocument } from '../../types';
import { parseHwpx } from './hwpxParser';
import { parseHwpLegacy } from './hwpLegacyParser';
import { odtContentToHtml } from './odtParser';

const HWPX_MAGIC = [0x50, 0x4B, 0x03, 0x04]; // ZIP magic bytes (PK..)
const HWP_MAGIC  = [0xD0, 0xCF, 0x11, 0xE0]; // OLE2 magic bytes

export type DocumentFormat = 'hwp' | 'hwpx' | 'unknown';

export function detectFormat(buffer: ArrayBuffer): DocumentFormat {
  const bytes = new Uint8Array(buffer.slice(0, 4));

  if (bytes[0] === HWPX_MAGIC[0] && bytes[1] === HWPX_MAGIC[1] &&
      bytes[2] === HWPX_MAGIC[2] && bytes[3] === HWPX_MAGIC[3]) {
    return 'hwpx';
  }

  if (bytes[0] === HWP_MAGIC[0] && bytes[1] === HWP_MAGIC[1] &&
      bytes[2] === HWP_MAGIC[2] && bytes[3] === HWP_MAGIC[3]) {
    return 'hwp';
  }

  return 'unknown';
}

export function detectFormatByExtension(filename: string): DocumentFormat {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'hwpx') return 'hwpx';
  if (ext === 'hwp') return 'hwp';
  return 'unknown';
}

export async function parseDocument(buffer: ArrayBuffer, filename: string): Promise<ParsedDocument> {
  let format = detectFormat(buffer);

  if (format === 'unknown') {
    format = detectFormatByExtension(filename);
  }

  switch (format) {
    case 'hwpx':
      return parseHwpx(buffer);
    case 'hwp':
      return parseHwp(buffer, filename);
    default:
      throw new Error('지원하지 않는 파일 형식입니다. HWP 또는 HWPX 파일을 업로드해주세요.');
  }
}

// ─── HWP parsing — tries bridge ODT extraction first, falls back to JS parser ─

async function parseHwp(buffer: ArrayBuffer, filename: string): Promise<ParsedDocument> {
  const base64 = arrayBufferToBase64(buffer);

  // Run bridge extraction (high quality) and legacy JS parse in parallel.
  // Bridge gives us accurate editable HTML; legacy parse gives us metadata + pageLayout.
  const [odtResult, legacyResult, originalViewHtml] = await Promise.all([
    tryExtractOdt(base64, filename),
    parseHwpLegacy(buffer),
    tryRenderWithLocalBridge(base64, filename),
  ]);

  if (odtResult) {
    const enhancedHtml = tryInjectLegacyColWidths(odtResult.html, legacyResult?.html);
    return {
      ...legacyResult,                  // metadata, pageLayout, hwp5ExportMeta from JS parser
      html: enhancedHtml,               // high-quality editable HTML from ODT (+ injected col widths)
      originalViewHtml: originalViewHtml ?? undefined,
      sourceMode: 'editable',
      originalFormat: 'hwp',
      rawHwpBuffer: buffer,             // preserved for in-place export
    };
  }

  // Bridge unavailable — fall back to JS parser with a quality warning in the HTML
  if (originalViewHtml) {
    return {
      ...legacyResult,
      html: originalViewHtml,
      originalViewHtml,
      sourceMode: 'hwp-original-readonly',
      originalFormat: 'hwp',
      rawHwpBuffer: buffer,
    };
  }

  return {
    ...legacyResult,
    sourceMode: 'editable',
    originalFormat: 'hwp',
    rawHwpBuffer: buffer,
  };
}

// ─── Bridge: ODT extraction ────────────────────────────────────────────────────

interface OdtExtractResult {
  contentXml: string;
  stylesXml: string;
  images: Record<string, string>;
}

interface OdtExtractSuccess {
  html: string;
  contentXml: string;
  stylesXml: string;
}

async function tryExtractOdt(base64: string, filename: string): Promise<OdtExtractSuccess | undefined> {
  const bridgeUrl = 'http://127.0.0.1:3210/extract-hwp';
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: filename, bufferBase64: base64 }),
      signal: controller.signal,
    });

    if (!response.ok) return undefined;

    const data = await response.json() as OdtExtractResult;
    if (!data?.contentXml || typeof data.contentXml !== 'string') return undefined;

    const html = odtContentToHtml(data.contentXml, data.stylesXml ?? '', data.images ?? {});
    if (!html) return undefined;

    return { html, contentXml: data.contentXml, stylesXml: data.stylesXml ?? '' };
  } catch {
    return undefined;
  } finally {
    window.clearTimeout(timeout);
  }
}

// ─── Bridge: read-only HTML renderer (for comparison / fallback view) ─────────

async function tryRenderWithLocalBridge(base64: string, filename: string): Promise<string | undefined> {
  const bridgeUrl = 'http://127.0.0.1:3210/render-hwp';
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: filename, bufferBase64: base64 }),
      signal: controller.signal,
    });

    if (!response.ok) return undefined;
    const data = await response.json() as { html?: string };
    if (!data?.html || typeof data.html !== 'string') return undefined;
    return data.html;
  } catch {
    return undefined;
  } finally {
    window.clearTimeout(timeout);
  }
}

// ─── Column width injection: pull actual HWP widths from legacy parser ────────

/**
 * Matches tables by position between ODT HTML and legacy JS-parsed HTML.
 * If a legacy table carries `data-hwp-col-widths`, injects that attribute into
 * the matching ODT table so TipTap's Table extension can render a proper colgroup.
 * Only runs when table counts are identical (positional match is safe).
 */
function tryInjectLegacyColWidths(odtHtml: string, legacyHtml: string | undefined): string {
  if (!legacyHtml) return odtHtml;

  try {
    const parser = new DOMParser();
    const odtDoc = parser.parseFromString(`<div>${odtHtml}</div>`, 'text/html');
    const legacyDoc = parser.parseFromString(`<div>${legacyHtml}</div>`, 'text/html');

    const odtTables = Array.from(odtDoc.querySelectorAll('table'));
    const legacyTables = Array.from(legacyDoc.querySelectorAll('table'));

    if (odtTables.length === 0 || legacyTables.length === 0) return odtHtml;
    if (odtTables.length !== legacyTables.length) return odtHtml;

    let modified = false;
    odtTables.forEach((odtTable, i) => {
      const colWidths = legacyTables[i].getAttribute('data-hwp-col-widths');
      if (!colWidths) return;

      // Validate: column count in legacy widths should match ODT col count
      const legacyColCount = colWidths.split(',').length;
      const odtColCount = odtTable.querySelectorAll('col').length;
      if (odtColCount > 0 && odtColCount !== legacyColCount) return;

      odtTable.setAttribute('data-hwp-col-widths', colWidths);
      modified = true;
    });

    if (!modified) return odtHtml;
    return odtDoc.body.firstElementChild?.innerHTML ?? odtHtml;
  } catch {
    return odtHtml;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
