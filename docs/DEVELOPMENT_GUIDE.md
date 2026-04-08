# Development Guide

## 사전 요구사항

| 도구 | 버전 | 용도 |
|------|------|------|
| Node.js | 20+ | 런타임 |
| npm | 10+ | 패키지 관리 |
| OLLAMA | 0.1.29+ | 로컬 LLM (선택) |

---

## 초기 설정

```bash
# 의존성 설치
npm install

# 개발 서버 시작
npm run dev
```

앱은 `http://localhost:5173`에서 실행됨.

---

## OLLAMA 설정 (선택)

단어 추천 기능을 사용하려면 OLLAMA가 필요.

```bash
# OLLAMA 설치 (macOS)
brew install ollama

# 모델 다운로드 (예: llama3)
ollama pull llama3

# 서버 실행
ollama serve
```

앱이 `http://localhost:11434`로 자동 연결을 시도함.
Header 우측의 연결 상태 아이콘으로 확인.

### CORS 문제 발생 시

```bash
OLLAMA_ORIGINS=* ollama serve
```

---

## 스크립트

| 명령어 | 설명 |
|--------|------|
| `npm run dev` | 개발 서버 (HMR) |
| `npm run build` | 프로덕션 빌드 |
| `npm run preview` | 빌드 결과 미리보기 |
| `npm run lint` | ESLint 실행 |
| `npm run bridge:hwp` | 로컬 HWP 원본 렌더 브리지 실행 (`127.0.0.1:3210`) |
| `npm run quality:hwp -- <file.hwp>` | 단일 HWP 품질 계측 리포트 생성 |
| `npm run regression:hwp -- <dir>` | 디렉터리 HWP 회귀 계측 실행 |

---

## 프로젝트 구조

```
src/
├── main.tsx                    # 진입점
├── App.tsx                     # 루트 컴포넌트
├── index.css                   # Tailwind + 에디터 스타일
├── components/
│   ├── layout/                 # AppShell, Header, Sidebar
│   ├── upload/                 # FileUploader
│   ├── editor/                 # DocumentEditor, EditorToolbar
│   │   └── extensions/         # TipTap 확장
│   ├── suggestions/            # SuggestionPanel, SuggestionItem
│   └── refinement/             # RefinementPanel
├── services/
│   ├── hwp/                    # HWP/HWPX 파싱/내보내기
│   └── ollama/                 # OLLAMA API 클라이언트
├── stores/                     # Zustand 상태
├── hooks/                      # 커스텀 훅
├── utils/                      # 유틸리티
└── types/                      # 타입 정의
```

---

## 개발 워크플로우

### 레이아웃 이슈 대응 원칙

- 원칙: 편집 파서(`src/services/hwp/*`)와 원본 보기 레이어를 분리한다.
- 목표: `원본 보기`는 시각 보존 우선, `편집 보기`는 수정 안정성 우선.
- `.hwp`는 브리지(`hwp5html`)를 통해 원본 보기 HTML을 보강할 수 있다.
- 전략 문서: [LAYOUT_PRESERVATION_STRATEGY.md](./LAYOUT_PRESERVATION_STRATEGY.md)

### 새 컴포넌트 추가

1. `src/components/` 하위 적절한 디렉토리에 생성
2. 비즈니스 로직이 필요하면 `src/hooks/`에 커스텀 훅 분리
3. 외부 API 호출은 `src/services/`에 격리

### 상태 추가

- 컴포넌트 로컬 상태: `useState`
- 여러 컴포넌트 공유 상태: Zustand store
- Store 추가 시 `src/stores/`에 파일 생성

### TipTap 확장 추가

1. `src/components/editor/extensions/`에 Extension 파일 생성
2. `DocumentEditor.tsx`의 `useEditor` extensions 배열에 추가

---

## 키보드 단축키

| 단축키 | 동작 |
|--------|------|
| `Ctrl+Space` | 선택된 단어의 유의어 추천 |
| `Escape` | 추천 패널 닫기 |
| `Ctrl+Z` | 실행취소 |
| `Ctrl+Y` / `Ctrl+Shift+Z` | 다시실행 |
| `Ctrl+B` | 굵게 |
| `Ctrl+I` | 기울임 |
| `Ctrl+U` | 밑줄 |

---

## 테스트 방법

### 파싱 테스트
1. `.hwpx` 또는 `.hwp` 파일을 드래그앤드롭
2. 텍스트와 기본 서식이 에디터에 정상 로드되는지 확인
3. 표가 에디터/미리보기에서 구조를 유지하는지 확인
4. 이미지가 깨지지 않고 표시되는지 확인
5. 머리글/바닥글이 `문서 영역` 블록으로 표시되는지 확인

### 현재 알려진 제한

- HWPX 업로드 시 표 / 이미지 / 머리글 / 바닥글 표시를 우선 지원
- HWPX 재내보내기는 원본 ZIP을 유지한 채 문단 텍스트를 패치하는 방식이라 기존 표 / 이미지 / 머리글 / 바닥글 보존에 유리함
- 다만 새 이미지 삽입 / 새 표 생성 / 큰 구조 변경은 아직 완전 미지원
- HWP 바이너리(`.hwp`)의 머리글/바닥글은 아직 미지원
- `.hwp` 내보내기는 여전히 최소 HWPX fallback 경로 사용
- 차트 / OLE / 수식 / 복합 도형은 일부 문서에서 누락될 수 있음

### OLLAMA 테스트
1. `ollama serve` 실행 확인
2. 에디터에서 단어 드래그 선택
3. `Ctrl+Space` 또는 "추천" 버튼 클릭
4. SuggestionPanel에 유의어 목록 표시 확인
5. 항목 hover → 미리보기, 클릭 → [적용] → 에디터 반영 확인

### 내보내기 테스트
1. 문서 편집 후 "내보내기" 클릭
2. 다운로드된 `.hwpx` 파일을 한글 프로그램에서 열기
3. 편집 내용 반영 확인
