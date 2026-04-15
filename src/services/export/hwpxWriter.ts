import type { JSONContent } from '@tiptap/react';
import type { HwpxExportMeta } from '../../types';

/**
 * HWPX writer — patches section XML inside the original zip in place.
 *
 * TODO (2단계): 실제 구현
 *   1. JSZip으로 원본 zip 로드
 *   2. hwpxExportMeta.sectionPaths를 돌며 섹션 XML 로드
 *   3. TipTap JSON을 walk하면서 편집된 단락만 <hp:p> 영역을 부분 치환
 *      - 원본 XML 문자열에서 `<hp:p ... id="X" ... >...</hp:p>` 블록을 찾고
 *        해당 paragraph의 run 텍스트만 교체
 *   4. 새 단락은 직전 단락의 구조를 복제, 삭제 단락은 블록 제거
 *   5. 편집되지 않은 zip entry는 원본 바이트 그대로 재사용
 *   6. 최종 zip을 blob으로 반환
 */
export async function writeHwpx(
  _json: JSONContent,
  _originalZipData: ArrayBuffer,
  _meta: HwpxExportMeta | undefined
): Promise<Blob> {
  throw new Error(
    'HWPX 내보내기는 재작성 진행 중입니다. (docs/EXPORT_REWRITE_PLAN.md)'
  );
}
