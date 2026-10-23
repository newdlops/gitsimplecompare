# Git 작업·Graph 최적화 최종 검증 — 0.1.72167

원래 범위인 push, pull, fetch, rebase, merge, PR squash/replay cherry-pick,
단일 cherry-pick, checkout, Graph 최신성·안정성·자원 사용을 함께 확인한다.
최신 버전은 0.1.72167이다. 아래 비교 수치는 명시한 입력과 실행 경로의 관측이며,
모든 저장소·네트워크·하드웨어에서 각 작업이 항상 빨라진다는 보장은 아니다.

## 범위별 근거

| 요구 경로 | 적용한 비용 절감과 안전 경계 | 검증 근거 |
| --- | --- | --- |
| Push | 게시된 frontier 제외, 제한된 객체 읽기와 push 계획 재사용. 실제 대상과 upstream 검증 유지 | [frontier 기록](benchmarks/published-frontier-0.1.72128.md), 전체 행렬의 새/기존 upstream push, 실제 push 컨트롤 |
| Pull | Native upstream 계획의 중복 준비를 줄이고 변경 이력에 맞는 Graph 갱신 선택 | [upstream 기록](benchmarks/pull-upstream-0.1.72132.md), 신규/알려진 이력 pull와 실제 pull 컨트롤 |
| Fetch | Native ref가 같은 경우 기존 이력을 재사용하고 새 이력에는 필요한 페이지 조회 수행 | 전체 행렬의 신규/알려진/무변경 fetch와 실제 두 fetch 컨트롤 |
| Rebase | 번들 sequence editor 시작·range·준비 비용 축소. 쓰기 직전 checkout/HEAD와 복구 보호 유지 | [Native editor 기록](benchmarks/rebase-native-0.1.72124.md), [range 기록](benchmarks/rebase-range-0.1.72129.md), 실제 interactive/branch rebase와 promisor 검사 |
| Branch merge | 준비된 index commit의 불필요한 요약과 preload 감소. 결과 tree·부모·Undo 경계 유지 | [index commit 기록](benchmarks/prepared-index-commit-0.1.72147.md), 실제 squash/rebase branch 컨트롤의 독립 Native 결과 |
| PR squash | 준비된 index commit과 완료 후 Graph 갱신. 실제 충돌·local changes·source 범위 보호 유지 | 전체 행렬과 80개 PR 목록의 실제 squash 컨트롤, 기존 index/recovery 검증 |
| PR replay | 안전 조건을 만족하는 큰 임시 작업트리의 전체 파일 생성을 생략. hooks·특수 index·설정은 원래 checkout, 충돌 작업트리 복원/보존 | [대형 replay 기록](benchmarks/pr-replay-worktree-0.1.72163.md), 전체 행렬과 실제 replay 컨트롤 |
| Single cherry-pick | Native cherry-pick 뒤 필요한 Graph 갱신과 metadata 재사용 | 전체 행렬과 실제 우클릭 메뉴. 결과 tree·단일 부모·작성자·날짜·메시지를 독립 Native 조회와 비교 |
| Checkout | 표시된 페이지 재사용과 필요한 metadata만 갱신. 페이지 밖 대상은 별도 이력 읽기 | loaded/unloaded 행렬, 같은 branch/tree fingerprint, 실제 branch chip 컨트롤 |
| Graph 최신성 | 공통 directory 읽기 공유, 변경 영향 행 갱신, 상태만 바뀔 때 측정 canvas 폭·스크롤 보존 | [directory 기록](benchmarks/graph-common-directory-0.1.72165.md), 독립 Native 첫 페이지와 실제 마지막 frame, revision/resync/pagination/PR 이동 검사 |
| 안정성·자원 | fsmonitor 대기 우회·소유권 경계, 중단/오류 전파, stash/snapshot 보호. 새 상시 worker·감시자·장기 cache 없음 | 현재 Node 92건, 브라우저 75건, 별도 CPU/RSS 교차 관찰과 126개 runtime 바이트 대조 |

## 누적 관찰과 반대 표본

[0.1.72166 전체 행렬](benchmarks/cumulative-operation-0.1.72166.md)의 소형 입력은
1,000파일·1,800커밋·100 side branch·8 공통 upstream이다. 18개 변형을 작업별
B/A, A/B 순서로 교차 실행하고 latency/CPU/RSS를 분리했다. 12개 Node 수명의
216개 Native/DOM 결과가 모두 일치한다. source 649개 파일 fingerprint와 두
checkout의 branch/tree 입력도 고정했다. 72개 RSS 구간의 393개 원문 표본은
같은 JSON에 보존했다.

0.1.72128 대비 해당 합계는 완료 시간 약 2.0%, 소유 CPU 약 3.1%, 최대 **관측**
합산 RSS 약 6.6%, Git 호출 255→236, 최대 소유 슬롯 4→3이다. Node CPU와 일부
tracked push·pull·신규 fetch·merge 시간은 증가했다. 더 느린 값을 제외하지 않았다.
원래 전체 CPU·물리 메모리의 절대 최솟값이나 각 작업의 일관된 지연 감소를
입증한 수치로 확대하지 않는다. 별도 대형 입력의 PR replay 효과는 설정 조건을
만족한 경로에 한정하며 실제 Captain의 hook 조건에는 원래 checkout을 유지한다.

위 누적 행렬은 0.1.72166 소스다. 0.1.72167은 같은 canvas 계산을 기존
`graphRowSync.js`로 옮긴 구조 정리다. 현재 `graph.js` 591줄, 행 모듈 273줄로
프로젝트의 600줄 상한을 지킨다. Native extension 번들은 두 버전에서 같은 바이트다.
새 버전에서는 기능·실제 컨트롤·renderer 비교를 다시 수행하며, 이전 전체 행렬을
새 버전에서 재실행했다고 표시하지 않는다.

## 최종 renderer와 기능 확인

[현재 renderer 원문](benchmarks/graph-state-canvas-0.1.72167.json)은 0.1.72165
기준의 Graph/행 모듈 두 파일과 현재 두 파일을 독립 Chromium 수명 4개씩 비교한다.
5,000행·4,999간선·1,000브랜치·250태그에서 표시 시간 중앙값은 전후 16.7ms다.
별도 Chromium CPU 중앙값은 313.4145→315.2425ms(+0.6%)이고 GC 후 heap 증가는
양쪽 모두 0이다. 0.1.72166의 별도 비교에서 관찰한 CPU 감소를 최종 버전의
일관된 개선율로 사용하지 않는다. 이번 구조 정리의 추가 성능 향상도 주장하지 않는다.

현재 Node 92건과 브라우저 75건은 실패·취소·skip 없이 통과했다. 상태 완료/오류,
row/SVG identity, focus·selection·scroll, viewport/tail 변화, transport revision,
자동 pagination, PR 행 이동과 후속 갱신을 포함한다. 새 promisor 검사 2건은
준비 실패 전에 implicit fetch가 없으며 준비 성공 뒤 필요한 commit을 받아
정상 rebase하고 로컬 파일을 보존하는지 확인한다.

실제 컨트롤은 production HTML/CSP/JS → 등록 callback → Native Git → 마지막
Graph frame이다. VS Code transport/window/picker와 PR GitHub metadata만 대체한다.
80개 PR 카드와 오래된 local-change hint를 둔 11개 경로에서 Native 결과·HEAD·refs·
remote tags·local-only·로컬 변경을 비교한다. 결과는
[현재 컨트롤 원문](benchmarks/operation-controls-0.1.72167.json)에 있다.
390/768/1440px 화면을 생성하고 세 크기의 실제 화면을 별도로 확인한다.

## 배포와 남는 관측 한계

[패키지 바이트 기록](benchmarks/release-artifact-0.1.72167.json)과
[설치·게시 기록](benchmarks/deployment-0.1.72167.json)은 검증한 동일 VSIX를 기준으로 한다.
test/src/scripts/docs는 패키지에서 제외한다. 이전 버전 대비 실제 runtime 변경은
Graph 두 JS뿐이며, 나머지 Native 번들·helper·NLS·l10n은 그대로다.

별도 Marketplace 상태 조회, 사용자 창 포커스 전환이나 강제 reload는 하지 않는다.
설치된 버전·파일의 일치는 확인하지만 기존 활성 Extension Host가 새 버전으로
다시 시작했는지는 확인하지 않는다. 실제 GitHub 전송 지연·사용자 확인 모달 시간·
시스템 전체 CPU·물리 peak·모든 저장소에서의 지연 보장은 검증 범위 밖이다.
