/**
 * HWP5 binary record format helpers.
 *
 * Record header layout (32 bits, little endian):
 *   bits  0..9   tagId
 *   bits 10..19  level
 *   bits 20..31  size (0xFFF = extended; next 4 bytes carry the actual size)
 *
 * After the header (4 bytes, or 8 bytes when extended) comes `size` bytes of
 * record data. Records form a flat stream — there is no nesting in the byte
 * layout. Hierarchy is reconstructed from the `level` field by callers.
 *
 * Both the legacy parser and the export writer share these primitives so that
 * byte offsets agree byte-for-byte.
 */

// ─── tag ids (stable across HWP5 versions) ───
export const TAG_BIN_DATA = 18;
export const TAG_FACE_NAME = 19;
export const TAG_BORDER_FILL = 20;
export const TAG_CHAR_SHAPE = 21;
export const TAG_PARA_SHAPE = 25;
export const TAG_PARA_HEADER = 66;
export const TAG_PARA_TEXT = 67;
export const TAG_PARA_CHAR_SHAPE = 68;
export const TAG_PARA_LINE_SEG = 69;
export const TAG_PARA_RANGE_TAG = 70;
export const TAG_CTRL_HEADER = 71;
export const TAG_LIST_HEADER = 72;
export const TAG_PAGE_DEF = 73;
export const TAG_SHAPE_COMPONENT = 76;
export const TAG_TABLE = 77;
export const TAG_SHAPE_PICTURE = 85;

export interface RecordHeader {
  /** Offset of the record header in the stream (start byte). */
  headerOffset: number;
  /** Offset of the record data — equal to headerOffset + headerSize. */
  dataOffset: number;
  /** Total bytes consumed by the record header (4 or 8). */
  headerSize: number;
  tagId: number;
  level: number;
  /** Bytes of payload after the header. */
  size: number;
}

/**
 * Walk a decompressed HWP5 record stream, yielding header + offset info for
 * every record. Stops on truncation rather than throwing — HWP5 files in the
 * wild may have trailing padding.
 */
export function readRecordHeaders(data: Uint8Array): RecordHeader[] {
  const out: RecordHeader[] = [];
  let off = 0;
  while (off + 4 <= data.length) {
    const headerOffset = off;
    const h =
      data[off] |
      (data[off + 1] << 8) |
      (data[off + 2] << 16) |
      (data[off + 3] << 24);
    off += 4;
    const tagId = h & 0x3ff;
    const level = (h >>> 10) & 0x3ff;
    let size = (h >>> 20) & 0xfff;
    let headerSize = 4;
    if (size === 0xfff) {
      if (off + 4 > data.length) break;
      size =
        (data[off] |
          (data[off + 1] << 8) |
          (data[off + 2] << 16) |
          (data[off + 3] << 24)) >>>
        0;
      off += 4;
      headerSize = 8;
    }
    if (off + size > data.length) break;
    out.push({ headerOffset, dataOffset: off, headerSize, tagId, level, size });
    off += size;
  }
  return out;
}

/**
 * Encode a record header back into the 4-or-8-byte form. The caller supplies
 * the buffer + write offset. Returns the number of bytes written so the caller
 * can advance.
 */
export function writeRecordHeader(
  out: Uint8Array,
  offset: number,
  tagId: number,
  level: number,
  size: number
): number {
  const useExtended = size >= 0xfff;
  const sizeField = useExtended ? 0xfff : size;
  const h = (tagId & 0x3ff) | ((level & 0x3ff) << 10) | ((sizeField & 0xfff) << 20);
  out[offset] = h & 0xff;
  out[offset + 1] = (h >>> 8) & 0xff;
  out[offset + 2] = (h >>> 16) & 0xff;
  out[offset + 3] = (h >>> 24) & 0xff;
  if (!useExtended) return 4;
  out[offset + 4] = size & 0xff;
  out[offset + 5] = (size >>> 8) & 0xff;
  out[offset + 6] = (size >>> 16) & 0xff;
  out[offset + 7] = (size >>> 24) & 0xff;
  return 8;
}

/** Number of bytes required to encode a record (header + payload). */
export function recordTotalSize(payloadSize: number): number {
  return (payloadSize >= 0xfff ? 8 : 4) + payloadSize;
}

/**
 * Compute byte ranges of top-level paragraphs inside a record stream.
 *
 * A "paragraph block" starts at a level-0 PARA_HEADER record and ends just
 * before the next level-0 record at any tag (typically the next PARA_HEADER,
 * but a section may end with non-paragraph trailing records — those become
 * a tail region that is preserved verbatim by the writer).
 */
export interface ParagraphBlock {
  /** Inclusive start byte of the paragraph's PARA_HEADER record header. */
  startOffset: number;
  /** Exclusive end byte (start of next top-level record or stream end). */
  endOffset: number;
  /** Index of the PARA_HEADER in the headers array. */
  headerIndex: number;
  /** True if this paragraph block contains a CTRL_HEADER record. */
  hasControls: boolean;
}

export function collectParagraphBlocks(
  headers: RecordHeader[],
  streamLength: number
): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (h.tagId !== TAG_PARA_HEADER || h.level !== 0) continue;

    let end = streamLength;
    let hasControls = false;
    for (let j = i + 1; j < headers.length; j++) {
      const next = headers[j];
      if (next.level === 0) {
        end = next.headerOffset;
        break;
      }
      if (next.tagId === TAG_CTRL_HEADER) hasControls = true;
    }

    blocks.push({
      startOffset: h.headerOffset,
      endOffset: end,
      headerIndex: i,
      hasControls,
    });
  }
  return blocks;
}
