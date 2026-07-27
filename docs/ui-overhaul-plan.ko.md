# Git Simple Compare UI 대개편 실행 계획

> 상태: 구현 전 승인용 계획  
> 대상 구현자: Terra High  
> 관련 문서: [`PRODUCT.md`](../PRODUCT.md), [`DESIGN.md`](../DESIGN.md),
> [`pr-review-workspace-plan.ko.md`](./pr-review-workspace-plan.ko.md)

## 0. 이 계획에서 고정한 결정

이 문서의 결정은 구현 중 다시 선택하지 않는다. 저장소나 GitHub API의 실제 제약이
문서와 충돌할 때만 근거를 OUTPUT 로그와 변경 PR 설명에 남기고 최소 범위로
수정한다.

1. **개인 UI와 관리 UI는 동급이다.** 개인 개발자/리뷰어의 빠른 리뷰와 팀 리드,
   저장소 관리자, 조직 사용자의 PR 큐·담당·검토·체크·정책 관리 경험을 동시에
   핵심 범위로 둔다. 관리 UI는 개인 UI가 끝난 뒤 착수하는 후순위 단계가 아니다.
2. **GitHub 전용이다.** GitLab, Bitbucket, 자체 호스팅 forge 추상화는 이번 범위에
   넣지 않는다.
3. **외부 백엔드를 만들지 않는다.** 로컬 `git`, 현재 `gh` CLI, 현재 선택적 GitHub
   웹 세션만 사용한다.
4. **새 프런트엔드 프레임워크를 도입하지 않는다.** 현재 TypeScript host + vanilla
   HTML/CSS/JS webview 구조를 유지하고, 공유 모듈·reducer·component primitive로
   정리한다. React/Preact/Vite 도입은 이 계획의 전제도 산출물도 아니다.
5. **VS Code가 시각 권한자다.** 테마 색, UI 글꼴, editor 글꼴, Codicon, focus
   문법을 상속한다. 고정된 새 브랜드 팔레트나 웹 폰트를 만들지 않는다.
6. **현재 기능을 삭제하지 않는다.** Changes, compare, editable diff, graph, reflog,
   stash, worktree, conflicts, rebase, split commit, commit plan, PR stack은 새 정보
   구조 안에서 유지한다.
7. **PR 리뷰 범위는 완결형이다.** 대화, file/line comment, multi-line comment,
   suggestion 작성·로컬 적용, GitHub Viewed 동기화, reply, resolve/unresolve,
   Comment/Approve/Request changes 제출을 포함한다.
8. **파일은 300–600라인을 지킨다.** 새 코드 파일은 600라인을 넘기지 않는다.
   기존 대형 파일을 수정하는 변경 PR은 먼저 또는 같은 변경 PR 안에서 책임을
   분리한다.
9. **기본 UI는 영어, 한국어 번역을 제공한다.** 새 사용자 문자열을 JS/CSS/HTML에
   직접 박지 않는다.
10. **모든 버튼형 컨트롤은 tooltip과 접근성 이름을 가진다.** 아이콘 버튼,
    `role="button"`, hover-only action을 예외로 두지 않는다.

## 1. 성공 정의

### 1.1 제품 수준 성공 조건

- 사용자는 Activity Bar 진입 후 5초 안에 현재 저장소, 브랜치, 작업트리 상태와
  자신에게 필요한 리뷰 수를 파악할 수 있다.
- 사용자는 Review Center의 PR 행에서 한 번의 활성화로 해당 파일/스레드 문맥의
  Review Workspace에 진입하고, 뒤로 이동했을 때 큐 상태를 그대로 복원한다.
- 사용자는 브라우저를 열지 않고 PR 전체 리뷰를 시작하고, pending comment를
  검토하고, Comment/Approve/Request changes 중 하나로 제출할 수 있다.
- 팀·조직 사용자는 저장소·team·reviewer·author·label·checks·review decision·
  update age로 PR을 탐색하고, 권한이 있는 metadata를 같은 화면에서 관리할 수 있다.
- 새 push가 기존 review draft를 무효화할 수 있을 때 확장이 이를 숨기지 않고
  제출 전에 차단하거나 사용자가 명시적으로 새 head로 재검증하게 한다.
- 1,000개 파일 또는 수천 개 댓글처럼 큰 입력에서도 초기 shell이 즉시 보이고,
  점진적 로딩과 windowing으로 탐색이 가능하다.

### 1.2 UI 품질 성공 조건

- Dark, Light, High Contrast Dark, High Contrast Light에서 내용과 focus가 읽힌다.
- 480, 560, 800, 1024, 1440px의 webview 가용 폭에서 핵심 action이 잘리거나
  가려지지 않는다.
- 200% 확대, 한국어, 긴 영어, 긴 파일 경로에서 가로 스크롤이 필요한 곳과 아닌
  곳이 명확하다.
- 핵심 workflow는 마우스 없이 수행 가능하다.
- loading, empty, filtered-empty, partial error, full error, permission denied,
  disabled, pending, success, stale, rate limited 상태가 서로 구분된다.
- build/typecheck/unit test 통과와 별도로 실제 Extension Development Host에서
  visual/interaction QA를 완료한다.

### 1.3 성능 예산

- Activity Bar shell: 첫 HTML paint 후 100ms 안에 skeleton 또는 cached state 표시.
- Review Center: 첫 50개 요약 행을 데이터 수신 후 100ms 안에 표시.
- Review Workspace: metadata shell을 먼저 표시하고 files/threads/checks를 병렬
  지연 로드한다.
- DOM에 동시에 유지하는 diff row는 기본 2,000개 이하, queue/file row는 viewport
  기준 overscan 8행 이하로 유지한다.
- 사용자가 입력 중인 검색, composer, resize interaction에서는 16ms를 넘는 동기
  연산을 피한다.
- 모든 host 요청은 request id와 revision을 가져 stale response가 최신 UI를
  덮어쓰지 못하게 한다.

## 2. 조사 결과와 현재 기준선

### 2.1 실제 화면에서 확인한 점

Extension Development Host에서 Changes, Git Graph, Staged PR Preview를 직접
열어 확인했다.

- Changes는 VS Code Source Control과 잘 어울리는 밀도와 테마를 갖지만,
  `Repositories`, `Changes`, `History`, `Compare Branches`, `Stashes`,
  `Worktrees`가 모두 같은 accordion 위계에 놓여 현재 작업과 보조 도구의 중요도가
  구분되지 않는다.
- 사이드바 상단과 Changes composer 주변에 작은 아이콘 action이 많아 좁은 폭에서
  의미와 우선순위를 알아보기 어렵다.
- Graph 상단은 fetch/pull/push/PR/stack/reflog/HEAD/details/search/filter action이
  한 줄에 경쟁한다. 오른쪽 details가 비어 있어도 공간을 차지할 수 있다.
- Staged PR Preview는 VS Code 테마와 잘 섞이지만 “PR 생성 전 미리보기”와
  “기존 PR 리뷰”가 한 표면에서 섞여 있다. 4개의 동일한 통계 카드가 주 작업보다
  높은 시각 비중을 가진다.
- 현재 PR 화면의 conversation/files/commits는 읽기 중심이다. Viewed는 local
  webview state이고 GitHub viewer state가 아니다.
- 기존 inline comment와 suggestion은 표시할 수 있지만, reply/resolve/새 comment/
  review submit으로 이어지는 완결된 흐름이 없다.

### 2.2 코드 기준선

| 영역 | 현재 위치 | 유지할 자산 | 해결할 구조 문제 |
|---|---|---|---|
| Changes | `src/webview/changes*`, `media/changes/` | VS Code 밀도, section 상태, commit composer | root JS/CSS 비대화, 모든 섹션 같은 위계 |
| Graph | `src/webview/graph*`, `media/graph/` | DAG layout, virtual rows, branch/search/reflog 기능 | toolbar 과밀, PR UI 중복, detail 공간 경직 |
| PR | `src/webview/pullRequestPreview*`, `src/git/pullRequest*` | branch combobox, diff render, conversation/file/commit fetch | preview/review 책임 혼합, write workflow 부재 |
| Native review | `src/providers/pullRequest*`, `src/ui/pullRequest*` | VS Code Comment API 연결, markdown/suggestion 표시 | reply 불가, workspace 상태와 분리 |
| Rebase | `src/webview/rebase*`, `media/rebase/`, graph rebase 모듈 | todo 편집, progress, AI plan | standalone/graph 표현 중복 |
| Split | `src/webview/split*`, `media/split/` | hunk 선택과 commit 분할 | 단일 JS 비대화, 공통 control 부재 |
| Conflicts | `src/providers/conflicts*`, editor overlays | native editor/merge editor 통합 | 작업 상태 요약과 복구 동선 분산 |

현재 큰 UI 파일 중 우선 분리 대상:

- `media/changes/changes.js`: 2,127라인
- `media/changes/changes.css`: 1,207라인
- `media/split/split.js`: 972라인
- `media/graph/graph.js`: 639라인
- `media/graph/graph.css`: 611라인
- `media/graph/graphPr.css`: 635라인

새 기능을 위 파일에 계속 덧붙이지 않는다. 각 화면 변경 PR의 첫 작업은 touched
영역을 300–600라인 책임 모듈로 나누는 것이다.

### 2.3 접근성/UX 기준선

계획에서 반드시 해소할 현재 패턴:

- `outline: none`을 사용하지만 동일한 수준의 `focus-visible` 대체가 없는 input.
- `aria-selected`는 있으나 `tablist/tab/tabpanel`, roving tabindex, 화살표 키가
  완성되지 않은 탭.
- innerHTML 전체 재렌더로 focus와 scroll anchor가 사라질 수 있는 흐름.
- error가 `role="alert"` 또는 `aria-live` 없이 일반 문장으로만 삽입되는 흐름.
- host는 번역하지만 webview client 문자열은 영어 literal인 부분.
- 공통 instant tooltip이 있는데도 표면별 tooltip 구현이 중복된 부분.
- 22–28px icon action이 hover에서만 나타나거나 target이 지나치게 작은 부분.
- hard-coded 색과 테마에 종속되지 않는 고정 tooltip 배경.

## 3. 디자인 방향

상세 계약은 [`DESIGN.md`](../DESIGN.md)를 따른다.

### 3.1 한 문장 방향

**“The Native Control Room”: VS Code가 원래 제공했을 법한 차분하고 고밀도인
Git/Review 작업 제어면.**

### 3.2 고정 수치

- 정보 밀도: 9/10
- 시각적 변주: 3/10
- 모션 강도: 2/10
- 기본 spacing: 2, 4, 6, 8, 12, 16, 24px
- compact row: 26px
- 일반 input/button: 28px
- radius: row/badge 2px, control 3px, floating surface 4px
- typography: VS Code UI/editor 설정 상속
- primary button: 한 작업 영역에 하나

### 3.3 금지할 시각 방향

- GitHub 웹 화면의 복제
- 큰 둥근 카드가 반복되는 SaaS dashboard
- gradient, glassmorphism, 고정 브랜드 hex, 별도 웹 폰트
- 통계 수치를 이유 없이 같은 크기 카드로 나열
- 핵심 action을 hover-only로 숨기기
- 모든 action을 한 줄의 icon toolbar에 같은 위계로 배치

## 4. 목표 정보 구조

```text
Git Simple Compare Activity Bar
├─ Sidebar Shell
│  ├─ Changes
│  │  ├─ Repository context
│  │  ├─ Working Changes + Commit
│  │  └─ Tools: History / Compare / Stashes / Worktrees
│  └─ Reviews
│     ├─ My review summary
│     ├─ Saved queues
│     ├─ Compact PR rows
│     └─ Open Review Center
├─ Editor Workspaces
│  ├─ Review Center (개인 + 팀/조직 관리 큐)
│  ├─ Review Workspace (개별 PR)
│  ├─ Git Graph
│  ├─ Commit Plan
│  ├─ Interactive Rebase
│  └─ Split Commits
└─ Native Editor Surfaces
   ├─ Editable Diff
   ├─ PR Review Comments
   ├─ Hunk Stage Controls
   ├─ Conflict/Merge Editor
   └─ Blame / CodeLens
```

### 4.1 Sidebar Shell

기존 view id `gitSimpleCompare.changes`는 설치/상태 호환을 위해 유지한다. contribution
title은 일반화하고 webview 최상단에 `Changes`/`Reviews` 2개 primary mode를 둔다.
두 mode는 탭 의미론과 키보드 이동을 지원한다.

Sidebar가 담당하는 일:

- 현재 저장소와 branch, sync/operation 상태
- 작업트리와 commit의 빠른 수행
- 나에게 필요한 review와 saved queue의 빠른 확인
- 전체 편집기 workspace를 여는 entry point

Sidebar가 담당하지 않는 일:

- 대형 diff 읽기
- 조직 전체 PR의 다중 열 관리
- review submit 최종 확인
- 복잡한 rebase/stack 편집

### 4.2 Review Center

개인 inbox와 팀/조직 관리 UI를 하나의 편집기 workspace로 제공한다. 기본 saved
queue는 `Needs my review`, `Authored by me`, `Assigned to me`, `Mentioned`,
`Team review`, `Blocked`, `Stale`, `Draft`, `Stacks`다. 조직/team 범위는 사용자가
연결된 저장소에서 발견하거나 명시적으로 추가한다.

개인과 관리의 차이는 별도 제품 mode가 아니라 filter/scope/columns/permissions다.
따라서 동일한 행, 동일한 상태 모델, 동일한 Review Workspace를 사용한다.

### 4.3 Review Workspace

대형 폭에서는 `File navigator / Diff / Review inspector` 3열, 중형은 2열, 좁은
폭은 한 열 + drawer로 바뀐다. Overview, Files, Commits, Checks, Activity는
같은 PR shell 아래에 놓고, Files가 리뷰 작업의 기본 tab이다.

### 4.4 Graph

Graph는 commit DAG가 주인공이다. 원격 sync, PR, stack, reflog, rebase는 command
group과 context action으로 정리한다. PR 목록/관리의 주 surface는 Review Center이고,
Graph의 PR 기능은 선택 branch/commit과 연관된 PR 및 stack 문맥을 보여주는
bridge 역할을 한다.

## 5. 공통 UI 기반

### 5.1 새 공유 파일 구조

각 파일은 300–600라인을 넘지 않도록 책임을 나눈다.

```text
media/shared/
├─ reset.css                 # webview 기본 reset, forced-colors
├─ tokens.css                # VS Code semantic alias, spacing, size, z-index
├─ controls.css              # button, icon-button, input, segmented control
├─ navigation.css            # tabs, command bar, breadcrumb
├─ data-display.css          # row, badge, status, progress, metadata
├─ feedback.css              # skeleton, empty, banner, inline error, toast
├─ layout.css                # splitter, drawer, inspector, responsive primitives
├─ a11y.js                   # focus restore, live region, reduced motion
├─ dom.js                    # safe DOM builders, keyed patch helpers
├─ keyboard.js               # roving tabindex, shortcut registry
├─ overlay.js                # menu, popover, dialog, focus trap
├─ persistedState.js         # versioned getState/setState adapter
├─ requestState.js           # requestId/revision, stale response guard
├─ splitter.js               # pointer + keyboard resize
├─ virtualList.js            # fixed/estimated row windowing
└─ instantTooltip.*          # 기존 자산을 단일 구현으로 유지

src/webview/shared/
├─ webviewI18n.ts            # host가 번역된 dictionary를 주입
├─ webviewProtocol.ts        # request envelope와 공통 error
├─ webviewStateVersion.ts    # persisted state migration
├─ webviewResources.ts       # 공통 CSS/JS URI와 nonce 조립
├─ webviewDiagnostics.ts     # OUTPUT 로그용 UI 상태 요약
└─ webviewTestHarness.ts     # fixture HTML 생성용 공통 shell
```

`media/shared/tokens.css`는 `DESIGN.md`의 의미 역할만 alias한다. 예:

```css
:root {
  --gsc-bg: var(--vscode-editor-background);
  --gsc-surface: var(--vscode-editorWidget-background);
  --gsc-fg: var(--vscode-foreground);
  --gsc-muted: var(--vscode-descriptionForeground);
  --gsc-focus: var(--vscode-focusBorder);
  --gsc-space-1: 2px;
  --gsc-space-2: 4px;
  --gsc-space-3: 6px;
  --gsc-space-4: 8px;
  --gsc-space-6: 12px;
  --gsc-space-8: 16px;
  --gsc-space-12: 24px;
}
```

고정 색은 토큰 파일에도 넣지 않는다. GitHub label처럼 외부 데이터가 제공하는 색은
대비 계산 후 inline custom property로만 전달한다.

### 5.2 공통 component 계약

모든 화면이 아래 component와 상태를 공유한다.

| Component | 필수 variant/state |
|---|---|
| Button | primary, secondary, ghost, danger; hover/focus/active/disabled/pending |
| IconButton | 24/28px; tooltip, `aria-label`, disabled reason |
| Input/Search | label, clear, invalid, pending, keyboard shortcut hint |
| Combobox | listbox, active descendant, async loading, no result, invalid value |
| Tabs | tablist/tab/tabpanel, arrows, Home/End, focus restore |
| StatusPill | icon + text + semantic color, tooltip detail |
| DataRow | selected, focused, hover, pending inline mutation, partial error |
| TreeRow | expanded, level, setsize/posinset, keyboard left/right |
| CommandBar | primary group, context group, overflow group |
| Splitter | pointer/keyboard resize, min/max, saved size |
| Drawer/Inspector | focus return, Escape, narrow overlay |
| Composer | markdown, suggestion, pending draft, validation, submit state |
| Skeleton | 화면 형태를 닮은 loading, reduced-motion |
| EmptyState | true empty, filtered empty, unavailable, permission/auth |
| InlineError | error summary, retry, settings/log action, live region |
| Progress | determinate/indeterminate, text equivalent |
| Toast | success/error, optional undo, focus non-stealing |

### 5.3 재렌더 규칙

- webview root의 `innerHTML = ...` 전체 교체를 금지한다.
- list는 stable key로 row를 patch한다.
- 사용자가 입력 중인 input/composer DOM node는 데이터 refresh로 교체하지 않는다.
- focus target과 scroll anchor를 state에 보관하고 patch 후 유효할 때 복원한다.
- 새 데이터가 현재 viewport 위에 삽입되면 anchor 기준으로 scroll offset을 보정한다.
- host response는 `requestId`, `resourceKey`, `revision`이 현재 값과 일치할 때만
  적용한다.

### 5.4 i18n 규칙

- host는 모든 사용자 문자열 dictionary를 `vscode.l10n.t`로 생성해 webview에
  전달한다.
- client는 `strings.key`만 사용한다. 영어 fallback은 dictionary 생성부에 둔다.
- 날짜·수치·상대 시간은 `Intl.DateTimeFormat`, `Intl.NumberFormat`,
  `Intl.RelativeTimeFormat`과 VS Code locale을 사용한다.
- HTML `lang`은 `vscode.env.language`에서 주입한다.
- action label과 tooltip은 같은 key를 공유하지 않아도 된다. tooltip은 대상과
  결과를 더 명확히 설명한다.

### 5.5 접근성 규칙

- semantic element를 우선하고 div에 role을 덧붙이는 방식은 최소화한다.
- 모든 focusable element에 visible focus가 있어야 한다.
- `outline: none`은 같은 selector에 대체 focus 표현이 있을 때만 허용한다.
- 상태 변화는 `aria-live="polite"`, 차단 오류는 `role="alert"`로 전달한다.
- diff line 전체를 tab stop으로 만들지 않는다.
- dialog는 이름, 설명, initial focus, focus trap, Escape, invoking control focus
  return을 갖는다.
- `prefers-reduced-motion`과 `forced-colors`를 별도로 스타일링한다.
- 화면별 keyboard shortcut은 VS Code 기본 shortcut과 충돌 검사 후 등록한다.
- `?` 또는 command palette에서 현재 화면 shortcut 도움말을 열 수 있게 한다.

## 6. 화면별 계획

### 6.1 Changes Sidebar

#### 목표 구조

```text
[Changes | Reviews]
[repository ▾] [branch] [operation]        [sync] […]

Working Changes · 12
[commit message composer.......................]
[AI] [Plan] [Hooks]            [Commit ▾]

[filter] [tree/list] [sort]
Staged · 4
  …
Changes · 8
  …

Tools
  History         active-file summary
  Compare         base → target summary
  Stashes         31
  Worktrees       3
```

#### 구현 규칙

- Repository 목록은 항상 펼쳐진 큰 section이 아니라 header combobox가 된다.
  multi-root/worktree 정보는 combobox option의 secondary text로 보인다.
- commit composer는 Working Changes와 한 덩어리로 유지한다.
- AI/Plan/Hooks는 아이콘만 두지 않고 좁은 폭에서 overflow로 이동해도 tooltip과
  command title을 유지한다.
- `Tools`는 최근/활성 상태 한 줄을 보여주고 선택 시 기존 세부 section을 펼친다.
- merge/rebase/cherry-pick/revert operation 중에는 header 아래 operation banner를
  표시하고 Continue/Skip/Abort/Conflicts를 한 그룹으로 둔다.
- Stage/Unstage/Discard 같은 row action은 keyboard와 context menu에서도 동일하게
  접근한다.

#### 상태

- 저장소 없음, 다중 저장소 발견 중, 저장소 전환 중
- clean working tree, staged only, unstaged only, untracked only
- commit message invalid, hook pending/failed/passed
- AI unavailable/configuring/running/cancelled/error
- git operation active, conflicts, stale status, watcher refresh skipped

#### 인수 조건

- 280px Sidebar 폭에서도 Commit primary action과 message composer가 잘리지 않는다.
- repository를 바꾸면 이전 repository의 message draft를 repository key별로 보존한다.
- 현재 파일이 없을 때 History는 일반 empty 상태를 보이고 layout을 과도하게
  차지하지 않는다.
- section reorder/visibility 기존 설정은 새 Tools order/visibility로 migration한다.

### 6.2 Reviews Sidebar

#### 목표 구조

```text
[Changes | Reviews]
[scope: All connected repos ▾]             [refresh]

Needs my review     8
Team review        14
Authored by me      5
Blocked             3

[search reviews…]
● repo #418  Harden draft recovery     Your review
  2 failed · 3 unresolved · updated 12m
…

[Open Review Center]
```

#### 구현 규칙

- review summary와 queue shell은 Changes와 같은 webview 안에서 mode로 렌더한다.
- 첫 진입은 cached summary를 즉시 보이고 background refresh한다.
- queue 행은 최대 20개만 sidebar에 렌더한다. 전체 결과는 Review Center에서 연다.
- saved queue는 built-in과 user-defined를 같은 목록에서 다루되 built-in 삭제는
  불가하고 숨김만 허용한다.
- 관리 scope는 repo, owner/org, team을 지원한다. 현재 local repository만 보도록
  제한하지 않는다.
- inline metadata mutation은 sidebar에 넣지 않는다. 관리 변경은 Review Center
  또는 Review Workspace inspector에서 수행한다.

#### 인수 조건

- 개인 queue와 team/org queue가 같은 첫 릴리스 범위에 포함된다.
- 인증이 없을 때 단순 빈 목록이 아니라 `Sign in with gh`, `Open setup`,
  `Open Git Simple Compare Output` action을 보인다.
- search cap/rate limit이면 결과가 완전한 것처럼 보이지 않고 범위 제한을 표시한다.

### 6.3 Review Center

세부 데이터와 mutation은 PR 리뷰 전용 계획을 따른다.

#### 주요 영역

- 상단: scope, saved query, search, filter tokens, sort, columns, refresh
- 좌측 선택 rail(좁은 폭에서는 없음): built-in/saved queues와 counts
- 중앙: virtualized PR table/list
- 우측 inspector: 선택 PR의 summary, reviewers, checks, policy, labels, stack
- 하단 status: loaded count, result cap, last refresh, partial errors

#### 기본 열

1. Repository / PR number
2. Title / author
3. Action needed
4. Review decision
5. Checks
6. Unresolved threads
7. Size / viewed progress
8. Updated

선택 열:

- Requested reviewers/teams
- Assignees
- Labels
- Milestone
- Base/head
- Draft/mergeability
- Stack position
- Age

#### 관리 행동

- reviewer/team request 추가·제거
- assignee 추가·제거
- label 추가·제거
- milestone 변경
- draft ↔ ready 전환
- title/body/base 변경은 Review Workspace inspector에서 수행
- merge/close는 이번 UI 개편에서 기존 기능을 연결하되 별도 confirmation을 유지

모든 mutation은 권한 field로 사전 gate하고, 서버가 silently ignore할 수 있는 REST
동작은 mutation 후 재조회로 검증한다.

### 6.4 Git Graph

#### 새 command bar

```text
[Refresh] [Sync ▾] [Branch ▾] [Review ▾] [History ▾] [More ▾]
[Search................................] [scope ▾] [branch filter] [HEAD]
```

- `Sync`: Fetch, Fetch Tags, Pull, Push, Force Push
- `Branch`: checkout, create, rename, merge/rebase actions
- `Review`: related PR, Review Center, staged preview, PR stack
- `History`: reflog, restore, unreachable commits
- `More`: less frequent display/layout actions

Force Push, branch delete, reflog drop 같은 위험 action은 일반 toolbar icon에서
직접 실행하지 않고 명명된 menu item + confirmation으로 연다.

#### layout

- commit graph/list가 가용 폭의 주 영역을 차지한다.
- details inspector는 선택 commit이 없으면 접힌다.
- inspector 폭은 280–520px, keyboard resize 16px step.
- 좁은 폭에서는 inspector가 overlay drawer다.
- 검색 결과/branch filter/loaded count는 한 줄에서 명확히 구분한다.

#### PR 연계

- branch/commit에 연관된 PR badge를 graph row에 유지한다.
- 선택 PR의 빠른 summary는 inspector에 보이고, 전체 queue는 Review Center로 연다.
- Graph에 별도의 대형 PR 목록 구현을 계속 확장하지 않는다.
- PR stack layer는 graph lane과 inspector에서 position/status를 공유한다.

### 6.5 PR Preview / Creation

기존 staged PR preview는 Review Workspace와 분리된 `Create Pull Request` 흐름으로
정리한다.

- source/target 선택
- title/body 생성·편집
- changed files/commits preview
- existing PR 감지
- publish 전 summary/permission/remote 상태 확인
- create 성공 후 새 Review Workspace로 전환

Conversation tab과 기존 PR review data는 creation 화면에서 제거한다. existing PR을
감지하면 `Open existing review`가 primary이고 중복 생성은 차단한다.

### 6.6 Conflicts

- Activity Bar의 conditional Conflicts tree는 유지한다.
- Changes header operation banner와 conflicts tree 상태를 같은 controller snapshot으로
  연결한다.
- 각 conflict row는 state, file path, resolution method, dirty 여부를 표시한다.
- Current/Incoming/Both/Mark Resolved는 tooltip과 command title을 유지한다.
- destructive Abort는 operation 유형, 대상 branch, 보존되는 변경을 confirmation에
  표시한다.
- 완료 후 success 상태에서 다음 가능한 Continue action으로 focus를 이동한다.

### 6.7 Interactive Rebase

- standalone와 Graph rebase가 `RebaseSessionViewModel`과 공통 row/control CSS를
  공유한다.
- todo row는 action, subject, SHA, validation, drag handle을 명확히 분리한다.
- drag만 의존하지 않고 keyboard move up/down과 action menu를 제공한다.
- preview, progress, conflicts, completion을 동일한 status region에서 보여준다.
- AI plan은 결과 적용 전 원본/제안 diff와 변경 수를 표시한다.

### 6.8 Split Commits

- `media/split/split.js`를 state/reducer, file list, hunk list, commit composer,
  message router로 분리한다.
- file/hunk 선택은 checkbox 의미와 keyboard Space를 지원한다.
- 선택된 hunk가 새 commit에 포함되는지, staged 상태가 어떻게 바뀌는지 summary를
  항상 표시한다.
- apply 중 파일 변경을 감지하면 CAS 실패를 inline error로 보여주고 refresh 없이
  자동 재시도하지 않는다.

### 6.9 Commit Plan

- plan summary, commit sequence, per-commit files, execution status를 위계화한다.
- primary action은 현재 단계에 따라 Generate 또는 Execute 하나만 보인다.
- hook failure는 해당 commit step 안에 표시하고 Output/Retry/Edit action을 둔다.
- 실행 전 unstaged/untracked/private repo safety 결과를 summary에 포함한다.

### 6.10 Native Editor UI

- editable diff, hunk checkbox, PR comment, blame, conflict overlay는 webview와 같은
  status vocabulary를 사용한다.
- Review Workspace에서 native diff를 열면 selected file/thread가 동기화된다.
- Comment API thread는 reply 가능 상태로 확장하고 webview thread와 ID를 공유한다.
- native editor에서 작성한 pending comment는 Review Workspace submit summary에
  즉시 나타난다.
- extension diff overlay가 지원되지 않는 VS Code build에서는 Output 로그와
  비차단 안내를 남기고 기본 diff 기능을 보존한다.

## 7. 상태 저장과 동기화

### 7.1 저장 범위

| 상태 | 저장 위치 | key |
|---|---|---|
| Sidebar mode | workspaceState | workspace URI |
| Changes section/order | workspaceState | repository root |
| commit draft | workspaceState | repository root + branch |
| Review saved queues | globalState | GitHub host + viewer |
| Review queue selection/filter | workspaceState | queue id + scope |
| Review Workspace layout | workspaceState | repository + PR number |
| pending review draft | workspaceState + encrypted secret 제외 | repository + PR + headOid |
| Viewed optimistic state | memory only, server authoritative | PR node id + path |
| splitter sizes | workspaceState | surface + width bucket |

token, cookie, secret은 webview state 또는 일반 workspaceState에 넣지 않는다.

### 7.2 versioning

모든 persisted state는 `{ version, data }` 형태다. 각 surface는
`migrateState(raw): CurrentState` 순수 함수를 갖는다. 알 수 없는 future version은
버리고 안전한 default를 사용하며 OUTPUT에 한 줄 로그를 남긴다.

### 7.3 refresh

- filesystem/git watcher: 150ms debounce, operation 중 중복 refresh coalesce
- GitHub queue: 수동 refresh + focus 복귀 시 stale-while-revalidate
- active PR: 60초 이상 열려 있고 window focus가 돌아오면 metadata/head만 우선 확인
- checks watch: 사용자가 Checks tab을 보고 있을 때만 10초 polling, tab을 떠나면 중지
- mutation 성공: 관련 resource만 invalidate
- stale response: UI에 적용하지 않고 debug log만 남김

## 8. 관찰성

`Git Simple Compare` OUTPUT에 다음 구조로 기록한다. body/comment/token은 로그에
남기지 않는다.

```text
[UI][ReviewQueue] load:start scope=org:acme request=42
[UI][ReviewQueue] load:partial summaries=100 hydrate=20 capped=true
[UI][ReviewWorkspace] head:changed pr=418 old=abc123 new=def456 drafts=3
[UI][ReviewMutation] submit:start pr=418 event=APPROVE comments=3
[UI][ReviewMutation] submit:success pr=418 review=PRR_xxx
[UI][Changes] refresh:skip reason=operation-active epoch=17
```

필수 event:

- webview create/dispose/restore
- state migration/drop
- data request start/success/partial/error/cancel/stale-skip
- optimistic mutation start/confirm/rollback
- rate limit/search cap/auth/permission
- head/base change와 draft invalidation
- visual fallback 또는 unsupported API

## 9. 구현 변경 PR 순서

여기서 “변경 PR”은 이 저장소에 올릴 구현 단위를 뜻한다. GitHub 사용자 PR 리뷰와
혼동하지 않는다. 관리 UI와 개인 UI는 아래 각 vertical slice에서 함께 전진한다.

### PR-00 — 계약과 fixture 기준선

**변경**

- `PRODUCT.md`, `DESIGN.md`, 두 계획 문서 확정
- 현재 Changes/Graph/PR Preview fixture와 screenshot matrix 정의
- `test/fixtures/webview/`에 큰/작은/오류/한국어 fixture schema 추가
- 현재 수동 test 파일 목록을 자동 발견 runner로 교체하고 Playwright/Extension
  Development Host harness 뼈대를 추가

**검증**

- 문서 링크와 파일 경로 확인
- 기존 `npm run compile`, `npm run check-types`, `npm test`

### PR-01 — Shared UI foundation

**변경**

- `media/shared/` token/control/navigation/feedback/layout 분리
- a11y, request revision, persisted state, splitter, virtual list 모듈 추가
- 모든 webview HTML builder가 공통 resource를 주입하도록 변경

**완료 조건**

- 기존 화면 외형과 기능 회귀 없음
- 새 primitive fixture에서 keyboard/focus/forced-colors 확인
- 새 파일 600라인 이하

### PR-02 — Sidebar shell: Changes + Reviews

**변경**

- 기존 view id를 유지하며 root mode navigation 추가
- repository header/operation banner 도입
- Reviews empty/auth/loading shell과 cached counts 추가
- 기존 Changes 상태 migration

**완료 조건**

- Changes와 Reviews 모두 첫 class navigation
- Reviews가 placeholder 링크가 아니라 실제 queue summary service를 사용
- 280/360/480px sidebar visual QA

### PR-03 — Review domain read model + Review Center

**변경**

- PR queue query, visible-window hydration, policy/check summary
- Review Center panel/protocol/reducer/virtual rows
- 개인 built-in queue와 org/team saved queue 동시 제공

**완료 조건**

- 개인/관리 scope 모두 탐색 가능
- 1,000 result cap/partial/rate limit 상태
- selection/filter/column/scroll 복원

### PR-04 — Review Workspace shell + read path

**변경**

- PR header, file navigator, diff, review inspector
- GraphQL files Viewed state/threads + REST patch 결합
- Overview/Files/Commits/Checks/Activity lazy tabs
- native diff open/sync

**완료 조건**

- binary/renamed/deleted/truncated/outdated thread
- 480–1440px adaptive layout
- queue → workspace → queue 상태 보존

### PR-05 — 관리 mutation + review draft를 함께 도입

**변경**

- reviewer/team, assignee, label, milestone, draft/ready mutation
- pending review 생성, inline/file/multi-line comment draft
- 모든 mutation permission gate, optimistic rollback, post-read verification

**완료 조건**

- 관리 변경과 개인 comment 작성이 같은 release slice에 포함
- silent-ignore REST 결과 감지
- refresh 중 composer/focus 보존

### PR-06 — Review completion

**변경**

- reply, edit/delete own comment, resolve/unresolve
- GitHub Viewed mark/unmark
- Comment/Approve/Request changes submit
- head changed conflict와 draft recovery
- native Comment API reply와 pending draft sync

**완료 조건**

- 브라우저 없이 전체 review workflow 완료
- 중복 submit 방지
- 최신 head 검증 실패 시 안전하게 차단

### PR-07 — Suggestions + local bridge

**변경**

- selected range suggestion 작성
- 기존 suggestion을 local worktree에 preview/apply
- dirty worktree, path/line drift, file mode, encoding safety
- optional stage/commit은 별도 명시 action

**완료 조건**

- 자동 push 없음
- apply 전/후 diff와 복구 경로
- outdated suggestion은 자동 적용하지 않음

### PR-08 — Graph command hierarchy + Review bridge

**변경**

- grouped command bar와 overflow
- collapsible/resizable details inspector
- related PR/stack summary를 shared model로 교체
- 중복 graph PR list 코드를 Review Center bridge로 축소

### PR-09 — Changes information architecture

**변경**

- repository header, Working Changes, Tools 구조
- `changes.js/css` 책임 분리
- commit composer와 hook/AI 상태 통합

### PR-10 — Rebase/Conflict/Split common operation UI

**변경**

- operation status, validation, progress, recovery primitive 공유
- rebase standalone/graph view model 통합
- split JS 모듈화
- conflicts banner/tree/editor 상태 연결

### PR-11 — Commit Plan + native editor alignment

**변경**

- commit plan 단계 위계와 실행 feedback
- native review/hunk/conflict/blame 상태 vocabulary 통일
- webview/native focus와 selected resource sync

### PR-12 — i18n/a11y/performance hardening

**변경**

- 남은 client literal 제거
- axe/keyboard/forced-colors/reduced-motion suite
- queue/file/diff windowing stress
- memory/dispose/request cancellation audit

### PR-13 — Legacy PR Preview retirement

**선행 조건**

- PR-03~07의 기능 parity와 migration test 완료
- creation preview와 review workspace 분리 완료

**변경**

- 기존 `PullRequestPreviewPanel` command를 creation 또는 review command로 redirect
- local-only Viewed state migration/폐기
- 사용되지 않는 duplicated PR CSS/tooltip/client renderer 제거

### PR-14 — Final visual QA and release gate

- 실제 Extension Development Host로 theme/width/data matrix 수행
- visual defect 수정만 포함
- 문서와 screenshot 갱신
- Output log에서 auth/error/head-change/mutation 흐름 확인

## 10. 각 변경 PR의 필수 체크리스트

### 코드

- [ ] 새/수정 파일이 600라인 이하인가?
- [ ] git/UI/provider/command 경계를 지켰는가?
- [ ] 함수마다 한글 설명 주석이 있는가?
- [ ] UI에 business/GitHub mutation 로직을 직접 넣지 않았는가?
- [ ] 모든 새 상태 전환이 OUTPUT에서 추적 가능한가?
- [ ] 모든 사용자 문자열이 영어 기본 + 한국어 번역 경로를 갖는가?
- [ ] 모든 버튼형 컨트롤에 tooltip과 접근성 이름이 있는가?

### 기능 QA

- [ ] 정상 workflow
- [ ] loading/empty/error/success/disabled/pending
- [ ] 취소, 재시도, 뒤로, webview restore
- [ ] auth 없음, permission 없음, rate limit, partial result
- [ ] long text, dense data, overflow
- [ ] stale request와 concurrent mutation

### visual QA

- [ ] Dark
- [ ] Light
- [ ] High Contrast Dark
- [ ] High Contrast Light
- [ ] 480 / 560 / 800 / 1024 / 1440px
- [ ] 100% / 150% / 200% zoom
- [ ] 영어 / 한국어
- [ ] keyboard-only focus path
- [ ] reduced motion
- [ ] tooltip이 viewport 밖으로 잘리지 않는지

### 자동 검증

현재 baseline:

```bash
npm run compile
npm run check-types
npm test
```

PR-00에서 UI test harness와 scripts가 들어온 뒤:

```bash
npm run test:webview
npm run test:a11y
npm run test:extension
npm run test:visual
```

존재하지 않는 `npm run lint`를 gate로 가정하지 않는다. 정적 검사는 현재
`check-types`와 계획된 webview/a11y test가 담당하고, 별도 linter 도입은 이
UI 개편 범위 밖이다.

## 11. 테스트 인프라 계획

### 11.1 순수 단위 테스트

현재 `node:test`와 esbuild 방식을 유지한다.

- reducer
- state migration
- queue filter/sort/group
- GitHub response normalization
- diff line ↔ GitHub comment location
- optimistic operation/rollback
- permission derivation
- result cap/rate limit
- head change/draft invalidation

### 11.2 webview DOM 테스트

추가 dev dependency:

- `@playwright/test`
- `@axe-core/playwright`

`src/webview/shared/webviewTestHarness.ts`가 실제 HTML builder와 media asset을 사용해
standalone fixture page를 만든다. `acquireVsCodeApi`는 message/state fixture로
대체한다. production renderer와 다른 테스트 전용 renderer를 만들지 않는다.

### 11.3 Extension Development Host 테스트

추가 dev dependency:

- `@vscode/test-electron`

검증:

- command 등록과 panel open/restore/dispose
- host ↔ webview protocol
- native diff/comment integration
- workspaceState migration
- Output log

GitHub mutation integration은 실제 계정에 쓰지 않는다. `GhRunner` interface에 fixture
runner를 주입해 request/response 계약을 검증한다. 실제 GitHub smoke test는 별도
수동 test repository와 명시적 사용자 계정에서만 수행한다.

### 11.4 visual snapshot

fixture:

- sidebar clean/changes/operation/reviews/auth-error
- review queue personal/org/team/empty/partial/1,000 rows
- review workspace small/large/binary/outdated/head-changed
- graph compact/detail/reflog/stack
- conflicts/rebase/split/commit-plan

theme와 viewport 조합마다 screenshot을 만든다. 픽셀 차이만 승인하지 않고,
변경 PR 설명에 의도한 차이를 한 문장으로 적는다.

## 12. Rollout과 migration

### 12.1 병행 기간

- 새 Review Center/Workspace는 기존 Preview와 다른 command로 먼저 제공한다.
- queue/sidebar는 새 domain service를 사용한다.
- 기존 creation preview는 PR 생성에만 유지한다.
- parity 완료 후 기존 review command를 새 workspace로 redirect한다.
- 병행 기간 동안 동일 PR write mutation을 두 UI에서 제공하지 않는다. write는
  새 workspace에서만 활성화한다.

### 12.2 state migration

- 기존 section visibility/order → 새 Changes Tools visibility/order
- 기존 PR preview selected tab/layout → 가능한 경우 새 workspace tab/layout
- local Viewed set → 서버 state와 병합하지 않고 폐기 안내 후 GitHub state를 재조회
- 기존 branch/source/target draft → creation flow state로 이동

### 12.3 실패 시 fallback

- 새 Review Center load 실패: 기존 Graph PR summary를 읽기 fallback으로 보여주되
  mutation은 비활성화하고 원인을 표시한다.
- GraphQL reviewThreads unavailable: REST comments를 읽기 fallback으로 제공하고
  resolve/unresolve는 비활성화한다.
- server Viewed mutation unavailable: 로컬 Viewed로 가장하지 않고 기능을
  unavailable로 표시한다.
- diff patch truncated: metadata와 thread는 보이되 전체 diff는 `Open native diff`
  또는 GitHub link로 연결한다.

## 13. 완료 정의

다음 조건이 모두 충족되어야 UI 대개편이 완료다.

- [ ] Changes와 Reviews가 Sidebar의 동급 primary mode다.
- [ ] 개인/팀/조직 queue가 Review Center에서 동작한다.
- [ ] Review Workspace에서 읽기, 작성, reply, resolve, Viewed, submit이 완결된다.
- [ ] 관리 metadata와 checks/policy가 permission-aware하게 동작한다.
- [ ] Graph/PR/stack이 shared PR model을 사용한다.
- [ ] creation preview와 review workspace 책임이 분리된다.
- [ ] Changes/Graph/Split의 touched 대형 파일이 600라인 이하 책임 모듈로 나뉜다.
- [ ] 모든 새 문자열이 영어/한국어로 제공된다.
- [ ] 모든 button-like control이 tooltip과 접근성 이름을 가진다.
- [ ] compile/typecheck/unit/integration/a11y/visual gate를 통과한다.
- [ ] 실제 Extension Development Host에서 theme/width/interaction matrix를 확인했다.
- [ ] OUTPUT 로그로 핵심 UI·GitHub 상태 전환을 재현할 수 있다.
- [ ] legacy review UI와 중복 CSS/tooltip/state가 제거됐다.

## 14. 구현 중 다시 열지 않을 결정

- 관리 UI를 후순위로 미루지 않는다.
- 외부 백엔드를 추가하지 않는다.
- React/Preact 등 새 framework를 추가하지 않는다.
- GitHub 웹 UI를 복제하지 않는다.
- VS Code 테마를 고정 팔레트로 대체하지 않는다.
- Viewed를 local-only 상태로 유지하지 않는다.
- 새 head에 오래된 review draft를 자동 재배치해 제출하지 않는다.
- 큰 목록/diff를 windowing 없이 한 번에 DOM에 넣지 않는다.
- build 성공을 visual QA로 간주하지 않는다.
