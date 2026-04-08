# HWP/HWPX 파싱 전략

## 파일 포맷 구분

| 포맷 | 매직바이트 | 구조 | 파서 |
|------|-----------|------|------|
| **HWPX** | `50 4B 03 04` (ZIP) | ZIP → XML | `hwpxParser.ts` |
| **HWP** | `D0 CF 11 E0` (OLE2) | CFB 바이너리 | `hwpLegacyParser.ts` |

파일 업로드 시 `hwpParser.ts`의 `detectFormat()`이 매직바이트를 먼저 확인하고, 실패 시 확장자로 폴백.

---

## HWP 바이너리 파싱 (`hwpLegacyParser.ts`)

### 의존성

| 패키지 | 용도 |
|--------|------|
| `cfb` | OLE2/CFB 컴파운드 파일 구조 파싱 |
| `pako` | HWP 스트림 압축 해제 (raw deflate) |

런타임 파서는 `cfb + pako` 기반의 자체 구현을 유지하되, `hwp.js`의 파싱 구조(`DocInfoParser`/`SectionParser`/`viewer`)를 레퍼런스로 삼아 바이너리 필드 오프셋과 스타일 매핑을 동기화.

### 원본 보기 브리지 (선택)

원본 보기 정확도를 높이기 위해 로컬 브리지를 사용할 수 있음.

- 실행: `npm run bridge:hwp`
- 엔드포인트: `POST http://127.0.0.1:3210/render-hwp`
- 내부 변환기: `hwp5html` (pyhwp)
- 동작:
  - `.hwp` 업로드 시 기본 파서는 편집용 HTML(`doc.html`)을 생성
  - 브리지 변환이 성공하면 읽기전용 원본 렌더(`doc.originalViewHtml`)를 함께 저장
  - 브리지가 꺼져 있거나 실패하면 자동으로 기존 파서 결과만 사용

### HWP 내부 구조

```
HWP 파일 (OLE2 Compound File)
├── FileHeader          # 버전, 압축 여부 (offset 36, bit 0)
├── DocInfo             # 글꼴, 문자 모양, 문단 모양, BinData 매핑
├── BodyText/
│   ├── Section0        # 본문 섹션 0
│   ├── Section1        # 본문 섹션 1
│   └── ...
├── BinData/
│   ├── BIN0001.png     # 임베디드 이미지
│   ├── BIN0002.jpg
│   └── ...
└── \x05HwpSummaryInformation  # 메타데이터
```

### 압축 처리

```
FileHeader[36] & 0x01 → 압축 여부
압축된 경우: pako.inflateRaw(stream) 시도 → 실패 시 pako.inflate() 폴백
```

### 레코드 구조

각 섹션/DocInfo 스트림은 연속된 레코드로 구성:

```
┌───────────────────────────────┐
│ 4바이트 헤더                    │
│   bits 0-9:   TagID (태그 ID) │
│   bits 10-19: Level (트리 깊이)│
│   bits 20-31: Size (데이터 크기)│
│   (size == 0xFFF → 다음 4바이트가 실제 크기) │
├───────────────────────────────┤
│ Data (size 바이트)             │
└───────────────────────────────┘
```

### 주요 태그 ID

| 상수 | 값 | 용도 | 위치 |
|------|------|------|------|
| TAG_BIN_DATA | 18 | 이미지 바이너리 매핑 | DocInfo |
| TAG_FACE_NAME | 19 | 글꼴명 | DocInfo |
| TAG_CHAR_SHAPE | 21 | 문자 모양 (크기, 굵기, 기울임) | DocInfo |
| TAG_PARA_SHAPE | 25 | 문단 모양 (정렬) | DocInfo |
| TAG_PARA_HEADER | 66 | 문단 시작 | Section |
| TAG_PARA_TEXT | 67 | 문단 텍스트 (UTF-16LE) | Section |
| TAG_PARA_CHAR_SHAPE | 68 | 문자 모양 적용 구간 | Section |
| TAG_CTRL_HEADER | 71 | 컨트롤 (표, 이미지 등) | Section |
| TAG_LIST_HEADER | 72 | 리스트/셀 헤더 | Section |
| TAG_SHAPE_COMPONENT | 76 | 도형 컴포넌트 | Section |
| TAG_TABLE | 77 | 테이블 속성 (행/열 수) | Section |

### 레코드 트리 구조 (Level 기반)

```
L0 PARA_HEADER                    ← 최상위 문단
  L1 PARA_TEXT                    ← 텍스트 내용
  L1 PARA_CHAR_SHAPE              ← 서식 적용 구간
  L1 CTRL_HEADER [tbl ]           ← 테이블 컨트롤
    L2 TABLE                      ← rows/cols 정보
    L2 LIST_HEADER                ← 셀 1 (col, row, colSpan, rowSpan)
    L2 PARA_HEADER                ← 셀 1 내 문단 (LIST_HEADER와 같은 레벨!)
      L3 PARA_TEXT                ← 셀 텍스트
      L3 PARA_CHAR_SHAPE
    L2 LIST_HEADER                ← 셀 2
    L2 PARA_HEADER                ← 셀 2 내 문단
      L3 PARA_TEXT
    ...
  L1 CTRL_HEADER [gso ]           ← 이미지(GSO) 컨트롤
    L2 SHAPE_COMPONENT
    ...
```

**중요**: 셀 내 PARA_HEADER는 LIST_HEADER와 **같은 레벨**에 위치함. 자식-부모 관계가 아님.

### 테이블 파싱 흐름

```
CTRL_HEADER [tbl] 발견
  → 자식 범위 계산 (findChildrenEnd)
  → TABLE 레코드에서 nRows, nCols 추출
  → LIST_HEADER 위치 모두 수집 (같은 레벨)
  → 각 LIST_HEADER에서 셀 위치 정보 추출:
      offset 8:  colAddr (UINT16)
      offset 10: rowAddr (UINT16)
      offset 12: colSpan (UINT16)
      offset 14: rowSpan (UINT16)
      offset 16: width (UINT32, HWPUNIT)
      offset 20: height (UINT32, HWPUNIT)
      offset 24~30: padding (UINT16 x4)
      offset 32: borderFillId (UINT16)
  → 연속 LIST_HEADER 사이의 레코드를 셀 내용으로 렌더링
  → header rows/cols와 셀 좌표를 함께 사용해 안전한 track 수 추론
  → 비정상 span/좌표/크기 값은 테이블 경계 내로 정규화
  → 셀 width/height + colspan/rowspan 제약으로 열폭/행높이 계산
  → 페이지 콘텐츠 폭을 넘는 경우 테이블 폭과 열폭을 같이 축소
  → <table data-hwp-col-widths="..."><colgroup>...</colgroup> 생성
  → <td colspan="N" rowspan="N" style="width:...pt;height:...pt"> 생성
```

### 다중 테이블 처리

하나의 L0 PARA_HEADER에 여러 CTRL_HEADER[tbl]이 포함될 수 있음:
```
L0 PARA_HEADER
  L1 CTRL_HEADER [tbl]   ← 테이블 A
    L2 ...
  L1 CTRL_HEADER [tbl]   ← 테이블 B (같은 문단!)
    L2 ...
```
→ 모든 tbl 인덱스를 배열로 수집 후 순서대로 렌더링.

### 텍스트 추출 (PARA_TEXT)

UTF-16LE 바이트 스캔:
- `0x00` → 스킵 (2바이트, 추가 데이터 없음)
- `0x09` (TAB) → `\t` 출력 + 14바이트 파라미터 건너뜀 (16바이트 확장 제어)
- `0x0A`, `0x0D` → `\n` 출력 (2바이트만, 추가 데이터 없음)
- `0x01~0x08`, `0x0B~0x0C`, `0x0E~0x17` → 16바이트 확장 제어 (2바이트 코드 + 14바이트 파라미터)
- `0x18~0x1F` → 2바이트만 (char controls, 추가 데이터 없음), logicalPos +1
- `0x20+` → 실제 문자

**중요**: `0x09` (TAB)는 16바이트 확장 제어이므로 14바이트 파라미터를 건너뛴 후 `\t`를 출력해야 함.
`0x18~0x1F`는 추가 데이터 없이 2바이트만 차지하며, logicalPos 매핑 정확도를 위해 +1 처리.

### 이미지 파싱

1. **DocInfo BIN_DATA (tag 18)** 레코드에서 `binDataId ↔ 확장자` 매핑 구축
2. **BinData 디렉토리**에서 `BIN{hex(binDataId)}.{ext}` 파일을 찾아 base64 data URL 변환
3. **GSO 이미지 참조 해석**:
   - 우선 `TAG_SHAPE_PICTURE(85)`의 offset 70에서 `packedId`를 읽어 `packedId >> 8`을 binDataId로 사용
   - fallback으로 `GSO CTRL_HEADER` offset 24 사용
4. `images` Map의 키는 `binDataId` 그대로 사용 (`idx+1` 가정 제거)
5. 매우 큰 이미지(12MB 초과)만 메모리 절약을 위해 스킵
6. 해석 불가능한 도형/이미지는 placeholder 대신 렌더링 스킵
7. `TAG_SHAPE_COMPONENT(76)`에서 폭/높이(HWPUNIT) 추출 후 px로 변환해 이미지 크기 힌트로 사용
8. `TAG_SHAPE_COMPONENT(76)`의 오프셋(20/24)을 x/y 배치 힌트로 해석해 top-level GSO에 `margin-left/top` 적용
9. 표 셀 내부 GSO는 배치 힌트를 적용하지 않고 셀 레이아웃 우선 유지
10. 같은 문단 내 다중 GSO가 세로로 무너지는 문제를 줄이기 위해 이미지를 `inline-block` 기반으로 렌더링

### CharShape / ParaShape 적용

- DocInfo의 CHAR_SHAPE(tag 21) 레코드를 배열로 파싱 (ID = 배열 인덱스)
- PARA_CHAR_SHAPE(tag 68)에서 `{pos, charShapeId}` 쌍 추출
- 텍스트를 charShape 구간별로 분할 후 `<strong>`, `<em>`, `<u>`, `<s>`, `font-size` 적용
  - 기본 폰트 크기(10pt)는 생략
- ParaShape(tag 25)에서 정렬 정보 추출 → `text-align` 적용 (left는 생략, justify 포함)
- ParaShape(tag 25)의 줄간격 비율(예: 160%)을 `line-height`로 반영
- ParaShape(tag 25)의 문단 여백/들여쓰기를 `margin-*`, `text-indent`로 반영 (±1px 미만은 생략)
- 문단 텍스트 내 제어 줄바꿈(`0x0D`, `0x0A`)을 `<br/>`로 보존
- 탭 문자(`0x09`)를 `\t`로 추출 후 `&emsp;`로 렌더링

#### secd/cold 문단 처리

- `secd`(섹션 정의), `cold`(단 정의) 제어가 포함된 문단에서 가시 텍스트는 보존
- 이전: 해당 문단 텍스트 전체 버림 → 현재: 텍스트가 있으면 렌더링 후 스킵

#### 테이블 포함 문단의 텍스트

- 동일 문단에 표 제어(`tbl`)와 텍스트가 함께 있는 경우, 텍스트를 표 앞에 출력
- 이전: 표만 출력하고 텍스트 버림 → 현재: 텍스트 + 표 순서로 출력

### 표 스타일(고도화)

- LIST_HEADER(tag 72) 오프셋 24/26/28/30에서 셀 내부 여백을 읽어 `padding-*` 반영
- LIST_HEADER(tag 72) 오프셋 32를 `borderFillId`로 해석해 BORDER_FILL(tag 20)과 연결
- BORDER_FILL(tag 20)을 `hwp.js`와 동일한 구조로 파싱:
  - `attribute(u16)`
  - `left/right/top/bottom: type(u8), width(u8), color(u32 COLORREF)`
  - skip 6 bytes
  - `fillType == 0x1(Single)`이면 배경색 1개 추가 파싱
- border CSS는 shorthand로 최소화:
  - 4방향 모두 동일: `border:Wpx style color` 단일 속성
  - 방향별 차이: `border-{side}:Wpx style color` 방향별 shorthand
  - `type=0`(none)인 면은 완전히 생략
- 선 두께 코드는 `hwp.js` viewer의 mm 매핑(0.1~5.0mm)을 px로 변환해 적용
- TABLE(tag 77)에서 테이블 기본 `borderFillId`를 읽어, 셀 borderFill이 없을 때 폴백 적용
- 테이블은 즉시 HTML 생성 대신 중간 모델(`TableModel`)로 먼저 수집한 뒤 렌더링하여
  파싱 단계와 렌더 단계를 분리

#### 표 너비/레이아웃 (오버플로우 방지)

- TABLE CTRL_HEADER의 `width(pt*100)`와 `PAGE_DEF` 기반 실제 페이지 콘텐츠 폭을 함께 사용
- 표 폭은 다음 우선순위로 결정:
  - `CTRL_HEADER.tableWidthPt`
  - 셀 제약으로 푼 열폭 합
  - fallback 콘텐츠 폭
- 블록 표는 `hRelTo/hAlign/x/margin-left/right`를 읽어 `margin-left`를 계산
- `margin-left + table width`가 페이지 콘텐츠 폭을 넘으면 렌더 폭을 다시 clamp
- 열폭은 `%`가 아니라 `pt` 단위 `colgroup` + 셀 `width`로 같이 출력
- 에디터에서는 `data-hwp-col-widths`를 보존해 TipTap이 다시 `colgroup`를 렌더함
- 비정상 span/width 때문에 생기는 `200열` 표 확장과 대량 filler 셀은 정규화 단계에서 차단

#### 비정상 셀 값 방어

- 일부 실문서에서 `LIST_HEADER.colSpan=8504`, `width=3150446592` 같은 깨진 값이 관찰됨
- 이러한 값은 그대로 쓰면 `inferredCols`가 폭증하고 빈 `&nbsp;` 셀이 대량 생성됨
- 현재는 다음 규칙으로 방어:
  - span은 header `nCols/nRows` 또는 보수적인 fallback 범위 안으로 clamp
  - 셀 width/height가 비정상적으로 큰 경우 track 계산에서 제외
  - 최종 `normalizeCellInfos()`에서 표 경계를 넘는 셀은 다시 잘라냄

#### TipTap 테이블 노드와 폭 보존

- 기본 TipTap table 파싱은 `tbody`만 콘텐츠로 유지하므로 `colgroup`가 쉽게 손실됨
- 프로젝트의 커스텀 `Table` 노드는:
  - `data-hwp-col-widths` 속성을 보존하고
  - 렌더 시 이를 다시 `colgroup`로 복원하여
  - `setContent()` 이후에도 HWP 열 폭 힌트가 유지되도록 한다

### 페이지 분리 처리

- `CTRL_HEADER`의 `pghd`, `nwno` 제어를 페이지 분리 신호로 해석
- 문단 내 `pghd`/`nwno`가 감지되면 `<hr class="hwp-page-break" />`를 삽입
- **섹션 간 자동 페이지 분리**: `renderAllSections`에서 Section0, Section1... 각 섹션 경계에도 `<hr class="hwp-page-break" />` 삽입 (첫 섹션 제외)
- 웹 편집기에서 페이지 경계를 시각화

### 문단/도형 배치(고도화)

- PARA_SHAPE(tag 25)에서 문단 여백/들여쓰기 후보 필드를 읽어
  `margin-left/right/top/bottom`, `text-indent`로 반영
- GSO CTRL_HEADER 공통 컨트롤의 앵커 속성(`hRelTo`, `vRelTo`, `textFlowMethod`)과
  `vertical/horizontal offset`을 읽어 이미지 배치 힌트에 반영

---

## 품질 측정/회귀

- `npm run quality:hwp -- <file.hwp>`
  - 기준 렌더(`hwp5html`)와 파서 렌더를 같은 파일로 계측해 점수 산출
  - 결과 저장: `docs/quality-report.latest.json`
- `npm run regression:hwp -- <dir>`
  - 디렉터리 내 `.hwp` 전체를 일괄 계측
  - 결과 저장: `docs/quality-regression.latest.json`

현재 점수는 “시각 동등성”이 아니라 구조/스타일 계측 기반 지표이며, 고도화 우선순위 결정을 위한 품질 가드레일로 사용.

---

## HWPX 파싱 (`hwpxParser.ts`)

### HWPX 내부 구조

```
document.hwpx (ZIP)
├── mimetype                    # "application/hwp+zip"
├── META-INF/
│   └── container.xml           # 루트 파일 포인터
├── Contents/
│   ├── content.hpf             # 매니페스트
│   ├── sec0.xml                # 섹션 0 (본문)
│   └── ...
├── BinData/                    # 이미지 등 바이너리
└── settings.xml                # 문서 설정
```

### 파싱 흐름

```
ArrayBuffer
  → JSZip.loadAsync()
  → META-INF / content.hpf에서 메타데이터 + XML 참조 수집
  → BinData/* 이미지 파일 → base64 data URL 매핑
  → fast-xml-parser(preserveOrder)로 XML 순서 보존 파싱
  → 섹션 / 머리글 / 바닥글 XML을 순서대로 렌더링
  → paragraph / table / image / region 블록을 HTML로 변환
```

### 현재 구현 범위

- 본문 섹션(`secN.xml`, `sectionN.xml`) 순차 파싱
- `content.hpf`에 기록된 XML 참조 순서를 우선 사용하고, 파일명 패턴으로 폴백
- 머리글/바닥글 XML을 찾아 `section[data-doc-region]` 블록으로 래핑
- `BinData/*` 이미지와 `content.hpf` 매니페스트의 id/href를 연결해 `<img>`로 변환
- `hp:tbl` / `hp:tr` / `hp:tc` 기반 표를 HTML `<table>`로 변환
- 기본 인라인 서식(`bold`, `italic`, `underline`, `strikethrough`, `font-size`)과 문단 정렬 반영

### HWPX 이미지 처리

1. ZIP 내부 `BinData/*.{png,jpg,jpeg,gif,bmp,webp,svg}` 파일을 스캔
2. 5MB 이하 이미지는 base64 data URL로 변환
3. `content.hpf`의 `id ↔ href` 참조를 읽어 이미지 alias를 구축
4. XML 노드의 `binaryItemIDRef`, `href`, `src`, `idref` 등을 이용해 실제 이미지 소스를 찾음

### HWPX 표 처리

```
hp:tbl
  → hp:tr 단위로 행 수집
  → hp:tc / td / th 단위로 셀 수집
  → colspan / rowspan 속성 보존
  → 셀 내부 블록(문단, 이미지, 중첩 구조)을 다시 renderBlocks()로 렌더링
  → HTML <table><tbody><tr><td>...</td></tr></tbody></table> 생성
```

### 에디터 브리지

HWPX 파서가 생성한 구조화 HTML이 TipTap `setContent()`에서 제거되지 않도록 커스텀 노드를 사용:

- `table` / `tableRow` / `tableCell` / `tableHeader`
- `imageBlock`
- `documentRegion` (`header` / `footer`)

### 현재 한계

- HWPX 이미지 **내보내기**는 아직 미구현. 업로드 후 표시/편집은 가능하지만, 다시 HWPX로 저장할 때 BinData 재패키징은 하지 않음
- 차트, OLE 개체, 수식, 복합 도형은 아직 전용 렌더러가 없음
- HWP 바이너리(`.hwp`)의 머리글/바닥글 파싱은 아직 지원하지 않음
- 일부 HWP 이미지 포맷(WMF/EMF 등 브라우저 비지원 포맷)은 웹 뷰에서 표시되지 않을 수 있음

---

## 디버깅/검증 도구

- `scripts/inspect-hwp.mjs`
- 용도: HWP 샘플의 섹션/문단/표/셀/GSO/이미지 개수를 계측하고, GSO별 크기/좌표 힌트/컨트롤 필드를 덤프
- 실행:
  - `node scripts/inspect-hwp.mjs "<path-to-hwp>"`
  - 또는 `npm run inspect:hwp -- "<path-to-hwp>"`
- DocInfo 상세 분석:
  - `node scripts/inspect-docinfo.mjs "<path-to-hwp>"`
  - 또는 `npm run inspect:docinfo -- "<path-to-hwp>"`

---

## HWP ODT 브리지 파이프라인 (`odtParser.ts` + bridge)

`.hwp` 파일의 **1순위 파싱 경로**. JS 바이너리 파서보다 구조적 정확도가 크게 높음.

### 파이프라인 흐름

```
.hwp 업로드
  → ArrayBuffer → base64
  → POST http://127.0.0.1:3210/extract-hwp   (hwp-render-bridge.mjs)
      → pyhwp hwp5odt → out.odt (ZIP)
      → unzip content.xml, styles.xml, bindata/*
      → { contentXml, stylesXml, images: {path → data URI} }
  → odtParser.ts  odtContentToHtml(contentXml, stylesXml, images)
      → collectStyleElements() — para/text/cell/table 스타일 맵 빌드
      → renderNode() 재귀 — HTML 생성
  → TipTap setContent(html)
```

폴백 순서: ODT 성공 → editable; ODT 실패 + read-only render 성공 → hwp-original-readonly; 둘 다 실패 → JS legacy parser.

### pyhwp RelaxNG 검증 패치

일부 HWP 파일이 pyhwp의 RelaxNG 검증 오류로 변환 중단됨.
`/usr/local/lib/.../hwp5/plat/_lxml.py`의 `validating_output()`을 수정해 ValidationFailed를 raise 대신 `logger.warning`으로 처리 후 계속 진행.

> **주의**: `pip install --upgrade pyhwp` 시 패치가 초기화됨. 경로: `/Users/iyongmin/Library/Python/3.10/lib/python/site-packages/hwp5/plat/_lxml.py`

### odtParser.ts — 스타일 파싱

| ODT 패밀리 | 파싱 대상 | 적용처 |
|-----------|---------|-------|
| `paragraph` | `fo:text-align`, `fo:margin-*`, `fo:line-height` | `<p style="...">` |
| `text` | `fo:font-weight/style`, underline, strikethrough, `fo:font-size` | `<strong>/<em>/<u>/<s>/<span>` |
| `table-cell` | `fo:border-*`, `fo:padding-*`, `fo:background-color` | `<td style="...">` |
| `table` | `style:width` | `<table style="width:...">` |

#### 폰트 크기 필터

```
skip regex: /^([89]|1[0-1])(\.\d)?pt$/
```
8–11pt = 한국어 문서 본문 기본 크기 → 브라우저 기본값에 맡김.
12pt 이상 or 7pt 이하만 `font-size` CSS로 출력.

#### 테이블 너비 규칙

```
style:width >= 140mm → width:100%    (페이지 전체 폭 테이블)
style:width < 140mm  → 원래 mm 값   (좁은 섹션 테이블)
스타일 없음           → width:100% (기본값)
```

#### 컬럼 너비 균등 분배

pyhwp는 `table:table-column`의 `number-columns-repeated="N"`만 내보내고 실제 너비는 없음.
이 N을 이용해 동일 너비 `<colgroup>`을 생성하고 `table-layout:fixed`를 적용.
→ HWP의 균등 격자 레이아웃을 근사.

#### 단락 CSS 보존 (커스텀 Paragraph extension)

TipTap 기본 Paragraph는 `<p>` 인라인 스타일을 파싱 단계에서 드롭.
`src/components/editor/extensions/Paragraph.ts`에서 `BaseParagraph`를 확장해 `style` attribute를 보존.
→ `line-height`, `margin-top/bottom` 등이 TipTap document model에 저장되어 에디터 렌더 시에도 반영됨.

StarterKit 설정: `StarterKit.configure({ paragraph: false })` + 커스텀 `Paragraph` 추가.

### 한계

| 항목 | 상태 |
|------|-----|
| 컬럼 별 너비 | pyhwp 미지원 → 균등 근사 |
| 행 높이 | pyhwp ODT에 없음 |
| 절대 위치 도형/플로팅 프레임 | 미지원 (flow 순서로만 출력) |
| 헤더/푸터 | 이미지로 처리된 케이스만 |
| 다단(2-column) 레이아웃 | 플로우로 단순화 |

---

## 내보내기 (`hwpxExporter.ts`)

### 전략

| 원본 포맷 | 내보내기 방식 |
|-----------|-------------|
| HWPX | 원본 ZIP 구조 유지 → 섹션/머리글/바닥글 XML의 문단 텍스트만 순서대로 패치 |
| HWP | 최소 HWPX 구조 신규 생성 |

### HWPX 원본 보존형 내보내기

`rawZipData`가 있으면 에디터 HTML을 그대로 새 HWPX로 재생성하지 않는다.
대신 원본 HWPX 패키지를 다시 열고:

1. `content.hpf`에서 본문 섹션 / 머리글 / 바닥글 XML 경로를 수집
2. 에디터 HTML에서 body / header / footer 영역별 문단 텍스트를 추출
3. 각 XML 파일을 `fast-xml-parser(preserveOrder)`로 파싱
4. 원본 XML의 문단(`hp:p`/`para`)을 순서대로 순회하면서 텍스트 노드만 교체
5. 수정된 XML만 ZIP에 다시 넣어 `.hwpx`로 다운로드
6. 파서가 저장한 파일별 문단 signature와 비교해 변경 없는 XML은 export 시 재파싱을 건너뜀

이 방식의 목적은 다음과 같다.

- 원본 표 구조 유지
- 원본 이미지 / BinData 참조 유지
- 원본 섹션 수 유지
- 원본 머리글 / 바닥글 파일 유지
- 문단 외 레이아웃 정보 손실 최소화

### 현재 한계

- 문단 매핑은 **순서 기반**이라, 에디터에서 문단 수를 크게 바꾸면 새 구조가 완전히 직렬화되지는 않음
- 기존 HWPX의 비텍스트 객체는 유지되지만, **새 이미지 삽입/새 표 생성**은 아직 완전 미지원
- 강한 구조 편집보다 **기존 문서 텍스트 수정**에 최적화된 export 경로
- `.hwp` 원본은 보존형 패치 대상이 아니므로 여전히 최소 HWPX fallback 사용
