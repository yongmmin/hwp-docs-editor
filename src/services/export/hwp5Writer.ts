import CFB from 'cfb';
import pako from 'pako';
import type { JSONContent } from '@tiptap/react';
import type { Hwp5ExportMeta } from '../../types';
import {
  readRecordHeaders,
  writeRecordHeader,
  recordTotalSize,
  TAG_PARA_HEADER,
  TAG_PARA_TEXT,
} from './hwp5Records';

/**
 * HWP5 writer — patches BodyText records inside the original OLE2 file.
 *
 * 전략 (최소 동작 스코프):
 *  - 원본 OLE2 바이너리를 cfb로 로드
 *  - 각 /BodyText/Section# 스트림을 pako로 inflateRaw (압축 여부는 FileHeader
 *    플래그로 판정)
 *  - meta.paragraphs가 기록한 바이트 범위를 기준으로 단락을 순회
 *  - 편집 HTML의 단락과 HWP5 단락을 **텍스트 기반 LCS 정렬**로 매칭.
 *    파이프라인(ODT 브리지 vs 레거시 파서)에 따라 단락 수가 다르더라도,
 *    원문 그대로인 단락은 그대로 두고 변경된 단락만 패치함.
 *  - 패치 대상 단락이 아래 조건을 모두 만족할 때만 실제 교체:
 *       · hasControls === false (표·이미지·컨트롤 없음)
 *       · PARA_TEXT 레코드가 정확히 1개
 *       · 원본 PARA_TEXT 안에 제어 코드 없음 (0x09/0x0A 제외한 U+0000..U+001F)
 *       · 원본과 새 텍스트가 실제로 다름
 *  - 패치 내용:
 *       · PARA_TEXT 레코드 payload를 새 UTF-16LE 바이트로 교체, size 필드 갱신
 *       · PARA_HEADER 첫 4바이트(nChars)를 새 텍스트 길이로 갱신
 *       · LINE_SEG는 건드리지 않음 → 한글 뷰어가 자동 reflow
 *  - 스트림을 다시 pako.deflateRaw 후 cfb.write로 OLE2 재직렬화
 */

const UTF16LE_DECODER = new TextDecoder('utf-16le');

export async function writeHwp5(
  json: JSONContent,
  originalBuffer: ArrayBuffer,
  meta: Hwp5ExportMeta | undefined
): Promise<Blob> {
  if (!meta || meta.sections.length === 0) {
    console.warn('[hwp5Writer] meta 없음 — 원본 그대로 반환');
    return new Blob([originalBuffer], { type: 'application/x-hwp' });
  }

  const edited = collectEditedParagraphs(json);
  const patchMap = alignForPatch(meta, edited);

  console.log(
    `[hwp5Writer] editor paragraphs=${edited.length}, ` +
      `hwp paragraphs=${meta.sections.reduce((s, sec) => s + sec.paragraphs.length, 0)}, ` +
      `patches=${patchMap.size}`
  );

  if (patchMap.size === 0) {
    return new Blob([originalBuffer], { type: 'application/x-hwp' });
  }

  const cfb = CFB.read(new Uint8Array(originalBuffer), { type: 'array' });
  const compressed = isHwpCompressed(cfb);

  let anyChanges = false;

  for (let secIdx = 0; secIdx < meta.sections.length; secIdx += 1) {
    const sec = meta.sections[secIdx];
    const rawStream = getStreamBytes(cfb, sec.streamPath);
    if (!rawStream) continue;

    const decompressed = compressed ? pako.inflateRaw(rawStream) : rawStream;

    const parts: Uint8Array[] = [];
    let cursor = 0;
    let sectionDirty = false;

    for (let paraIdx = 0; paraIdx < sec.paragraphs.length; paraIdx += 1) {
      const block = sec.paragraphs[paraIdx];
      if (block.startOffset > cursor) {
        parts.push(decompressed.slice(cursor, block.startOffset));
      }

      const origBlock = decompressed.slice(block.startOffset, block.endOffset);
      const newText = patchMap.get(patchKey(secIdx, paraIdx));

      if (newText != null && !block.hasControls) {
        const patched = tryPatchParagraphBlock(origBlock, newText);
        if (patched) {
          parts.push(patched);
          sectionDirty = true;
        } else {
          parts.push(origBlock);
        }
      } else {
        parts.push(origBlock);
      }

      cursor = block.endOffset;
    }

    // 남은 trailing 바이트 (마지막 단락 이후의 non-paragraph 레코드)
    if (cursor < decompressed.length) {
      parts.push(decompressed.slice(cursor));
    }

    if (sectionDirty) {
      const newDecompressed = concatUint8(parts);
      const newStream = compressed ? pako.deflateRaw(newDecompressed) : newDecompressed;
      replaceStreamContent(cfb, sec.streamPath, newStream);
      anyChanges = true;
    }
  }

  if (!anyChanges) {
    return new Blob([originalBuffer], { type: 'application/x-hwp' });
  }

  const outBytes = CFB.write(cfb, { type: 'array' }) as unknown as ArrayLike<number>;
  const buf = outBytes instanceof Uint8Array ? outBytes : new Uint8Array(outBytes);
  return new Blob([buf], { type: 'application/x-hwp' });
}

// ─── CFB helpers ─────────────────────────────────────────────────────────────

function isHwpCompressed(cfb: CFB.CFB$Container): boolean {
  const fh = CFB.find(cfb, '/FileHeader');
  if (!fh?.content || fh.content.length < 37) return true;
  const content = asUint8(fh.content);
  return (content[36] & 0x01) !== 0;
}

function getStreamBytes(
  cfb: CFB.CFB$Container,
  path: string
): Uint8Array | null {
  const entry = CFB.find(cfb, path);
  if (!entry?.content) return null;
  return asUint8(entry.content);
}

function replaceStreamContent(
  cfb: CFB.CFB$Container,
  path: string,
  newContent: Uint8Array
): void {
  const entry = CFB.find(cfb, path);
  if (!entry) return;
  // cfb stores content as an array-like; writing back a Uint8Array is accepted.
  entry.content = newContent;
  if (typeof (entry as { size?: number }).size === 'number') {
    (entry as { size: number }).size = newContent.length;
  }
}

function asUint8(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(data as number[]);
  return new Uint8Array(0);
}

// ─── TipTap JSON helpers ────────────────────────────────────────────────────

interface EditedParagraph {
  text: string;
}

function collectEditedParagraphs(json: JSONContent): EditedParagraph[] {
  const out: EditedParagraph[] = [];
  walk(json);
  return out;

  function walk(node: JSONContent | undefined): void {
    if (!node) return;

    if (node.type === 'paragraph' || node.type === 'heading') {
      const text = collectText(node);
      out.push({ text });
      return;
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child);
    }
  }

  function collectText(node: JSONContent): string {
    if (node.type === 'text' && typeof node.text === 'string') return node.text;
    if (!Array.isArray(node.content)) return '';
    let s = '';
    for (const child of node.content) s += collectText(child);
    return s;
  }
}

// ─── HWP ↔ editor paragraph alignment ───────────────────────────────────────

/**
 * Align HWP5 paragraphs with editor paragraphs using LCS over normalized text,
 * then emit a patch map: `{secIdx}:{paraIdx}` → new text. Only paragraphs whose
 * original text clearly differs from the paired editor paragraph are included;
 * unchanged and control-bearing paragraphs are skipped. Paragraphs that cannot
 * be paired (pure inserts or deletes) are left alone — the writer preserves
 * the original bytes for them.
 */
function alignForPatch(
  meta: Hwp5ExportMeta,
  edited: EditedParagraph[]
): Map<string, string> {
  const patch = new Map<string, string>();

  const flat: Array<{
    secIdx: number;
    paraIdx: number;
    origText: string;
    normText: string;
    hasControls: boolean;
  }> = [];
  meta.sections.forEach((sec, secIdx) => {
    sec.paragraphs.forEach((p, paraIdx) => {
      flat.push({
        secIdx,
        paraIdx,
        origText: p.origText,
        normText: normalizeForMatch(p.origText),
        hasControls: p.hasControls,
      });
    });
  });

  const edNorm = edited.map((e) => normalizeForMatch(e.text));

  const anchors: Array<[number, number]> = [
    [-1, -1],
    ...lcsPairs(
      flat.map((f) => f.normText),
      edNorm
    ),
    [flat.length, edited.length],
  ];

  for (let k = 1; k < anchors.length; k += 1) {
    const [prevH, prevE] = anchors[k - 1];
    const [curH, curE] = anchors[k];

    const hwpGap: number[] = [];
    for (let i = prevH + 1; i < curH; i += 1) hwpGap.push(i);
    const edGap: number[] = [];
    for (let j = prevE + 1; j < curE; j += 1) edGap.push(j);

    const pairs = Math.min(hwpGap.length, edGap.length);
    for (let p = 0; p < pairs; p += 1) {
      const hwpFlat = flat[hwpGap[p]];
      if (hwpFlat.hasControls) continue;
      const newText = edited[edGap[p]].text;
      if (newText === hwpFlat.origText) continue;
      patch.set(patchKey(hwpFlat.secIdx, hwpFlat.paraIdx), newText);
    }
  }

  return patch;
}

function patchKey(secIdx: number, paraIdx: number): string {
  return `${secIdx}:${paraIdx}`;
}

/**
 * Normalize a paragraph's plain text for equality matching. The HWP5 decoder
 * and the ODT-derived HTML pipeline tend to disagree on soft whitespace
 * (leading/trailing spaces, collapsed runs of spaces/tabs, NBSP), so we
 * normalize both sides the same way before running LCS.
 */
function normalizeForMatch(s: string): string {
  return s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Longest Common Subsequence over two string arrays, returning the aligned
 * index pairs (i, j) such that a[i] === b[j] and the pairs are strictly
 * increasing in both dimensions. Classic O(n·m) DP — fine for the hundreds of
 * paragraphs we expect in a single document.
 */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      dp[i * w + j] =
        a[i - 1] === b[j - 1]
          ? dp[(i - 1) * w + (j - 1)] + 1
          : Math.max(dp[(i - 1) * w + j], dp[i * w + (j - 1)]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (dp[(i - 1) * w + j] >= dp[i * w + (j - 1)]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return pairs.reverse();
}

// ─── Paragraph block patching ───────────────────────────────────────────────

/**
 * Given the raw bytes of a single top-level paragraph (starting at its
 * PARA_HEADER record) and the new plain text, return patched bytes or null
 * when patching is not safe / not needed.
 */
function tryPatchParagraphBlock(
  origBlock: Uint8Array,
  newText: string
): Uint8Array | null {
  const headers = readRecordHeaders(origBlock);
  if (headers.length === 0) return null;

  // The first record must be the PARA_HEADER at offset 0 with level 0.
  const paraHeader = headers[0];
  if (paraHeader.tagId !== TAG_PARA_HEADER || paraHeader.level !== 0) return null;

  const textRecords = headers.filter(
    (r) => r.tagId === TAG_PARA_TEXT && r.level === 1
  );
  if (textRecords.length !== 1) return null;

  const textRec = textRecords[0];
  const origTextBytes = origBlock.subarray(
    textRec.dataOffset,
    textRec.dataOffset + textRec.size
  );

  if (hasControlCodes(origTextBytes)) return null;

  // Preserve trailing line-break char (0x0A) — the HWP storage format
  // typically ends each paragraph with one. Strip for the comparison and
  // re-append for the rewrite.
  const origText = decodeUtf16Le(origTextBytes);
  const trailingNewline = origText.endsWith('\n');
  const origTextBare = trailingNewline ? origText.slice(0, -1) : origText;

  if (origTextBare === newText) return null;

  const newTextWithTail = trailingNewline ? newText + '\n' : newText;
  const newTextBytes = encodeUtf16Le(newTextWithTail);

  return rebuildParagraphBlock(origBlock, headers, textRec, newTextBytes, newTextWithTail.length);
}

/**
 * Walk the original byte stream of a paragraph block and emit a new stream
 * with:
 *   - PARA_HEADER re-emitted with its nChars (data offset 0) updated
 *   - The single PARA_TEXT record re-emitted with the new payload + size
 *   - All other records copied byte-for-byte
 */
function rebuildParagraphBlock(
  origBlock: Uint8Array,
  headers: ReturnType<typeof readRecordHeaders>,
  textRec: (typeof headers)[number],
  newTextBytes: Uint8Array,
  newNChars: number
): Uint8Array {
  // Precompute the output size.
  let outSize = 0;
  for (const rec of headers) {
    if (rec === textRec) {
      outSize += recordTotalSize(newTextBytes.length);
    } else {
      outSize += rec.headerSize + rec.size;
    }
  }
  // Include any trailing bytes beyond the last record (rare — padding).
  const lastRec = headers[headers.length - 1];
  const recordsEnd = lastRec.dataOffset + lastRec.size;
  const trailing = origBlock.length - recordsEnd;
  if (trailing > 0) outSize += trailing;

  const out = new Uint8Array(outSize);
  let writeOff = 0;

  for (const rec of headers) {
    if (rec === textRec) {
      // Emit new PARA_TEXT header + payload.
      const headerLen = writeRecordHeader(
        out,
        writeOff,
        rec.tagId,
        rec.level,
        newTextBytes.length
      );
      writeOff += headerLen;
      out.set(newTextBytes, writeOff);
      writeOff += newTextBytes.length;
      continue;
    }

    // Copy the record header + payload verbatim.
    const recBytes = origBlock.subarray(
      rec.headerOffset,
      rec.dataOffset + rec.size
    );
    out.set(recBytes, writeOff);

    // For PARA_HEADER, patch nChars (first u32 of the payload).
    if (rec.tagId === TAG_PARA_HEADER && rec.level === 0 && rec.size >= 4) {
      const payloadStart = writeOff + rec.headerSize;
      out[payloadStart] = newNChars & 0xff;
      out[payloadStart + 1] = (newNChars >>> 8) & 0xff;
      out[payloadStart + 2] = (newNChars >>> 16) & 0xff;
      out[payloadStart + 3] = (newNChars >>> 24) & 0xff;
    }

    writeOff += rec.headerSize + rec.size;
  }

  if (trailing > 0) {
    out.set(origBlock.subarray(recordsEnd), writeOff);
  }

  return out;
}

// ─── text encoding / inspection ─────────────────────────────────────────────

function hasControlCodes(bytes: Uint8Array): boolean {
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return true;
    }
  }
  return false;
}

function decodeUtf16Le(bytes: Uint8Array): string {
  try {
    return UTF16LE_DECODER.decode(bytes);
  } catch {
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    }
    return s;
  }
}

function encodeUtf16Le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i * 2] = code & 0xff;
    out[i * 2 + 1] = (code >>> 8) & 0xff;
  }
  return out;
}

function concatUint8(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
