# HWP 문서 에디터

> 팀 내부용 문서 편집 도구입니다.

HWP / HWPX 파일을 브라우저에서 **한글 뷰어에 가까운 레이아웃 그대로** 열고 편집할 수 있는 웹 기반 에디터입니다.  
A4 페이지 분기·여백·표·이미지를 원본과 동일하게 재현하며, 편집 후 원본 포맷(.hwp / .hwpx)으로 그대로 내보냅니다.

---

## 팀원을 위한 사용 안내

### 시작하는 법

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:5173` 접속 후 HWP / HWPX 파일을 드래그 앤 드롭하면 바로 열립니다.

### 주요 사용 흐름

1. **파일 열기** — HWP 또는 HWPX 파일을 화면에 드롭
2. **편집** — A4 페이지 레이아웃 위에서 텍스트·서식 수정 (원본 여백·폰트 유지)
3. **유의어 추천** — 단어 선택 후 `Ctrl+Space` → 추천 단어 hover로 미리보기, 클릭으로 적용
4. **저장** — `Cmd+S` / `Ctrl+S` 로 현재 편집 내용을 문서 스냅샷에 반영
5. **내보내기** — 헤더 `내보내기` 버튼 → 편집 내용이 반영된 `.hwp` / `.hwpx` 다운로드 (원본 포맷 유지)

### 유의어 추천 기능 (OLLAMA)

로컬 LLM 서버인 OLLAMA가 실행 중이어야 유의어 추천이 작동합니다.

```bash
# OLLAMA 설치 후 (https://ollama.com)
ollama pull llama3.2   # 또는 다른 모델

# OLLAMA 서버 실행
ollama serve
```

에디터 헤더에서 사용할 모델을 선택하면 연동됩니다.

---

## 주요 기능

| 기능 | 설명 |
|------|------|
| 원본 충실 파싱 | pyhwp ODT 브리지 + 자체 파서로 표·이미지·폰트·여백을 원본 그대로 재현 |
| A4 페이지 레이아웃 | 문서 원본의 페이지 크기·상하좌우 여백을 반영한 A4 프레임 렌더링 |
| 자동 페이지 분기 | 내용이 넘칠 때 자동으로 다음 페이지 생성, 강제 페이지 나누기(hr) 지원 |
| 리치 텍스트 편집 | 볼드·이탤릭·밑줄·정렬 등 기본 서식 편집 |
| HWP / HWPX 내보내기 | 원본 바이트 유지 + 편집된 단락만 in-place 패치 (포맷 변환 없음) |
| 유의어 추천 | OLLAMA 기반 한국어 단어 추천 |
| 찾기/바꾸기 | 문서 내 텍스트 검색 및 일괄 교체 |

---

## 원본 충실도 목표

이 에디터의 핵심 목표는 **"한글 뷰어에서 보는 것과 동일한 화면"** 입니다.

### 뷰어 레이아웃 재현
- 문서에 지정된 **페이지 크기와 상하좌우 여백**을 CSS 변수로 추출해 에디터에 그대로 적용합니다.
- 여백 내부 영역에만 텍스트·표·이미지가 배치되고, 내용이 넘치면 **자동으로 다음 A4 페이지**를 생성합니다.
- 강제 페이지 나누기(`<text:soft-page-break>`) 위치도 원본과 동일하게 반영합니다.

### 편집 후 내보내기 충실도
- **HWPX**: 원본 zip을 그대로 유지하고 편집된 단락의 `<hp:t>` 텍스트만 교체합니다.
- **HWP(5)**: 원본 OLE2 바이너리를 유지하고 BodyText 스트림의 `PARA_TEXT` 레코드만 in-place 패치합니다.
- 편집하지 않은 바이트는 복사·재압축 없이 원본 그대로 보존합니다.
- 매칭은 ODT 파이프라인 기준 텍스트 스냅샷으로 비교해 파이프라인 간 정규화 불일치를 방지합니다.

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| UI 프레임워크 | React 18, TypeScript |
| 빌드 도구 | Vite 5 |
| 에디터 | TipTap 3 |
| 스타일 | Tailwind CSS 4 |
| 상태 관리 | Zustand |
| HWP 파싱 | 자체 구현 (HWPX: JSZip + fast-xml-parser, HWP: pyhwp ODT 브리지 + cfb/pako) |
| 페이지 레이아웃 | ResizeObserver + MutationObserver 기반 런타임 페이지 분기 |
| LLM 연동 | OLLAMA (로컬 서버) |

---

## 프로젝트 구조

```
src/
├── components/
│   ├── layout/       # AppShell, Header, Sidebar
│   ├── editor/       # DocumentEditor, usePageBreaks, TipTap 확장
│   ├── preview/      # DocumentPreview
│   ├── upload/       # FileUploader
│   ├── suggestions/  # SuggestionPanel (유의어 추천)
│   └── refinement/   # 찾기/바꾸기
├── hooks/            # 비즈니스 로직 (파일 업로드, 유의어 추천 등)
├── services/
│   ├── hwp/          # HWP·HWPX 파서 (파싱 + 페이지 레이아웃 추출)
│   ├── export/       # HWP·HWPX in-place 내보내기 파이프라인
│   └── ollama/       # OLLAMA API 클라이언트
├── stores/           # Zustand 전역 상태
├── types/            # 공유 타입 정의
└── utils/            # 순수 유틸리티 함수

scripts/              # HWP 파싱 품질 검사·회귀 테스트 스크립트
docs/                 # 아키텍처·기술 결정 문서
knowledge/            # Claude Code 프로젝트 지식베이스 (AI 컨텍스트용)
```

---

## 개발 문서

- [아키텍처 개요](docs/ARCHITECTURE.md)
- [HWP 파싱 상세](docs/HWP_PARSING.md)
- [레이아웃 보존 전략](docs/LAYOUT_PRESERVATION_STRATEGY.md)
- [기술 결정 기록](docs/TECHNICAL_DECISIONS.md)
- [개발 가이드](docs/DEVELOPMENT_GUIDE.md)
- [로드맵](docs/ROADMAP.md)

---

## 개발 참고

### HWP 파싱 품질 확인

```bash
npm run quality:hwp       # 단일 파일 품질 리포트
npm run regression:hwp    # 회귀 테스트 (이전 결과와 비교)
```

### 빌드

```bash
npm run build     # 프로덕션 빌드 (dist/ 생성)
npm run preview   # 빌드 결과 로컬 미리보기
```

---

> 이 프로젝트는 [Claude Code](https://claude.ai/code)와 함께 개발되었습니다.
