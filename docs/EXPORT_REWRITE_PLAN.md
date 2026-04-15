# 내보내기 전면 재작성 계획

> 작성일: 2026-04-15
> 상태: 계획 확정, 구현 진행 중
> 브랜치: `feature/export-improvement`

## 배경

현재 내보내기 기능의 **원본 보존율(fidelity)** 이 허용 불가 수준이다.
업로드/파싱/뷰어 단계는 한글 뷰어와 거의 동일한 수준으로 정교한 반면,
내보낸 파일을 다시 열었을 때 레이아웃·서식이 크게 깨진다.

### 근본 원인

- **HWP 업로드 케이스**: HWP 바이너리 → pyhwp 브리지 → **ODT XML** → HTML → 편집 → ODT를 **HWPX로 재구성**. 두 번의 포맷 변환으로 원본 HWP 렌더링과 구조적으로 일치시킬 수 없음. 원본 HWP 바이너리는 내보내기에 전혀 사용되지 않음.
- **HWPX 업로드 케이스**: 원본 zip을 유지하고 paragraph ID로 텍스트를 패치하는 구조는 맞지만, 매칭 로직과 XML 재빌드 경로(1,500줄) 안에 버그가 누적되어 있음.
- 공통: `src/services/hwp/hwpxExporter.ts` 1,525줄 + `src/services/hwp/exportPlan.ts` 132줄의 복잡한 파이프라인이 유지보수 불가능한 상태.

## 목표

**"뷰어에서 보고 있는 한글 파일과 거의 동일한 화면을, 내보낸 파일을 다시 열었을 때도 동일하게 볼 수 있다"** 를 성능 목표로 정의한다.
출력 속도가 아닌 **원본 보존율**이 핵심 지표.

## 핵심 원칙

> **"원본 바이트를 최대한 그대로 두고, 편집된 단락만 in-place로 패치한다"**

전체 섹션을 재생성하지 않는다. 편집되지 않은 바이트는 **복사도 재압축도 없이 원본 그대로** 유지한다.

## 스코프

### 포함
- HWPX 업로드 → HWPX 내보내기 (원본 zip 유지 + 섹션 XML 미세 편집)
- HWP 업로드 → HWP 내보내기 (원본 OLE2 바이너리 유지 + BodyText 스트림 in-place 패치)
- 단락 편집(텍스트 수정), 단락 삽입, 단락 삭제

### 제외 (명시적으로 포기)
- **컨트롤(표·이미지·도형·OLE 객체)을 포함한 단락은 편집 대상에서 제외**. 원본 바이트 그대로 유지한다. 사용자가 컨트롤 내부 텍스트를 편집한 경우도 현재 단계에서는 패치하지 않는다(후속 이터레이션 과제).
- **LINE_SEG 레코드 재계산 안 함.** 한글 뷰어가 열 때 자동 재배치하는 것을 기대. 만약 뷰어가 LINE_SEG를 신뢰해 깨지는 것이 확인되면, 해당 레코드를 삭제해 reflow를 강제한다.
- **CharShape 세부 재매핑 안 함.** 단락 내 텍스트 편집 시 마지막 run의 char shape가 남은 텍스트를 흡수한다.
- 출력 포맷 신규 추가(PDF·DOCX 등)는 범위 밖.

## 아키텍처

### HWPX 내보내기 전략

1. 파서가 각 `<hp:p>`에 고유 ID를 부여 (이미 `data-hwp-para-id`로 존재)
2. 내보내기:
   - 원본 zip을 JSZip으로 로드
   - 섹션 XML을 **부분 편집**: 문자열 단위로 편집 대상 단락의 `<hp:run>`/`<hp:t>`만 교체. 전체 XML 재빌드 금지
   - 새로 삽입된 단락은 직전 단락의 `charPrIDRef`/`paraPrIDRef`를 상속해 클론
   - 삭제된 단락은 해당 `<hp:p>` 블록을 원본에서 제거
   - 편집되지 않은 zip entry는 **원본 바이트 그대로** 재사용 (JSZip이 재압축하지 않도록 처리)

### HWP5 내보내기 전략

1. 파서가 HWP5 바이너리를 파싱할 때 각 단락의 **레코드 바이트 offset/length** 메타데이터를 수집해 `rawHwpBuffer`와 함께 저장
2. 내보내기:
   - `cfb.read()`로 원본 OLE2 compound file 로드
   - `BodyText/Section#` 스트림을 `pako.inflateRaw`로 압축 해제
   - 레코드 헤더 규칙: 32비트 헤더 = `tag(10) | level(10) | size(12)`. size == 0xFFF이면 다음 4바이트가 실제 size
   - 핵심 레코드:
     - `HWPTAG_PARA_HEADER` (0x42)
     - `HWPTAG_PARA_TEXT` (0x43) — 본문 UTF-16LE
     - `HWPTAG_PARA_CHAR_SHAPE` (0x44)
     - `HWPTAG_PARA_LINE_SEG` (0x45)
     - `HWPTAG_CTRL_HEADER` (0x46)
   - **편집되지 않은 단락 = 원본 레코드 바이트 그대로 복사**
   - 편집된 단락 = `PARA_TEXT` 레코드의 UTF-16LE 본문만 교체, 헤더 size 필드 업데이트, `PARA_CHAR_SHAPE`의 마지막 range endpos를 새 텍스트 길이로 보정
   - 새 단락 = 직전 원본 단락의 `PARA_HEADER`/`CHAR_SHAPE`/`LINE_SEG`를 복제 후 텍스트 교체
   - 삭제 단락 = 해당 레코드 바이트 스킵
   - `pako.deflateRaw`로 재압축 → `cfb.write()`로 OLE2 재직렬화

## 파일 변경

### 삭제
- `src/services/hwp/hwpxExporter.ts` (1,525줄)
- `src/services/hwp/exportPlan.ts` (132줄)

### 신규
- `src/services/export/index.ts` — 단일 진입점 `exportDocument(editor, doc)`
- `src/services/export/hwpxWriter.ts`
- `src/services/export/hwp5Writer.ts`
- `src/services/export/hwp5Records.ts` — HWP5 레코드 파싱/직렬화 유틸
- `src/services/export/paragraphMatch.ts` — TipTap JSON ↔ 원본 단락 메타 매칭

### 수정
- `src/services/hwp/hwpxParser.ts` — 복잡한 export 메타데이터 수집 제거, 최소 메타(섹션 경로, paragraph ID 순서)만 남김
- `src/services/hwp/hwpLegacyParser.ts` — 파싱 중 단락 레코드 offset 수집, `rawHwpBuffer` + `hwpParagraphMap` 반환
- `src/services/hwp/hwpParser.ts` — ODT 기반 export 경로 제거, HWP 원본 바이트 통과
- `src/types/index.ts` — `HwpxExportContext` · `HwpxExportPlanEntry` 삭제, 새 메타데이터 타입 추가
- `src/components/layout/AppShell.tsx` — `editor.getJSON()` 사용, 기존 `.tiptap` innerHTML 경로 제거
- `src/utils/file.ts` — `getExportFilename`이 원본 포맷(hwp/hwpx)별 확장자 유지

## 실행 단계

1. 기존 exporter · 관련 의존 코드 삭제
2. `types/index.ts` 정리
3. 파서 측 메타데이터 수집 로직 추가 (`hwpxParser.ts` / `hwpLegacyParser.ts`)
4. `hwp5Records.ts` — HWP5 레코드 파서 유틸
5. `hwpxWriter.ts` 구현
6. `hwp5Writer.ts` 구현
7. `export/index.ts` + `AppShell.tsx` 배선
8. 기준 파일 `public/공동마케팅 수요협약서.hwp`로 수동 검증

각 단계 끝에서 커밋을 찍는다.

## 리스크 · 대응

| 리스크 | 대응 |
|---|---|
| LINE_SEG 미갱신으로 뷰어가 오렌더링 | 해당 레코드 삭제 전략으로 전환 |
| CharShape range 범위 초과 | 마지막 range endpos만 보정, 나머지는 유지 |
| 컨트롤 포함 단락에서 사용자가 텍스트 편집 | 경고 후 원본 유지. 후속 이터레이션에서 핸들링 |
| cfb.write 결과를 한글 뷰어가 거부 | OLE2 minor version, sector 크기 등을 원본과 동일하게 강제 |
| HWPX `<hp:p>` 블록 경계 검출 실패 | 파서 측에서 ID별 byte offset을 기록해 위치 기반 치환 |

## 검증 기준

- 기준 문서: `public/공동마케팅 수요협약서.hwp`
- 성공 조건: 업로드 → 편집기에서 한 단락의 텍스트를 수정 → 내보내기 → 한글 뷰어에서 열기 → **레이아웃·서식·표 위치 모두 원본과 동일**, 편집한 단락만 새 텍스트로 반영
- 회귀: HWPX 파일도 동일 과정으로 확인
