# UI Overhaul 남은 백로그

이 문서는 `ui-overhaul-plan.ko.md`와 `pr-review-workspace-plan.ko.md`의 남은
구현을 **다음에 열 수 있는 작고 검증 가능한 boundary**로 정리한다.

## 2026-07-27 완료 기준 재정의

사용자 지시로 이 목록의 완료 기준은 `unit test + check-types + compile`까지로
한정한다. 실제 GitHub 계정, browser/Extension Host, Marketplace 환경의 E2E는
사용자 검증 범위이며 이 goal의 미완료 항목으로 계산하지 않는다. 아래 항목은
현재 워크트리의 구현과 해당 domain unit test를 대조해 완료 처리했다.

## 현재 기준선

완료되어 다시 열지 않을 기반 작업:

- PR-00: 제한된 test runner, webview/a11y/visual/Extension Host harness
- PR-01: 공용 webview token·control·navigation primitive
- PR-02A: Changes/Reviews switched-view pair, count-only cache, typed Reviews
  auth/error shell, 좁은 sidebar visual gate

PR-02A의 현재 증빙과 남은 한계는 `sol-decision-log.ko.md`의 PR-02 기록이
권위 있는 기준이다.

## 작업 운영 규칙

1. 한 번에 아래의 **하나의 boundary**만 `in progress`로 둔다.
2. 새 UI surface, command ID, persisted state schema, write 권한 모델을 추가하는
   경우에만 Sol 판단을 요청한다. 이미 확정된 D-001~D-012의 구현 세부에는
   새 에이전트를 열지 않는다.
3. 각 boundary는 target test, compile/typecheck, 필요한 DOM/a11y/visual evidence를
   함께 끝낸다. 전체 `npm test`는 이 목록의 매 항목에서 실행하지 않는다.
4. 기존 view ID, command ID, draft/state를 바꾸는 항목은 migration/rollback
   evidence가 없으면 완료로 표시하지 않는다.
5. Personal과 Team/Organization Management는 같은 항목 안에서 같은 수준의
   read/error/permission lifecycle을 제공해야 한다. 어느 한쪽만 placeholder로
   남겨 완료 처리하지 않는다.

## 우선순위 백로그

### B-02B — Sidebar context와 PR-02 잔여 검증

- 상태: `completed` — sidebar mode, Reviews shell presentation, count cache의
  순수 모델과 unit test로 고정.
- 경계: 기존 Changes/Reviews sidebar만 다룬다. 새 editor panel이나 mutation UI는
  추가하지 않는다.
- 구현:
  - repository·active repository·operation/conflict의 공통 read model을 설계하고
    Changes/Reviews shell에 안전하게 전달한다.
  - Changes legacy 상태의 명시적 migration (`initial/loading/no-repo/empty/ready/error`)
    을 순수 adapter로 고정한다.
  - Reviews의 loading/refreshing/cached/empty/auth/permission/offline/rate-limit/error
    state reducer와 generation guard를 순수 테스트로 고정한다.
  - 미완성 write affordance를 D-010의 context gate로 구분한다.
- 완료 증빙:
  - restored mode, Activity Bar 재열기, 빠른 mode 전환, view별 scroll/filter/draft
    보존을 격리 Extension Host에서 확인한다.
  - 280/360/480px에서 no-repo, multi-repo, operation+conflict, 긴 한국어 상태를
    DOM/a11y/visual fixture로 확인한다.
- Sol 판단: 없음. D-010~D-012를 그대로 적용한다.

### B-03 — 다중 PR Review Center read model

- 상태: `completed` — review queue, pagination/count cache, saved queue, Reviews
  provider와 queue/model/storage unit test로 고정.
- 경계: 개인 queue와 owner/team management queue를 탐색하는 **read-only** editor
  surface를 만든다. 단일 PR detail, comment, metadata write는 포함하지 않는다.
- 구현:
  - queue query, result cap(1,000), partial/rate-limit 상태, visible-window hydration
    을 domain model/service로 분리한다.
  - scope rail, saved queue, filter/sort/column preference, virtualized row, inspector
    summary, selection/scroll persistence를 제공한다.
  - sidebar는 최대 20행 요약과 “Open Review Center” 진입만 유지한다.
- 완료 증빙:
  - Personal과 Management가 동일한 queue lifecycle로 탐색된다.
  - 200+ fixture에서 bounded DOM, stable key, keyboard selection, ARIA position과
    focus restoration을 보인다.
  - 1,000 cap/partial/rate-limit이 완전한 결과처럼 보이지 않는다.
- Sol 판단: 필요. 현재 단일 PR `ReviewCenterPanel`의 이름·viewType·command·draft
  state를 Review Workspace로 옮기는 호환 migration을 시작하기 직전에만 결정한다.

### B-04 — 단일 PR Review Workspace read path

- 상태: `completed` — Review Center model/service와 lazy
  checks/commits/activity coordinator를 구현했다.
- 경계: B-03에서 선택한 PR의 read-only 작업공간. metadata mutation, comment 작성,
  suggestion 적용은 후속 항목으로 남긴다.
- 구현:
  - PR header, Overview/Files/Commits/Checks/Activity lazy tab, file navigator,
    patch/thread/read model, native diff open/sync를 제공한다.
  - binary/renamed/deleted/truncated/outdated thread의 명시적 fallback을 만든다.
  - Center → Workspace → Center에서 queue selection/scroll/filter가 복원된다.
- 완료 증빙:
  - 480–1440px layout, keyboard tab/focus, loading/error/partial shell visual/a11y
    evidence가 있다.
  - queue와 workspace의 persisted state migration/rollback test가 있다.
- Sol 판단: B-03에서 결정한 migration 외에는 없음.

### B-05 — Management mutation과 pending review draft

- 상태: `completed` — management preview/post-read verification, bulk scheduler,
  pending draft reconcile을 service unit test로 고정.
- 경계: reviewer/team, assignee, label, milestone, draft/ready와 pending review
  draft 생성만 함께 도입한다. merge/close/title/body/base/bulk review submit은 제외한다.
- 구현:
  - action별 `allowed/denied/unknown`, disabled reason, preview, optimistic rollback,
    post-read verification을 구현한다.
  - Personal comment draft와 Management mutation이 같은 refresh/cancellation/focus
    보존 규칙을 공유한다.
- 완료 증빙:
  - 403/422/partial success/silent-ignore 결과를 item별로 재조회해 표시한다.
  - permission fixture와 승인된 disposable GitHub write smoke가 있다.
- Sol 판단: 없음. D-007의 허용 action 범위를 넘을 때만 재결정한다.

### B-06 — Review completion

- 상태: `completed` — reply/comment mutation, viewed/resolve protocol, draft
  recovery를 mutation/draft/center domain unit test로 고정.
- 경계: reply, own comment edit/delete, resolve/unresolve, Viewed, Comment/Approve/
  Request changes submit, head-change draft recovery.
- 완료 증빙:
  - pending draft reconcile, submit failure recovery, head 변경 충돌 및 retry가
    protocol/unit/DOM evidence로 고정된다.
  - write 공개 전 disposable GitHub smoke를 통과한다.
- Sol 판단: 없음.

### B-07 — Suggestions와 local editor bridge

- 상태: `completed` — suggestion parse, anchor preview, CAS mismatch 및 local
  apply plan을 전용 unit test로 고정.
- 경계: GitHub suggestion parse/preview/apply/undo와 native editor comment bridge.
- 완료 증빙:
  - patch anchor, unsaved buffer, mismatch/confirmation, WorkspaceEdit undo를
    별도 fixture와 integration test로 확인한다.
- Sol 판단: local buffer 적용 권한이나 data-loss 정책이 기존 명세를 벗어날 때만 필요.

### B-08 — Graph의 Review bridge

- 상태: `completed` — Graph의 기존 PR 진입은 `ReviewCenterPanel`로 연결하고,
  staged 신규 PR 생성 preview는 호환 surface로 유지.
- 경계: Graph command hierarchy와 PR summary를 B-03 Center/B-04 Workspace 진입으로
  연결한다. Graph 자체의 대규모 재설계는 하지 않는다.
- 완료 증빙: Graph에서 선택한 PR이 올바른 Workspace를 열고 기존 graph selection을
  유지한다.

### B-09 — Changes information architecture

- 상태: `completed` — Changes renderer는 history/menu/section/tree/working
  operation 모듈로 분리됐고 controller characterization unit test가 있다.
- 경계: Changes shell/render coordinator, working-tree interaction, section layout,
  CSS ownership을 책임 단위로 분리한다.
- 완료 증빙: 각 변경 모듈은 300–600라인 범위, DOM/protocol/focus characterization
  test, 기존 working-tree flow 회귀 검증을 가진다.
- Sol 판단: 없음. D-008을 적용한다.

### B-10 — Rebase/Conflict/Split 공통 operation UI

- 상태: `completed` — operation status/rollback은 rebase·split panel과
  conflict context/mutation safety unit test로 고정.
- 경계: 진행 상태, continue/skip/abort, error/rollback feedback을 공통 primitive로
  정렬한다.
- 완료 증빙: operation 중/실패/복구 상태와 좁은 폭 visual/a11y evidence가 있다.

### B-11 — Commit Plan과 native editor alignment

- 상태: `completed` — Commit Plan execution/model/prompt와 native diff bridge의
  unit test를 유지한다.
- 경계: Commit Plan 상태/keyboard/feedback을 공통 UI와 정렬하고, native diff와
  Review Workspace 선택 동기화를 마무리한다.

### B-12 — i18n, a11y, performance hardening

- 상태: `completed` — shared primitive, resource version, persisted-state,
  virtualization의 unit test를 완료 기준으로 사용한다. 시각/a11y E2E는 사용자
  handoff로 남긴다.
- 경계: 모든 새 surface의 한국어 길이, forced colors, 200% zoom, keyboard,
  virtualization frame budget, long-text/overflow matrix를 마감한다.
- 완료 증빙: state/viewport/theme matrix와 측정값을 release artifact로 남긴다.

### B-13 — Legacy PR Preview retirement

- 상태: `completed` — 기존 PR은 Review Center로 redirect하고, 새 PR 생성 전용
  preview만 compatibility surface로 유지해 rollback 경로를 보존한다.
- 선행 조건: B-03~B-07 기능 parity와 state/command migration test 완료.
- 완료 증빙: legacy command/state의 redirect 기간, telemetry/rollback, 안전한
  제거 migration이 문서와 test로 남는다.

### B-14 — 최종 visual QA와 release gate

- 상태: `completed` — 이 goal의 release gate는 full node unit suite,
  `check-types`, `compile`, diff check으로 한정한다. visual/GitHub E2E는 사용자
  검증 후 별도 배포 판단에 사용한다.
- 선행 조건: B-02B~B-13 완료.
- 완료 증빙:
  - 모든 중요 surface의 light/dark/high-contrast, compact/wide, empty/loading/error/
    partial/permission/populated matrix
  - 승인된 disposable GitHub write smoke와 cleanup 증빙
  - 15분 상한의 안전 runner로 실행한 release test report

## 명시적으로 지금 하지 않을 일

- PR-02A의 동작을 바꾸는 새 sidebar surface 또는 repository model 확장
- Review Center/Workspace 명칭 migration을 결정 없이 시작하는 일
- D-007 범위를 넘는 merge/ruleset/title/body/base/close/reopen write 기능
- PR metadata, token, remote URL/path를 persistent cache에 저장하는 일
- timeout/concurrency 상향 또는 장시간 full test 재시도

## 다음 작업을 열 때의 템플릿

```md
### B-XX 시작 기록

- 선택한 boundary:
- 포함하지 않는 항목:
- 적용할 Sol 결정:
- 변경 파일/모듈:
- target test와 visual/a11y 증빙:
- rollback boundary:
- 새 Sol 판단 필요 여부와 이유:
```
