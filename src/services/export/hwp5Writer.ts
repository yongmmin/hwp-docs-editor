import type { JSONContent } from '@tiptap/react';
import type { Hwp5ExportMeta } from '../../types';

/**
 * HWP5 writer — patches BodyText records inside the original OLE2 file.
 *
 * TODO (3단계): 실제 구현
 *   1. cfb.read()로 원본 OLE2 로드
 *   2. BodyText/Section# 스트림 순회
 *   3. 스트림을 pako.inflateRaw로 압축 해제
 *   4. hwp5ExportMeta.paragraphs의 바이트 offset을 기준으로 원본 레코드를
 *      단락 단위로 쪼갬
 *   5. TipTap JSON paragraph 순서와 매칭:
 *      - 매칭된 단락: HWPTAG_PARA_TEXT(0x43)의 UTF-16LE 본문만 교체,
 *        레코드 헤더 size 필드 업데이트, CHAR_SHAPE 마지막 range endpos 보정
 *      - 새 단락: 직전 원본 단락 레코드들을 복제 후 텍스트 교체
 *      - 삭제 단락: 해당 레코드 바이트 스킵
 *      - 컨트롤 포함 단락: 원본 바이트 유지
 *   6. pako.deflateRaw로 재압축 → cfb.write()로 OLE2 재직렬화
 */
export async function writeHwp5(
  _json: JSONContent,
  _originalBuffer: ArrayBuffer,
  _meta: Hwp5ExportMeta | undefined
): Promise<Blob> {
  throw new Error(
    'HWP 내보내기는 재작성 진행 중입니다. (docs/EXPORT_REWRITE_PLAN.md)'
  );
}
