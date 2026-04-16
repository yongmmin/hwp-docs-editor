# Roadmap

## 제품 방향(고정)

- [x] 레이아웃 보존 개선은 **현재 웹 에디터 파서 고도화** 방식으로 진행
- [x] 외부 변환기 기반 원본 뷰어 분리 방식은 채택하지 않음
- [x] 세부 기준 문서: [LAYOUT_PRESERVATION_STRATEGY.md](./LAYOUT_PRESERVATION_STRATEGY.md)

## 현재 상태: MVP+

기본 워크플로우 완성:
- [x] HWP/HWPX 파일 업로드 및 파싱
- [x] TipTap 에디터 (기본 서식)
- [x] OLLAMA 연동 유의어 추천
- [x] 추천 패널 (hover 미리보기, 적용)
- [x] HWPX 내보내기 (원본 ZIP 구조 보존형, 텍스트 ID 기반 패치)
- [x] HWPX 표 가져오기 및 렌더링
- [x] HWPX 이미지 가져오기 및 렌더링
- [x] HWPX 머리글/바닥글 가져오기 및 표시

MVP 이후 추가 완료:
- [x] 찾기/바꾸기 (`FindReplaceBar`, `findReplaceStore`)
- [x] 문장 다듬기 AI 패널 (`RefinementPanel`, `refinementStore`)
- [x] HWP 원본 읽기 전용 뷰 (`HwpReadonlyViewer`, `sourceMode: 'hwp-original-readonly'`)
- [x] HWP → ODT 브리지 파이프라인 (`odtParser.ts`, `scripts/hwp-render-bridge.mjs`)
- [x] 파서·내보내기 export plan 연동 (`paragraphIds` 기반 ID 매핑)
- [x] 빈 단락 인덱스 어긋남 버그 수정 (내보내기 텍스트 위치 오류)
- [x] 다중 런 텍스트 분배 버그 수정 (서식 혼재 단락의 텍스트 잘림)

### 알려진 미완성 항목

| 항목 | 상태 | 비고 |
|------|------|------|
| HWP → HWPX 표 내보내기 | ❌ 텍스트만 출력 | `hp:cellAddr/cellSpan/cellSz` 등 필수 속성 미생성 |
| HWP → HWPX 이미지 | ❌ 생략 | BinData 재패키징 미구현 |
| 에디터에서 새 문단 추가 후 내보내기 | ❌ 소실 | ID 없는 신규 문단은 export plan에 없음 |
| HWPX 볼드·이탤릭 내보내기 | ⚠️ 첫 런만 | 다중 런 서식 정보 손실 |

---

## Phase 1: 파싱 고도화

- [x] HWP ODT 브리지 파이프라인 (pyhwp hwp5odt → odtParser)
- [x] HWP 표 구조 보존 (cellAddr/colSpan/borderFill/padding)
- [x] HWP 이미지 파싱 (GSO, BinData, 크기 힌트)
- [x] HWP CharShape/ParaShape 서식 반영 (볼드·이탤릭·정렬·줄간격·들여쓰기)
- [x] HWP 페이지 분리 (`pghd`/`nwno` 제어 → `<hr>`)
- [x] HWP 표 열폭 보존 (`data-hwp-col-widths` + TipTap colgroup 복원)
- [x] HWP 비정상 셀 값 정규화 (span/width 오버플로우 방어)
- [ ] HWPX 인라인 서식 파싱 완전화 (볼드, 이탤릭, 밑줄 → TipTap Mark)
- [ ] HWPX 차트 / OLE / 수식 / 도형 렌더링
- [ ] HWP 바이너리 머리글/바닥글 파싱

## Phase 2: 내보내기 고도화

> **현황**: HWPX → HWPX 텍스트 수정은 작동. HWP → HWPX는 표·이미지 미지원.

### 2-1. HWP → HWPX 표 구조 생성 (우선순위 높음)
- [ ] `convertTable()`에 `hp:cellAddr`, `hp:cellSpan`, `hp:cellSz`, `hp:cellMargin`, `hp:subList` 생성
- [ ] 열 수 기반 균등 폭 계산 (A4 기준 7370 hwpunit 분배)
- [ ] colspan/rowspan rowAddr/colAddr 좌표 계산

### 2-2. 이미지 내보내기
- [ ] BinData 재패키징 (base64 data URL → ZIP BinData 복원)
- [ ] `hp:pic` 참조 재연결

### 2-3. 서식 내보내기
- [ ] 인라인 서식 내보내기 (hp:charPr 매핑 — 현재 첫 런에 텍스트만)
- [ ] 빈 단락 포함 신규 문단 추가 내보내기 (모든 단락에 ID 부여)

### 2-4. 기타
- [ ] 머리글/바닥글 내보내기 (HWPX 이미 작동, HWP 미구현)
- [ ] 페이지 설정 보존 (용지 크기, 여백)

## Phase 3: 편집 기능 강화

- [ ] 표 삽입/편집 UI 보강
- [ ] 이미지 삽입 / 교체
- [ ] 찾기/바꾸기
- [ ] 글머리 기호/번호 매기기 스타일 확장
- [ ] 페이지 나누기 시각화

## Phase 4: 한국어 처리 고도화

- [ ] 형태소 분석기 연동 (단어 단위 정확한 선택)
- [ ] 맞춤법 검사 연동
- [ ] 문장 단위 다듬기 (OLLAMA)
- [ ] 존댓말/반말 변환

## Phase 5: UX 개선

- [ ] 다크 모드
- [ ] 반응형 모바일 대응
- [ ] 드래그앤드롭 파일 목록 (다중 문서)
- [ ] 최근 파일 기록 (IndexedDB)
- [ ] 키보드 단축키 커스텀
- [ ] 에디터 확대/축소

## Phase 6: 성능 및 안정성

- [ ] 대용량 문서 처리 최적화 (가상 스크롤)
- [ ] OLLAMA 스트리밍 응답 지원
- [ ] 오프라인 캐싱 (Service Worker)
- [ ] 에러 바운더리 세분화
- [ ] 레이아웃 회귀 테스트 자동화 (대표 샘플 문서 스냅샷)
