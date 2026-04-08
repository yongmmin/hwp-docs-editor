# HWP 문서 에디터

> 팀 내부용 문서 편집 도구입니다.

HWP / HWPX 파일을 브라우저에서 바로 열고 편집할 수 있는 웹 기반 에디터입니다.  
별도 프로그램 설치 없이 한글 문서를 수정하고, 로컬 AI(OLLAMA)를 활용한 한국어 유의어 추천까지 사용할 수 있습니다.

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
2. **편집** — TipTap 에디터에서 텍스트·서식 수정
3. **유의어 추천** — 단어 선택 후 `Ctrl+Space` → 추천 단어 hover로 미리보기, 클릭으로 적용
4. **미리보기** — 헤더의 미리보기 버튼으로 원본 레이아웃 확인 (분할 화면)
5. **내보내기** — 구현 예정 (`.hwpx` 내보내기 개발 중)

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
| HWP / HWPX 파싱 | 표·이미지·머리글/바닥글 포함 렌더링 |
| 리치 텍스트 편집 | 볼드·이탤릭·밑줄·정렬 등 기본 서식 |
| 유의어 추천 | OLLAMA 기반 한국어 단어 추천 |
| 미리보기 | 편집 중 원본 레이아웃 분할 화면 확인 |
| HWPX 내보내기 | 구현 예정 (`.hwpx` 내보내기 개발 중) |
| 찾기/바꾸기 | 문서 내 텍스트 검색 및 일괄 교체 |

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| UI 프레임워크 | React 18, TypeScript |
| 빌드 도구 | Vite 5 |
| 에디터 | TipTap 3 |
| 스타일 | Tailwind CSS 4 |
| 상태 관리 | Zustand |
| HWP 파싱 | 자체 구현 (HWPX: JSZip + fast-xml-parser, HWP 바이너리: cfb + pako) |
| LLM 연동 | OLLAMA (로컬 서버) |

---

## 프로젝트 구조

```
src/
├── components/
│   ├── layout/       # AppShell, Header, Sidebar
│   ├── editor/       # DocumentEditor, EditorToolbar, TipTap 확장
│   ├── preview/      # DocumentPreview
│   ├── upload/       # FileUploader
│   ├── suggestions/  # SuggestionPanel (유의어 추천)
│   └── refinement/   # 찾기/바꾸기
├── hooks/            # 비즈니스 로직 (파일 업로드, 유의어 추천 등)
├── services/
│   ├── hwp/          # HWP·HWPX 파서 및 내보내기
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
