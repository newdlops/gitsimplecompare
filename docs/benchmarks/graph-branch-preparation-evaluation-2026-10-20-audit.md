# Graph 병렬 준비 후보 UI 감사 — 배포 제외

범위는 평가한 후보의 큰 ref catalog 직접 갱신과 취소 수명이다. Graph의 기존 HTML·CSS·표시 문구와
VS Code 테마 토큰을 유지했다. `ui-design-workflow`와 `impeccable audit` 절차를 적용했으며,
제품 전체나 모든 VS Code 테마에 대한 인증으로 해석하지 않는다.

## 구현 일관성

기능 일관성은 통과했으나 성능 채택 기준은 실패했다. 후보에서 Git 조회·검증은 `src/git/graphBranchPreparation.ts`, 요청의 준비·취소·소비는
`src/webview/graphBranchPreparation.ts`, 최종 게시와 세대 확인은 기존 `graphPanel.ts`가
담당한다. 오래된 counts를 다음 요청의 상태로 캐시하지 않는다. 새 버튼·의존성·타이머는 없다.
후보 UI 수명 모듈 세 개의 기계적 detector 결과는 빈 배열이었다. 후보 코드와 버전 변경은
제품 소스에서 원복했고 현재 배포는 0.1.72115다. 후보 보관 위치는 측정 JSON에 기록했다.

| 차원 | 점수 / 4 | 확인한 근거와 범위 |
| --- | ---: | --- |
| 접근성 | 3 | Graph 경고 영역 Axe 위반 0, live announcement, 키보드 focus와 forced-colors/reduced-motion 확인. 전체 확장 감사는 아님 |
| 성능 | 1 | 기능 검증과 별개로 화면 안 tip 선택의 반복 중앙값이 악화돼 후보를 폐기함 |
| 반응형 | 3 | 390·768·1440px의 정상 Git Graph와 긴 경고를 각각 촬영·육안 확인. 실제 터치 장치는 미검증 |
| 테마 | 3 | 기존 VS Code 토큰·Codicon 유지. 어두운 테마와 고대비 focus 검사, 밝은 테마 전체는 미검증 |
| 구현 일관성 | 4 | 기존 Graph 상태·컴포넌트·native 작업 흐름을 유지하고 새 시각 체계를 추가하지 않음 |
| 합계 | **14 / 20** | Good — 후보의 배포 판정은 성능 P1 때문에 실패 |

## 결과와 발견 사항

후보에서 P0 0건, P1 1건, P2 0건, P3 1건을 기록했다.

**P1 성능 이득 미입증**: 후보 `src/webview/graphBranchPreparation.ts`의 병렬 native 준비.
실제 화면 안 tip checkout 5회 비교에서 화면 반영은 1852→2660ms, Node CPU는
341→357ms, 동시 Git은 2→3개였다. 환경 영향과 구현 영향을 완전히 분리한 인과 증명은
아니지만 채택 근거가 부족하므로 원복으로 처리했다. 다음 성능 변경은 `impeccable optimize`로
Native 실행·대기 비용을 먼저 분리하고 기능과 반복 속도 증거를 함께 요구한다.

P3 한 건은 기존
`.impeccable/design.json`이 `DESIGN.md`보다 오래됐다는 도구의 보고다. 실행 화면에는
기존 토큰을 사용하며, 해당 보조 파일은 이번 작업에서 재생성하지 않았다. 필요한 경우
`impeccable document`로 원문을 보존하며 갱신할 수 있다.

좁은 화면의 Graph 행과 도구 모음은 기존 고밀도 데스크톱 확장의 가로 스크롤 방식을
유지한다. 긴 경고는 줄바꿈하고 ref 이름은 생략 표시하며 Output 복구 동작에 접근할 수
있었다. 이를 임의의 모바일 웹 레이아웃으로 바꾸지 않았다.

## 실제 검증

- headless Chromium의 관련 spec 23개 통과: 작업 대기/실패/늦은 완료, 초기 이력과 늦은
  working-tree 상태, 페이지 이동, ref 교체, 선택·스크롤·focus, 손상 ref 및 초기 오류.
- 접근성, 반응형 경고 화면, 큰 checkout delta 검사를 따로 실행했다. 5,000행 검사는
  선택한 행·노드·간선·스크롤과 웹뷰 내부 focus가 유지되는지 확인했다.
- 실제 Git 작업 11개 후 production HTML/CSP/JS에 게시한 300행과 native 조회의
  HEAD·부모·refs를 대조했다. 390·768·1440px에서 정상 commit 클릭과 Escape도 실행했다.
- 오류 경고 화면 세 장과 실제 Git 화면 세 장을 각각 열어 확인했다. 새 시각 수정은
  필요하지 않아 추가 다듬기 반복은 하지 않았다.
- UI 테스트는 모두 headless였다. OS 창 포커스 이동, visible Extension Development Host,
  강제 창 다시 로드, Marketplace 상태 점검은 실행하지 않았다.

시각 상태를 다시 변경하는 후속 작업의 마지막 단계에는 `impeccable polish`를 적용한다.
관련 결과는 [측정 보고서](graph-branch-preparation-evaluation-2026-10-20.md)와 JSON에 기록한다.
