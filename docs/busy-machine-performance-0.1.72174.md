# 0.1.72174 — 화면 밖 Graph 행의 렌더링 비용 줄이기

600행까지는 기존 구조를 유지한다. 그보다 큰 이력은 32행씩 묶고 `content-visibility: auto`로 화면 밖 묶음의 내부 layout/paint를 미룬다. 모든 행과 텍스트는 DOM에 남아 검색·키보드 포커스가 유지된다. 폭 후보의 묶음은 자연 폭으로 측정하고, 바깥/안쪽 top을 상쇄해 기존 전역 좌표와 SVG 관계를 보존한다. reflog 위치 변경과 부분 행 교체는 한 observer 배치에서 그룹 경계만 갱신한다.

전체 새로고침의 viewport 캡처는 renderer가 보증한 inline top·고정 높이를 사용해 앞쪽 화면 밖 행을 전부 layout하지 않는다. 고정 geometry를 제공하지 않은 기존 호출과 임의 CSS 위치는 Native getter를 유지한다. 측정된 가로 폭은 다음 폭 측정 frame까지 유지해 교체 중 scrollLeft가 먼저 0으로 줄지 않게 한다. 공통 포커스 선언은 컨트롤 CSS로 옮겼으며 표시 값은 같다.

## 실제 데이터로 분리 측정

배포·설치된 0.1.72173 VSIX의 JS·CSS 바이트를 기준으로 삼았다. 같은 Native 입력, 같은 Node harness로 B/A/A/B와 반대 순서를 실행했다. 16개 독립 Node 수명과 48개 새 renderer 문서를 사용했으며 각 행 수·측정 모드에서 버전별 독립 수명은 4개다. latency는 renderer6배 제한, CPU는 별도1배 제한이다. 측정 중 다른 검사·빌드·프로파일은 실행하지 않았다.

| 행 | 렌더+두 frame(ms) | 첫 frame(ms) | 소유 CPU(ms) |
|---:|---:|---:|---:|
| 300 | 716.0 → 1028.5 | 3084.5 → 3504.5 | 776.7 → 572.7 |
| 1,200 | 1455.0 → 840.0 | 3064.0 → 2774.0 | 914.4 → 978.8 |
| 5,000 | 7099.5 → 2459.5 | 11633.5 → 6337.0 | 2063.3 → 2341.0 |

5,000행의 먼 위치에서 같은 전체 snapshot을 다시 게시하는 경우는 수명별2회 예열 뒤4회 측정했다. 이4개 표본은 상관돼 있으므로 먼저 수명별 중앙값을 계산했다. 렌더+frame은 5461.0 → 1678.5ms였다. 네 번 reset의 소유 CPU 합계 중앙값은 4374.1 → 4218.3ms였다. 사후 Native/DOM 검사는 측정 밖에서 실행했다.

혼합 순서에서300행과 CPU 표본은 편차가 크고 악화된 중앙값도 있다. 같은 Native Git과 Node의 CPU 시간도 함께 크게 변해 환경/직전 작업 영향이 섞였을 가능성이 있다. 이 결과로 전체 CPU 감소나300행 동등성을 주장하지 않는다. 직전 큰 reset 작업을 제외한300행 단독·5,000행 CPU 단독 확인 결과도 모두 별도 파일로 보존했다. 처음의 불리한 표본을 제거하지 않았다.

| 단독 확인(행 / 모드) | 렌더+두 frame(ms) | 소유 CPU(ms) |
|---|---:|---:|
| 300 / latency | 835.0 → 572.5 | 별도 측정 |
| 300 / resources | 47.0 → 69.0 | 515.5 → 762.3 |
| 5,000 / resources | 690.5 → 291.0 | 2597.6 → 1589.2 |

단독 확인도 버전별4개 독립 수명이다. 300행 latency의 인접 쌍은 개선·악화가 번갈아 나왔고 CPU 중앙값은 악화됐다. 5,000행 CPU 단독 중앙값은 줄었지만, 혼합 측정에서는 반대였으므로 전체 CPU 개선 근거로 삼지 않는다. 변경하지 않은 Native/Node 단계에도 큰 편차가 있어 원인을 구분할 추가 증거가 필요하다. 큰 그래프의 latency 개선과 CPU 불확실성을 구분한다.

CPU는 소유 Node·OS가 wait한 native 자식·완전한 Chromium counter의 합이다. 실제 VS Code 전체 CPU나 Git만의 CPU가 아니다. Native oracle이 파일시스템을 예열하고 시작하므로 OS 디스크 cold 결과도 아니다. 첫 frame/입력 수치는 별도 headless transport이며 실제 사용 창·물리 화면·Web Vitals INP 수치가 아니다. 이 진단은 status/local-only/remote-tag/GitHub 시작 작업을 제외한다. 전체 실제 클릭 경로는 별도의 소유 Native checkout·PR squash 검증으로 확인했다.

## 기능과 자원

최종 Graph/PR webview120개, 관련 Node10개, 타입 검사와 production 빌드가 통과했다. 390·768·1,440px의 큰 이력·PR stack·reflog 화면을 확인했다. 임계값을 넘는 pagination의 포커스 identity, 긴 행의 가로 scroll, working-tree 행 추가/제거, reflog 경계와 SVG hit target, 전체 새로고침의 가로/세로 위치를 검증했다.

실제 저장소는 Git 공통 실행기에서 allowlist 조회만 허용하고 optional writes·lazy fetch·fsmonitor를 끈다. 각 run의 HEAD/index/config/packed refs/전체 ref 집합이 같았고 독립 Native log와 입력 필드가 일치했다. 원문 경로·브랜치·커밋/저자 정보는 보고서에 기록하지 않았다.

최종 실제-data 문서를300↔5,000행으로8회 reset한 뒤 GC 기준 문서·DOM·listener 수를 기록했다. 유한한8회 결과이며 장기 누수나 물리 RSS/메모리 감소를 주장하지 않는다. 실제 업데이트된 VS Code 창에서의 높은 부하 응답은 별도 미확인 사항으로 남긴다.

## 재현과 근거

읽기 전용 기존 저장소와 사용하는 Git을 환경변수로 지정해 `node scripts/benchmark-graph-readonly-renderer.mjs /private/tmp/report.json`을 실행한다. `GSC_BENCH_READONLY_REPOSITORY`, `GSC_BENCH_GIT_EXECUTABLE`, `GSC_BENCH_RENDERER_COUNTS`, `GSC_BENCH_RENDERER_CPU_THROTTLE`를 사용한다. CPU는 `GSC_BENCH_PHASE_RESOURCES=1`, 반복 reset은 `GSC_BENCH_RESET_REPEATS=4`, GC 수명 검증은 `GSC_BENCH_REPEAT_CYCLES=8`로 분리한다. 비교 media override는 각각의 SHA256을 함께 요구한다.

[원시 표본](benchmarks/readonly-renderer-0.1.72174.json), [요약](benchmarks/performance-summary-0.1.72174.json), [기능 검사](benchmarks/verification-0.1.72174.json), [Native 버튼](benchmarks/functional-controls-0.1.72174.json), [반복 수명](benchmarks/readonly-lifecycle-0.1.72174.json), [UI 감사](benchmarks/ui-audit-0.1.72174.json), [패키지 검증](benchmarks/release-artifact-0.1.72174.json).
