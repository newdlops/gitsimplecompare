# 0.1.72119 Graph 브랜치 목록 전송과 메뉴 비용

Graph 새로고침마다 같은 브랜치 목록을 반복해서 보내고, 메뉴가 닫혀 있어도 모든 행을
다시 만드는 비용을 줄였다. Git 읽기나 쓰기의 안전 검증은 바꾸지 않는다.

- 같은 fingerprint에서 로컬/원격 refs가 이미 검증되었으면 최종 필터 목록을 한 번만 게시한다.
  원격 목록이 아직 없으면 기존대로 로컬 pending → 원격 ready/error를 각각 보낸다.
- 메뉴가 닫혀 있으면 행 HTML을 만들지 않는다. 새 snapshot이 오면 오래된 숨은 DOM을 버린다.
  서버 응답 전 닫았다 다시 여는 경우에는 사용자의 선택 상태를 유지한다.
- 옵션에는 name/kind/current/checked만 보낸다. 원격 hash/fullRef와 all 모드의 중복 선택 목록을 제외한다.
- 일반 모드는 화면 밖 행의 layout을 생략한다. 지원하지 않는 CSS 환경과 스크린리더 모드는
  기존 전체 행 표시를 사용한다. 타이머나 Git 결과 캐시는 추가하지 않았다.

## 브라우저 측정

비교 기준은 `a6ce708df3abb248e11ca498f161431d0d30c8bf` (0.1.72118)이다.
같은 fixture에 실제 production component JS/CSS를 연결하고 headless Chromium에서 실행했다.
각 크기마다 새 page로 warmup 1회와 측정 5회, 실제 current branch가 바뀌는 snapshot 10개를 사용했다.
CPU throttle은 6배다. 인위적인 Git 지연은 넣지 않았고 이 측정 자체는 Git을 실행하지 않는다.

최종 후보 브라우저 → 이전 버전 Native matrix → 이전 버전 브라우저 → 최종 후보 Native matrix
순서로 실행했다. 최종 측정 중 다른 무거운 프로젝트 검사를 함께 실행하지 않았다.
시스템의 다른 작업 부하는 통제하지 않았으며, 각 항목은 5회 중앙값이다.

| 브랜치 | 관측 항목 | 이전 | 후보 |
|---|---|---:|---:|
| 300 | 닫힌 목록 10회 갱신 | 87.3 ms | 8.4 ms |
| 300 | 해당 구간 browser task | 93.5 ms | 12.5 ms |
| 300 | 해당 구간 browser script | 85.0 ms | 7.9 ms |
| 300 | 첫 열기에서 두 frame까지 | 119.7 ms | 69.1 ms |
| 1,000 | 닫힌 목록 10회 갱신 | 252.5 ms | 15.9 ms |
| 1,000 | 해당 구간 browser task | 270.3 ms | 19.9 ms |
| 1,000 | 해당 구간 browser script | 246.9 ms | 13.8 ms |
| 1,000 | 첫 열기에서 두 frame까지 | 280.6 ms | 110.3 ms |

1,000개 표본에서 닫힌 갱신 구간은 약 93.7%, 첫 열기는 약 60.7% 짧았다.
브라우저 task/script는 이 component 구간의 관측값이며 확장 전체 또는 Node CPU가 아니다.
첫 열기의 동기 handler는 1.1 → 20.7 ms로 늘었다. 목록 생성이 이때로 이동한 결과다.
첫 열기 후 frame까지 함께 확인해 단순히 비용만 뒤로 미루지 않았는지 살폈다.

| 닫힌 메뉴의 자원 관측 | 300개 이전 → 후보 | 1,000개 이전 → 후보 |
|---|---:|---:|
| 10회 동안 추가한 DOM 요소 | 15,150 → 0 | 50,150 → 0 |
| 마지막에 보유한 메뉴 DOM 요소 | 1,515 → 0 | 5,015 → 0 |
| GC 뒤 JS heap 증가 중앙값 | 0.155 → 0.122 MiB | 0.220 → 0.189 MiB |

DOM 요소 수와 JS heap은 전체 브라우저/확장의 RSS와 다르다. 메뉴를 실제로 연 뒤에는 모든
checkbox DOM이 존재한다. 큰 메모리 절감이나 전체 프로세스 CPU 감소를 이 표로 주장하지 않는다.

## 채택하지 않은 중간 결과

행 생성을 첫 열기로 미루기만 한 시안은 1,000개에서 첫 열기가 557.3 → 694.9 ms로 느려졌다.
scrollTop=0의 불필요한 동기 layout을 없애고, 화면 밖 행의 layout 생략을 함께 적용했다.
해당 초기 비교와 중간 시안, 최종 비교를 모두 JSON에 보존했다. 서로 다른 측정 구간의 시간은
합치지 않는다. 최종 후보의 CJS benchmark hash는 runtime으로 읽는 media를 포함하지 않으므로
별도로 기록한 productionSource SHA-256과 기준 commit으로 실제 자산을 식별한다.

## 실제 Git 작업과 정확성

Native matrix는 파일 1,000개, 기본 이력 1,000개, 브랜치 300개와 공통 upstream 8개를 쓴다.
각 버전에서 최초 표시, push, fetch-new-history, pull, fetch, rebase, merge, merge-no-ff,
PR squash cherry-pick, PR cherry-pick, cherry-pick, 실제 다른 OID로 이동하는 checkout을 실행한다.
모든 쓰기는 임시 저장소와 로컬 bare remote에 한정한다.

production HTML/CSP/JS의 첫 frame과 최종 local-only frame을 따로 받고, Native Git의
HEAD·현재 브랜치 chip·부모·ref·local-only와 대조한다. 같은 Git 결과에서 필터 게시 수와
직렬화된 JSON 바이트를 비교한다. 원본의 operation 시간, frame 시간, Node CPU, RSS도 보존한다.
각 시나리오 한 표본이고 시간 편차가 커서 전체 Git 작업의 속도 향상 또는 CPU 절감을 주장하지 않는다.
다른 검사와 겹친 초기 matrix 두 개도 정확성/게시 수 참고용으로만 남겼다.

최종 두 버전의 24개 표본은 모두 Native 결과와 일치했다. 후보의 필터 게시는 12개 시나리오 모두
1회였으며, 아직 모르는 원격 목록의 pending → ready 게시 2회는 별도 Panel 검사에서 유지했다.

| 시나리오 | 필터 게시 이전 → 후보 | 필터 JSON 바이트 이전 → 후보 |
|---|---:|---:|
| 최초 표시 | 3 → 1 | 234,132 → 42,231 |
| push | 2 → 1 | 156,439 → 42,375 |
| rebase | 3 → 1 | 237,042 → 42,802 |
| PR squash cherry-pick | 3 → 1 | 237,921 → 43,031 |
| checkout | 2 → 1 | 159,184 → 43,256 |

첫 표시의 목록 전송량은 약 82.0% 줄었다. 전체 Graph 갱신 시간은 일관되게 줄지 않았다.
예를 들어 최종 frame은 checkout 2,722 → 1,606 ms, merge 4,291 → 9,369 ms,
PR squash 1,989 → 3,969 ms였다. 최초 표시도 1,803 → 2,569 ms로 늘었다.
전체 12개 표본의 benchmark Node CPU 합계는 4,516 → 4,448 ms였지만 개별 방향이 섞였다.
소수 표본의 관측만으로 이런 차이를 이번 변경에 인과적으로 귀속하거나 전체 목표 달성으로 해석하지 않는다.

Node CPU에는 Playwright transport, RSS/idle polling이 포함된다. 이전 최초 표시의 14% CPU 증가를
이 메뉴만의 문제로 단정하지 않았다. 별도 선택적 CPU profile에서 transport·GC·timer와 full-memory
RSS sampler 비용도 관측했다. 최종 두 버전은 같은 RSS 전용 sampler를 사용한다.
profile 진단 요약은 보존하되, profiler 사용 표본과 일반 표본의 총 CPU를 비교하지 않는다.

## 기능 및 화면 확인

- 관련 순수/Panel Node 검사 73개와 Native 첫 페이지/손상 ref fallback 검사 2개 통과.
- 메뉴 화면 검사 8개 통과. 390×844, 768×1024, 1440×900에서 밀집 목록, 검색, 오류,
  pending/empty 상태와 좁은 창의 popup 경계를 확인했다. 수정 뒤 실제 screenshot을 다시 확인했다.
- 검색 커서, checkbox focus, 스크롤과 compact 선택을 유지한다. Clear All/Select All은 즉시 반영하며
  같은 click에서 DOM이 교체되어도 메뉴가 닫히지 않는다. Escape는 같은 웹뷰의 열기 버튼으로 돌아간다.
- hydration 전 선택한 원격 브랜치가 로컬 checkbox/compact 변경으로 유실되지 않음을 확인했다.
- 20px 글꼴에서 처음/마지막 행 높이와 스크롤 범위가 같고 마지막 checkbox를 키보드로 조작한다.
- 공식 [VS Code 스크린리더 모드 클래스](https://code.visualstudio.com/api/extension-guides/webview#accessibility)를
  재현하면 layout 생략이 꺼지고 Chromium AX tree에 checkbox 1,001개가 모두 노출된다.
  실제 VoiceOver/NVDA 세션이나 물리 터치 장치를 시험한 결과는 아니다.

`ui-design-workflow`와 Impeccable audit/polish를 적용해 기존 VS Code theme token, Codicon과
밀도를 유지했다. [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md)의
포커스·접근성 이름·긴 목록·overflow 항목을 변경 경로에 적용했다. 확인된 메뉴 잘림,
선택 유실과 DOM 교체 시 focus/외부 click 문제는 수정했다. 기존 버튼 tooltip/aria label을 유지한다.

## 재현 및 한계

`node scripts/benchmark-graph-catalog.mjs <output.json>`을 실행한다. 이전 source에는
`GSC_BENCH_SOURCE_REF=a6ce708`을 추가한다. 기본 크기는 300/1,000, 표본은 각 5회다.
Native matrix는 기존 `scripts/benchmark-git-operations.mjs`에 위 시나리오와
`GSC_BENCH_BRANCHES=300`, `GSC_BENCH_SHARED_UPSTREAM_BRANCHES=8`,
`GSC_BENCH_MONITOR_POLICY=1`, `GSC_BENCH_LIVE_RENDERER=1`,
`GSC_BENCH_CHECKOUT_LOADED_TARGET=1`을 지정한다.

원본 표본·진단·최종 source 해시는 [JSON](graph-catalog-0.1.72119.json)에 있다.
타입 검사, 빌드와 VSIX/설치 runtime 파일 대조는 배포 절차에서 별도로 수행한다.
전경 Extension Host를 띄우거나 사용자 창을 활성화하지 않았고 강제 reload 및 Marketplace 상태 조회도 하지 않았다.
실제 VS Code 전체 체감과 모든 Git 작업의 속도·안정성·자원 최소화라는 전체 목표가 완료되었다고 판단하지 않는다.
