# Sol 판단 기록 및 위임 큐

이 문서는 UI 개편을 진행하면서 **구현자의 추측으로 결정하면 안 되는 사항**을
Sol 모델에 위임하고, 그 결론을 Terra가 재현 가능하게 구현하기 위한 기록이다.
사용자의 명시적 지시가 항상 이 문서와 Sol 판단보다 우선한다.

## 운영 원칙

- Terra는 명확한 명세를 코드·테스트·문서로 구현한다. 이미 결정된 계약 안의
  기계적인 분리, 버그 수정, i18n, 단위 테스트 보강은 Sol 판단 없이 진행한다.
- 제품 surface 경계, 데이터 정합성·권한, 호환성 폐기, 성능·릴리스 게이트,
  되돌리기 어려운 구조 선택처럼 여러 정당한 선택지가 있는 일은 Sol에 위임한다.
- Sol은 **질문, 선택지와 trade-off, 선택, 근거, Terra 실행 제약, 검증 조건,
  재검토 조건**을 남긴다. 질문만 남기고 구현을 시작하지 않는다.
- 새 판단 항목은 아래 표에 `needs-sol`로 먼저 기록한다. Sol 결론 뒤에는
  `decided`, 구현 뒤에는 `implemented`, 정해진 검증을 통과하면 `verified`로
  상태를 갱신한다.
- 권한이 필요한 실제 GitHub 변경, 사용자 VS Code 창 조작, destructive 정리처럼
  Sol도 부여할 수 없는 권한은 별도 사용자 승인 없이는 실행하지 않는다.

## 현재 Sol 결정

### D-001 — PR-00은 검증 기반의 최소 실행 gate로 제한한다

| 항목 | 내용 |
| --- | --- |
| 상태 | `implemented` |
| 판단 질문 | 새 UI 기능을 계속 넓힐지, PR-00의 검증 기반을 먼저 강제 완료할지 |
| Sol max 선택 | PR-00은 이후 vertical slice의 회귀를 막는 **최소 실행 gate**까지만 차단한다. 즉 webview·a11y·Extension Host·visual runner, fixture schema, Changes·Reviews·PR detail의 대표 smoke/evidence를 먼저 만든다. feature별 전체 scenario matrix는 해당 slice의 완료 조건으로, 전체 visual release gate는 PR-14로 남긴다. |
| 근거 | [UI 개편 계획](ui-overhaul-plan.ko.md)은 PR-00에서 계약·fixture·검증 기반을 먼저 요구한다. 현재 Playwright 의존성은 있으나 해당 scripts/config/spec가 없고 fixture도 매우 제한적이다. PR-00에 전체 matrix를 모두 넣으면 기반 작업이 이후 slice의 책임을 선점한다. |
| Terra 실행 제약 | 기존 구현을 삭제하지 않고 runner/fixture를 독립 모듈로 추가한다. populated 개인 review와 management 흐름은 실제 네트워크가 아닌 deterministic fixture로 재현한다. runner는 "준비됨"만 주장하지 않고 최소 한 개의 실제 spec을 실행한다. |
| 완료 조건 | `test:webview`, `test:a11y`, `test:extension`, `test:visual` 실행 경로가 실제 명령으로 동작한다. Changes·Reviews·PR detail 각 1개 이상의 대표 smoke/evidence가 남고, fixture schema는 small/large/error/Korean을 판별한다. |
| 재검토 | 도구·CI 제약으로 runner가 실제 실행 불가능하거나 대표 smoke가 host 의미론을 검증하지 못한다는 증거가 생길 때만 Sol max가 대체 gate를 결정한다. |

#### PR-00 실행 증거 — 2026-07-27

- `npm run test:webview`: Changes small, Reviews management Korean, Review Workspace populated renderer smoke 3개 통과.
- `npm run test:a11y`: Reviews management와 Review Workspace error state 2개 통과. 이 과정에서 error/loading 상태의 tab `aria-controls` 대상 panel 누락을 찾아 수정했다.
- `npm run test:visual`: Changes compact, Reviews management Korean, Review Workspace Files representative screenshot artifact 3개 생성·통과.
- `npm run test:extension`: 격리된 Extension Development Host에서 manifest discovery와 activation smoke 통과.
- `npm run check-types`, `npm run compile`: TypeScript와 bundle 통과. `npm test` full suite는 15분 cap에서 worker group을 정리했고 lock/child process를 남기지 않았다. `commitHookService` 단독 target suite는 15분 이내 종료했다. full-suite의 누적 비용은 timeout 상향 대신 별도 profiling/slow-suite 분리가 필요하다. Node runner는 concurrency 최대 3·15분 상한·process-group cleanup·single-flight lock·명시 target test 경로를 사용한다.

macOS sandbox는 Chromium의 Mach rendezvous를 차단하므로 browser suite는 승인된 sandbox 밖
단일 runner에서 실행했다. 이는 사용자 VS Code 창이나 실제 GitHub 데이터를 조작하지 않는다.
전체 visual matrix와 승인된 disposable GitHub write smoke는 D-005 및 각 feature slice의
남은 release gate다.

### D-002 — Review Center와 Review Workspace의 surface 경계를 바로잡는다

| 항목 | 내용 |
| --- | --- |
| 상태 | `decided` |
| 판단 질문 | 단일 PR 상세 panel과 다중 PR queue surface가 같은 `ReviewCenter` 명칭·책임을 계속 공유해도 되는가 |
| Sol max 선택 | 다중 PR queue·scope·bulk 탐색 surface만 **Review Center**로, 단일 PR detail·comment·submit surface는 **Review Workspace**로 정의한다. 현 `ReviewCenterPanel`/`gitSimpleCompare.reviewCenter`를 새 Center 의미로 즉시 재사용하지 않고 Workspace rename/bridge 대상으로 둔다. |
| 근거 | 두 계획 문서는 개인 inbox·팀/조직 queue와 단일 PR review workspace를 별도 surface로 규정한다. 그러나 현재 panel 이름과 sidebar 진입 구조가 단일 PR 상세 책임과 섞여 있다. |
| Terra 실행 제약 | 새 protocol, command, test, UI copy는 정확한 surface 명칭을 사용한다. 기존 command/URI는 redirect alias와 persisted-state migration으로 유지하고 한 slice에서 무단 삭제하지 않는다. |
| 완료 조건 | sidebar는 queue를 Review Center로 열고, 행/Graph/native diff는 같은 PR의 Review Workspace로 연다. Center → Workspace → Center에서 queue·selection·scroll·draft 복원 test와 command/state migration 표가 통과한다. |
| 재검토 | 기존 command 또는 persisted draft를 무손실로 식별할 수 없을 때 versioned migration을 Sol max에 재위임한다. |

### D-003 — 대형 dirty diff를 reviewable checkpoint로 되돌린다

| 항목 | 내용 |
| --- | --- |
| 상태 | `decided` |
| 판단 질문 | 기반·Sidebar·Review·Graph·Rebase·Split·legacy migration 변경을 하나의 대형 변경으로 계속 누적할지 |
| Sol max 선택 | 한 커밋으로 억지로 묶지 않는다. `00 → 01 → 02 → 03/04 read → 05/06/07 write → 08/09 → 10/11 → 12~14` 순 checkpoint로 검토 가능한 slice를 회복한다. |
| 근거 | UI 개편 계획의 PR-00~PR-11 순서와 현재 다수 영역 동시 변경은 리뷰 범위와 회귀 원인 추적을 어렵게 만든다. |
| Terra 실행 제약 | 먼저 file/contract inventory를 기준선으로 고정하고 새 코드는 다음 checkpoint의 경로·테스트·acceptance를 표시한다. unrelated dirty change를 되돌리거나 history를 재작성하지 않는다. |
| 완료 조건 | 각 checkpoint는 독립 compile/typecheck/target test, 변경 파일 목록, 남은 의존성, rollback 경계를 가진다. |
| 재검토 | 두 checkpoint가 실제로 순환 의존임이 증명될 때만 Sol이 병합 단위를 다시 정한다. |

### D-004 — Queue windowing을 surface 완료 조건으로 승격한다

| 항목 | 내용 |
| --- | --- |
| 상태 | `decided` |
| 판단 질문 | 현재의 20행 누적 slice를 virtualization으로 보고 추후 PR로 미룰지 |
| Sol max 선택 | 누적 DOM slice를 virtualization으로 간주하지 않는다. 200개 이상 queue, 300개 이상 file, large diff에서 실제 windowing을 해당 surface의 완료 조건으로 구현한다. 공통 virtualization 계약 위에 queue/file/diff별 adapter를 둔다. |
| 근거 | Review 계획의 성능 계약은 큰 queue/file/diff를 전제로 한다. 현재 helper는 행을 잘라 누적 렌더하므로 스크롤 기간이 길어질수록 DOM이 계속 증가한다. |
| Terra 실행 제약 | shared contract와 각 adapter가 scroll container 높이, overscan, stable key, focus pin/restoration, ARIA position을 소유한다. 하나의 거대 controller가 모든 surface를 흡수하지 않는다. |
| 완료 조건 | fixture 기반 큰 데이터에서 DOM row 수가 window 범위로 제한되고 keyboard selection·screen reader position·row action이 유지된다. p95 frame/response 예산 측정값도 계획 기준을 만족한다. |
| 재검토 | variable-height diff 또는 screen reader에서 접근성 회귀가 재현되면 Sol max가 pagination/hybrid를 결정한다. |

### D-005 — visual/live QA는 fixture gate와 승인된 smoke gate로 분리한다

| 항목 | 내용 |
| --- | --- |
| 상태 | `decided` |
| 판단 질문 | 사용자 VS Code 창이나 실 GitHub 계정을 자동 조작해 populated flow를 검증할지 |
| Sol max 선택 | `DOM fixture → controlled Extension Host → 승인된 disposable GitHub smoke`의 3단계 gate를 둔다. screenshot은 baseline 승인 전 review artifact이며 무조건 pixel-diff gate가 아니다. 다중 사용자 VS Code 창은 자동 조작하지 않는다. |
| 근거 | visual QA matrix는 개인·management populated flow를 요구하지만 현재는 안전하게 재현 가능한 실제 데이터 증거가 없다. |
| Terra 실행 제약 | 스크린샷은 fixture identity로 재현 가능해야 하며 theme/width/state를 파일명과 metadata에 명시한다. 현 사용자 창을 close/focus/reload하지 않는다. write release를 열려면 승인된 disposable repo smoke가 필요하며, 승인 없이는 read-only release 또는 write 비노출이다. |
| 완료 조건 | 각 slice의 populated/empty/error/permission representative evidence와 failure artifact가 fixture gate에서 생성된다. smoke는 별도 승인/credential/cleanup 절차를 가진다. |
| 재검토 | fixture와 GitHub/GHES 의미 차이에서 반복 failure가 발생하면 Sol max가 smoke 범위를 확대한다. |

### D-006 — 테스트 자원 안전 정책을 고정한다

| 항목 | 내용 |
| --- | --- |
| 상태 | `decided` |
| 판단 질문 | 많은 장시간 test runner를 병렬로 재시도할지, 자원 제한을 강제할지 |
| Sol max 선택 | 한 시점에는 root `npm test` 하나만 허용한다. concurrency는 기본·최대 3, timeout은 최대 15분이며 process-group `SIGTERM → 5초 → SIGKILL`을 유지한다. 변경 중에는 target suite, slice 종료 때만 full suite를 실행한다. |
| 근거 | 장시간·중복 runner가 다수 누적된 이력이 있다. 기존 runner는 환경변수 상한, single-flight lock, suite 분류를 강제하지 않았다. |
| Terra 실행 제약 | unit은 UI/axe/extension/visual suite와 별도 discovery 범위를 사용한다. 새 runner는 lock·상한·자식 종료 정책을 우회하지 않으며 시작 전/종료 후 잔류 test process 0을 확인한다. 자원 부족/timeout은 artifact와 함께 실패로 보고한다. |
| 완료 조건 | Ctrl+C, timeout, 실패에서 자식 runner가 남지 않고, 중복 root 실행은 거부되며 execution group이 로그에 표시된다. target test 경로와 suite 분류가 자동 test로 고정된다. |
| 재검토 | full suite가 단일 안전 실행에서도 반복해 15분을 넘을 때 timeout을 올리지 않는다. 느린 테스트의 격리·프로파일링 방안을 Sol이 재결정한다. |

## Sol max 확정 결정

### D-007 — 관리 mutation의 권한 truth model

| 항목 | 내용 |
| --- | --- |
| 상태 | `decided` |
| 판단 질문 | 첫 release의 관리 write 범위와 client permission 표현을 어디까지로 고정할 것인가 |
| 선택지 | (A) 단일 `viewerCanUpdate` boolean으로 form 전체를 gate한다. (B) action별 `allowed` / `denied` / `unknown` 상태와 서버 최종 판정을 사용한다. |
| 현재 근거 | 제품·상세 계획은 reviewer/team, assignee, label, milestone, draft/ready를 1차 범위로 두고 ruleset/merge/bulk review는 제외한다. 현 모델의 단일 boolean은 action별 권한 차이를 표현하지 못한다. |
| Sol max 선택 | **B**: action별 `allowed` / `denied` / `unknown`과 서버 최종 판정을 진실 원천으로 쓴다. 첫 write 범위는 reviewer(user/team), assignee, label add/remove, milestone set/clear, 단일 PR draft↔ready, bulk draft→ready까지만이다. |
| Terra 실행 제약 | `unknown`은 disabled + hydration/retry로 표시한다. `403`은 rollback·해당 action denied cache·metadata/permission refresh(자동 retry 없음), `422`는 validation/capability 오류 + authoritative reread, partial success는 성공 항목을 되돌리지 않고 item별 mismatch를 보인다. merge/ruleset/title/body/base/close/reopen/bulk review submit은 추가하지 않는다. |
| 완료 기준 | action별 permission model, disabled 이유, server rejection 후 re-read/announce가 unit·protocol·UI test로 고정된다. |
| 재검토 | GitHub/GHES가 action별 permission을 안정적으로 구분하지 못하면 conservative preview + server-only 판정으로 축소한다. |

### D-008 — Changes의 책임 기반 분리 경계

| 항목 | 내용 |
| --- | --- |
| 상태 | `decided` |
| 판단 질문 | 대형 `changes.js`/`changes.css`를 어떤 책임 경계와 migration 순서로 600라인 gate 이하로 나눌 것인가 |
| 선택지 | (A) 임의 line-count 조각 분리. (B) shell/render coordinator, working-tree interaction, section renderer, drag/resize 및 대응 CSS 책임으로 분리. |
| 현재 근거 | 현 파일은 각각 약 1,349/1,213라인으로 architecture acceptance를 만족하지 않는다. 최근 모듈화 과정에서 실제 scope/runtime reference 회귀가 발견되어 계약 보존이 중요하다. |
| Sol max 선택 | **B**: line-count 조각이 아니라 shell/render coordinator, working-tree interaction, section renderer, menu/layout/drag-resize, component CSS 책임으로 분리한다. 순서는 PR-00 characterization → 순수 state/render helper → working-tree → section/layout/drag → shell → CSS ownership이다. |
| Terra 실행 제약 | host protocol, `vscode` state key, DOM selector/data attribute, keyboard/focus를 characterization test로 먼저 고정한다. `window.__gsc*`는 migration bridge이며 새 public API가 아니다. 한 추출은 독립 syntax/type/target test를 가진다. |
| 완료 기준 | 각 책임 모듈이 300~600라인 내외로 응집되고, coordinator가 UI business logic을 다시 흡수하지 않으며 기존 Changes 기능이 regression test를 통과한다. |

### D-009 — 반응형 breakpoint의 단일 권위

| 항목 | 내용 |
| --- | --- |
| 상태 | `decided` |
| 판단 질문 | Review Center, Workspace, sidebar가 서로 다른 breakpoint를 유지할지, 계획의 320/560/800/1200 상태 전환을 공통 계약으로 고정할지 |
| 선택지 | (A) surface별 독립 media query. (B) 공통 viewport/container state contract + CSS 우선, 필요한 JS에만 `ResizeObserver`. |
| 현재 근거 | 상세 계획은 320/560/800/1200 기준과 container 기반 판단을 요구한다. 현 Review detail과 sidebar는 서로 다른 기준을 사용해 responsive drift 위험이 있다. |
| Sol max 선택 | 공통 권위는 같은 숫자가 아니라 semantic layout state다. Center/Workspace는 compact `<560`, medium `560–799`, wide `800–1199`, full `≥1200`; sidebar는 별도 container family로 280/360/480 검증 기준을 유지한다. |
| Terra 실행 제약 | CSS/container query를 기본으로 하고 pane 보존·행동 전환에만 `ResizeObserver`를 쓴다. 단순 폭 판정을 JS/CSS에 중복하지 않는다. |
| 완료 기준 | 각 family의 단일 threshold 표, 320px/200% zoom, focus/overflow/column/pane screenshot+a11y matrix가 검증된다. |
| 재검토 | 실제 VS Code container 측정과 CSS viewport가 다르게 동작하는 재현 사례에서만 JS state authority를 확대한다. |

### D-010 — 미완성 surface의 release 노출 정책

| 항목 | 내용 |
| --- | --- |
| 상태 | `decided` |
| 판단 질문 | checkpoint 구현 중 불완전한 Reviews/management write UI를 사용자에게 어떻게 노출할 것인가 |
| Sol max 선택 | read shell은 공개할 수 있으나, write와 legacy redirect는 해당 slice의 fixture·permission·smoke gate가 통과할 때 내부 context gate로 원자적으로 활성화한다. |
| Terra 실행 제약 | package contribution만으로 write affordance가 노출되지 않게 한다. 미완성 write는 정확한 unavailable reason을 보여 주며, legacy flow를 무단 제거하지 않는다. |
| 완료 기준 | read-only와 write-enabled 상태가 feature/context gate, tooltip, disabled reason, automated fixture로 구분된다. |
| 재검토 | context gate가 existing command/state migration을 깨는 증거가 있으면 Sol max가 compatibility bridge를 재결정한다. |

### D-011 — Reviews cached count와 sidebar failure shell의 보안 경계

| 항목 | 내용 |
| --- | --- |
| 상태 | `decided` |
| 판단 질문 | Reviews 첫 진입을 빠르게 만들기 위해 어떤 GitHub queue 데이터를 영속화하고, auth/offline/error를 어떻게 구분할 것인가 |
| Sol max 선택 | 전체 `ReviewQueueSnapshot`은 런타임 메모리에만 둔다. `workspaceState`에는 repository·account fingerprint와 `fetchedAt`, Personal/Management의 **집계 count만** 담은 `ReviewQueueCountCacheV1`을 저장한다. 0–5분 cache는 즉시 복원 후 background revalidate, 5분–24시간은 stale 표시 후 revalidate, 24시간 초과/corrupt/schema·queryVersion 변경은 삭제한다. |
| 보안 제약 | PR 제목/번호/URL/작성자/branch/review 내용, remote URL/path, session/token은 cache와 webview state에 넣지 않는다. hash는 격리용 fingerprint일 뿐 암호화가 아니다. account를 확인할 수 없거나 auth가 revoked/401이면 이전 account cache를 즉시 숨기고 해당 record를 삭제한다. transient offline/error는 유효 cache를 덮어쓰지 않는다. |
| Shell 선택 | first load + usable cache 없음만 skeleton이다. cache/메모리 snapshot이 있으면 refreshing으로 유지한다. `empty`, `authRequired`, `permissionDenied`, `offline`, `rateLimited`, `error`를 typed failure로 구분한다. 한 scope 실패가 다른 scope 성공 데이터를 지우지 않고, Management는 role 추정/0 count 때문에 숨기지 않는다. |
| Terra 실행 제약 | `reviewQueueCountCache`·Reviews state reducer·service failure mapper·Changes migration을 UI/provider에서 분리한다. existing view/command ID는 유지한다. 상태 메시지는 sanitized Output log와 accessible label/tooltip/live announcement를 가진다. |
| 완료 조건 | cache TTL/zero/corrupt/auth invalidation/metadata 미저장, loading·cached-refreshing·auth·offline·rate limit·stale response, Personal/Management 독립성을 unit/model test로 고정한다. 280/360/480 sidebar에서 repository header·operation banner·state shell과 focus/overflow를 visual/a11y로 입증한다. |
| 재검토 | PR 행 metadata 영속화, globalState/기기간 cache 공유, 24시간 초과 보존, account 미확인 cache 노출, Management role 기반 숨김, queue membership 변경이 필요하면 Sol max에 다시 위임한다. |

### D-012 — Sidebar primary mode를 VS Code-native switched-view pair로 구현한다

| 항목 | 내용 |
| --- | --- |
| 상태 | `decided` |
| 판단 질문 | 같은 Activity Bar container의 기존 `gitSimpleCompare.changes`/`gitSimpleCompare.reviews`를 하나의 root tab webview로 합칠지, 기존 ID를 유지하면서 동급 primary mode를 어떻게 보일지 |
| Sol max 선택 | **C**: 두 view ID를 canonical surface로 그대로 유지하고 `gitSimpleCompare.sidebarMode` context key로 contribution `when`을 상호배타화한 switched-view pair를 쓴다. 기본은 Changes이며 Reviews mode일 때만 Reviews가 표시된다. root control은 webview 간 전환이므로 ARIA tab이 아니라 `nav` 안의 button + `aria-current`다. Reviews 내부 Personal/Management만 계속 실제 tablist/tab/tabpanel이다. |
| 호환 제약 | `SidebarModeController`가 versioned workspaceState `{version:1, mode:'changes'|'reviews'}`의 유일 SoT다. mode를 webview getState에 중복 저장하지 않는다. 기존 view/command ID, provider, title-menu `view == ...` 조건은 유지한다. 최소 engine의 `.open` command는 쓰지 않고 persist → setContext → `<viewId>.focus` 순으로 전환한다. |
| Shared shell 계약 | Changes/Reviews가 같은 sidebar shell primitive를 사용한다. 이후 `SidebarContextSnapshot`은 repository 목록·active repository·sync·operation(merge/rebase/cherry-pick/revert, conflicts/continue/skip/abort)을 하나의 read model로 전달한다. repository 선택은 controller SoT로 올리고, operation action은 기존 command만 호출한다. Reviews의 Personal/Management/owner/team scope와 섞지 않는다. |
| 완료 조건 | manifest의 두 ID와 when 상호배타, default/restored mode, rapid switch stale guard, direct wrapper command, Activity Bar reopen, per-view filter/focus/scroll/draft 보존을 격리 Extension Host에서 입증한다. root nav와 nested Reviews tab 의미론, 280/360/480·dark/light/HC·no-repo/multi-repo/operation+conflict/긴 한국어를 DOM·axe·visual로 검증한다. |
| 재검토 | VS Code가 moved/hidden/collapsed view에서 focus command를 일관되게 복원하지 못하거나 extension host 재현에서 contribution when이 두 view를 동시에/모두 숨기는 경우에만 Sol max에 다시 위임한다. |

## 신규 위임 항목 템플릿

```md
### D-XXX — 짧은 결정 제목

| 항목 | 내용 |
| --- | --- |
| 상태 | `needs-sol` |
| 판단 질문 | 무엇을 결정해야 하는가 |
| 선택지 | A / B / C와 각각의 trade-off |
| Sol 선택 | 결정 후 기록 |
| 근거 | 코드·문서·사용자 요구·측정 결과 링크 |
| Terra 실행 제약 | 변경 가능한 범위와 금지 사항 |
| 완료 조건 | 자동/수동 검증 가능한 acceptance |
| 재검토 | 어떤 관측이 결정을 무효화하는가 |
```

## Terra 작업 기록 규칙

각 구현 PR 또는 checkpoint 설명에는 다음을 포함한다.

1. 적용한 `D-XXX` 번호와 영향을 받은 surface.
2. 결정에서 허용한 범위 안에서 한 구현 선택.
3. 실행한 target test와 visual/a11y 검증 여부.
4. 미실행 검증, 남은 리스크, 다음 Sol 판단이 필요한 지점.

## Checkpoint 구현 기록

### PR-01 — Shared UI foundation

| 항목 | 내용 |
| --- | --- |
| 상태 | `verified` |
| 적용 결정 | D-001(최소 실행 gate), D-003(checkpoint), D-005(fixture QA), D-006(단일 제한 runner), D-009(semantic responsive 기반) |
| 구현 범위 | `media/shared/`에 reset/token/control/navigation/data-display/feedback/layout CSS와 a11y, DOM keyed patch, keyboard, overlay/focus trap, versioned persistence, request revision, splitter, virtual-list browser primitive를 추가했다. 9개 webview HTML builder가 같은 versioned resource/nonce 순서로 이를 주입하고 body는 `gsc-surface` semantic root를 사용한다. |
| 호환 원칙 | 공통 CSS는 panel별 stylesheet보다 먼저 로드한다. 따라서 기존 화면의 panel-local 규칙이 우선하고, 이번 slice는 새 primitive를 강제 적용해 각 화면의 interaction을 바꾸지 않는다. |
| 자동 검증 | `npm run check-types`, `npm run compile`, `git diff --check`, `npm test -- test/sharedWebviewPrimitives.test.ts`(6 pass), `npm run test:a11y`(3 pass: axe/error, forced-colors focus), `npm run test:visual`(3 pass), `npm run test:extension`(격리 Development Host activation)가 통과했다. browser runner는 macOS sandbox 제약상 승인된 단일 외부 sandbox runner를 사용했다. |
| 남은 범위 | primitive의 surface별 채택, 280/360/480 sidebar와 320/560/800/1200 editor responsiveness, 실제 splitter/virtualized adapter와 high-volume frame budget은 PR-02 이후의 각 vertical slice에서 검증한다. non-fixture legacy panel의 visual matrix와 full `npm test`는 이 checkpoint의 통과 증거가 아니다. full suite는 15분 상한을 유지한 채 slow-suite profiling/분리가 필요하다. |

### PR-02 — Changes/Reviews 동급 sidebar shell (진행 중)

| 항목 | 내용 |
| --- | --- |
| 상태 | `in-progress` |
| 적용 결정 | D-003(checkpoint), D-005(fixture QA), D-006(제한 runner), D-009(sidebar breakpoint), D-011(cache 보안 경계), D-012(switched-view pair) |
| 이번 구현 | `SidebarModeController`가 versioned workspaceState를 유일 source of truth로 삼아 `persist → setContext → <view>.focus`를 직렬 처리한다. 기존 Changes/Reviews view ID와 title-menu 조건은 유지하고 contribution `when`만 상호배타화했다. 두 webview는 공통 `sidebarShell`의 `nav/button/aria-current` navigation을 쓰며, Reviews의 Personal/Management는 독립적인 실제 tablist로 남겼다. |
| cache/error 범위 | workspaceState에는 repository/account fingerprint와 Personal/Management의 count projection만 보관한다. full PR snapshot·token·remote path·PR metadata는 영속화하지 않으며 cached summary에서는 write affordance를 렌더하지 않는다. typed queue failure는 auth/permission/offline/rate-limit/generic 메시지로 안전하게 매핑한다. auth shell은 사용자 클릭 때만 별도 터미널에서 `gh auth login`을 시작하고, 모든 오류 shell은 Output 진단 action을 제공한다. |
| 자동 검증 | `npm test -- test/sidebarModeState.test.ts test/sidebarModeController.test.ts test/sidebarModeManifest.test.ts` 6 pass, `npm test -- test/reviewQueueCountCache.test.ts test/pullRequestReviewQueueFailure.test.ts` 7 pass, `npm run check-types`, `npm run compile`, `git diff --check` 통과. 실제 renderer fixture에서 `npm run test:webview` 7 pass, `npm run test:a11y` 5 pass, `npm run test:visual` 5 pass. 격리 Extension Development Host smoke는 활성화와 `showChanges`/`showReviews` command 등록·실행을 통과했다. visual은 Changes/Reviews 280/360/480px의 root overflow와 Commit/menu action viewport, 280px auth shell action을 검사했고, Changes·Reviews·auth 결과를 직접 확인했다. |
| 아직 남은 증거 | 실제 Extension Host에서 restored mode, Activity Bar reopen, contribution when의 동시/공백 노출, per-view scroll/filter/draft 보존을 확인해야 한다. sidebar context snapshot(저장소·operation·conflict)은 아직 공통 read model로 승격되지 않았고, D-011의 모든 state reducer/independent-scope test와 D-010의 write gate도 후속 slice다. |
