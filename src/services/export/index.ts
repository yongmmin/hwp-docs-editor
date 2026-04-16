import type { Editor } from '@tiptap/react';
import type { ParsedDocument } from '../../types';
import { writeHwpx } from './hwpxWriter';
import { writeHwp5 } from './hwp5Writer';

/**
 * Single entry point for document export.
 *
 * Fidelity strategy: keep the original bytes intact and patch only
 * edited paragraphs in place. HWPX rewrites section XML inside the
 * original zip; HWP5 patches BodyText records inside the original
 * OLE2 compound file. No format conversion, no regeneration.
 */
export async function exportDocument(
  editor: Editor,
  doc: ParsedDocument
): Promise<{ blob: Blob; format: 'hwp' | 'hwpx' }> {
  const json = editor.getJSON();

  if (doc.originalFormat === 'hwpx') {
    if (!doc.rawZipData) {
      throw new Error('HWPX 내보내기: 원본 zip 데이터가 없습니다.');
    }
    const blob = await writeHwpx(json, doc.rawZipData, doc.hwpxExportMeta);
    return { blob, format: 'hwpx' };
  }

  if (doc.originalFormat === 'hwp') {
    if (!doc.rawHwpBuffer) {
      throw new Error('HWP 내보내기: 원본 바이너리가 없습니다.');
    }
    const blob = await writeHwp5(json, doc.rawHwpBuffer, doc.hwp5ExportMeta);
    return { blob, format: 'hwp' };
  }

  throw new Error(`지원하지 않는 포맷: ${doc.originalFormat}`);
}
