# PR Review Center / Workspace 상세 구현 명세

> **폐기됨 (2026-07-29):** 이 문서는 제거된 Reviews 구현의 역사적 명세이며 현재 제품 구현 근거가 아닙니다.

> 대상 구현자: Terra High  
> 상위 계획: [`ui-overhaul-plan.ko.md`](./ui-overhaul-plan.ko.md)  
> 제품 계약: [`PRODUCT.md`](../PRODUCT.md)  
> 디자인 계약: [`DESIGN.md`](../DESIGN.md)

## 0. 범위와 용어

### 0.1 이번 범위

이 명세는 다음 두 surface를 하나의 제품 축으로 구현한다.

1. **Review Center** — 개인 review inbox와 팀·조직 PR 관리 queue.
2. **Review Workspace** — 한 PR의 code/conversation/checks/review 작업 공간.

관리 UI는 Review Workspace 이후의 확장 기능이 아니다. queue read model, 관리
metadata, checks/policy, 개인 review draft/comment/submit을 같은 구현 milestone에서
수직으로 완성한다.

### 0.2 지원 기능

- 개인 queue: review requested, authored, assigned, mentioned, participated
- 팀/조직 queue: owner/org/repo/team scope, saved filter, sort, columns
- PR summary: author, refs, draft/state, labels, assignees, requested reviewers/teams,
  review decision, mergeability, checks, policy, comments, size, stack
- conversation/activity 조회와 일반 댓글 작성
- files 조회, unified/split diff, tree/list, search/filter
- GitHub server Viewed 조회·mark/unmark
- file/line/multi-line review comment
- pending review 생성·복원·제출
- thread reply, own comment edit/delete
- thread resolve/unresolve
- suggestion 작성
- 기존 suggestion의 안전한 local preview/apply/undo
- Comment, Approve, Request changes
- 관리 metadata 변경: reviewers/teams, assignees, labels, milestone, draft/ready
- 다중 PR bulk metadata 변경
- required/all checks 및 적용 policy의 read-only 표시
- PR stack 위치와 각 layer review/check 진행 표시
- native diff/VS Code Comment API 연결

### 0.3 명시적 비범위

- GitLab/Bitbucket 지원
- 외부 동기화 서버 또는 조직용 SaaS backend
- GitHub organization ruleset/branch protection 편집
- 자동 merge 정책 생성
- bulk approve, bulk request changes, bulk merge
- reviewer 성과 평가나 정확한 workload analytics
- GitHub notification inbox 전체 대체
- reaction 작성의 첫 릴리스 지원

정책 편집을 제외하는 이유는 관리 UI를 후순위로 보기 때문이 아니다. 이번 관리
surface는 PR 운영과 code review에 집중하고, 조직 보안 정책 자체를 수정하는 별도
위험 영역은 읽기 전용으로 유지한다.

### 0.4 용어

| 용어 | 의미 |
|---|---|
| Queue summary | `gh search prs`에서 얻는 빠른 PR 행 데이터 |
| Hydration | 화면에 보이는 queue summary에 GraphQL 상세 상태를 보충하는 작업 |
| Review snapshot | 특정 `headOid`에서 읽은 PR review 전체 상태 |
| Pending review | GitHub에 생성됐지만 아직 제출하지 않은 review |
| Local draft | GitHub mutation 전 또는 복구용으로 workspaceState에 저장한 내용 |
| Thread | 한 file/line/file-level review conversation |
| Stale draft | draft의 `headOid`와 현재 PR `headOid`가 다른 상태 |
| Management mutation | reviewer/assignee/label/milestone/draft 상태 변경 |
| Capability | host/API가 특정 query/mutation을 지원하는지 확인한 결과 |

## 1. 사용자 흐름

### 1.1 개인 리뷰

```text
Sidebar Reviews
→ Needs my review
→ Review Center에서 PR 선택
→ Review Workspace / Files
→ 미검토 파일과 미해결 thread 탐색
→ inline/file suggestion 또는 comment를 pending review에 추가
→ GitHub Viewed 표시
→ 새 commit 확인
→ Submit review summary
→ Comment / Approve / Request changes
→ 다음 queue item
```

### 1.2 팀·조직 관리

```text
Review Center
→ org/team/repo scope 선택
→ saved queue "Blocked > 24h" 적용
→ checks/review decision/assignee/reviewer 열로 정렬
→ PR 단일 또는 다중 선택
→ reviewer/team, assignee, label, milestone 변경 preview
→ 권한/적용 가능 repo 확인
→ mutation 실행
→ 서버 재조회로 결과 검증
→ 특정 PR Review Workspace로 drill down
```

### 1.3 PR 작성자

```text
Authored by me
→ Changes requested 또는 unresolved filter
→ Review Workspace / Activity 또는 Files
→ thread reply
→ suggestion local apply preview
→ 작업트리에 적용, 선택적으로 stage
→ 수정 후 push는 기존 Git command로 명시 수행
→ head 변경 감지, 기존 review 상태 재조회
```

### 1.4 PR stack

```text
Stacks queue
→ stack summary에서 blocked layer 선택
→ layer Review Workspace
→ parent/base 변경과 reviewed revision 관계 확인
→ layer review 완료
→ 다음 child layer로 이동
```

## 2. Surface 설계

## 2.1 Review Center

### 2.1.1 대형 폭 wireframe

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Reviews  [scope: acme ▾] [Needs review ▾] [Search…] [Filters] [Refresh]   │
├──────────────┬──────────────────────────────────────────────┬──────────────┤
│ Queues       │ PR table                                     │ Inspector    │
│              │                                              │              │
│ My review  8 │ □ repo #418  Harden draft recovery           │ #418         │
│ Team      14 │   Your review · 2 failed · 3 unresolved      │ reviewers    │
│ Authored   5 │ □ repo #399  Improve worktree safety         │ checks       │
│ Blocked    3 │   Changes requested · required check pending │ policy       │
│ Stale      7 │ …                                            │ labels       │
│              │                                              │ stack        │
│ Saved        │                                              │ [Open review]│
├──────────────┴──────────────────────────────────────────────┴──────────────┤
│ 100 results · 20 hydrated · search capped · updated 12:41                │
└────────────────────────────────────────────────────────────────────────────┘
```

### 2.1.2 폭별 변형

- `<560px`: queue rail과 inspector를 숨긴다. 현재 queue는 header combobox,
  inspector는 전체 폭 drawer. PR 행은 title + action needed + aggregate status만
  보인다.
- `560–799px`: queue rail을 접을 수 있고 inspector는 overlay drawer다.
- `800–1199px`: queue rail + PR table 2열. 선택 PR summary는 expandable row 또는
  drawer.
- `≥1200px`: queue rail + table + inspector 3열.

### 2.1.3 기본 queue

| id | label | query |
|---|---|---|
| `needs-my-review` | Needs my review | `is:pr is:open review-requested:@me` |
| `team-review` | Team review | 선택 team의 `team-review-requested:ORG/TEAM` |
| `authored` | Authored by me | `is:pr is:open author:@me` |
| `assigned` | Assigned to me | `is:pr is:open assignee:@me` |
| `mentioned` | Mentioned | `is:pr is:open mentions:@me` |
| `participated` | Participated | `is:pr is:open involves:@me -author:@me` |
| `blocked` | Blocked | client filter: checks fail/changes requested/conflict/policy block |
| `stale` | Stale | client filter: `updatedAt < now - threshold` |
| `drafts` | Draft | `is:pr is:open draft:true` |
| `stacks` | Stacks | connected repos의 stack metadata가 있는 PR |

`Blocked`, `Stale`, `Stacks`는 GitHub search qualifier만으로 정확히 표현하지 못하므로
넓은 server query를 먼저 하고 hydrated snapshot으로 client filter한다. 화면은
`server matched`, `hydrated`, `visible` count를 구분한다.

### 2.1.4 Saved queue

```ts
export interface SavedReviewQueue {
  id: string;
  name: string;
  scope: ReviewScope;
  search: string;
  filters: ReviewFilter[];
  sort: ReviewSort;
  groupBy: "none" | "repository" | "team" | "action" | "age";
  columns: ReviewColumnId[];
  columnWidths: Partial<Record<ReviewColumnId, number>>;
  staleAfterHours: number;
}
```

- `globalState`에 GitHub host + viewer login별로 저장한다.
- built-in queue는 삭제할 수 없고 숨김/순서 변경만 가능하다.
- saved queue는 local 설정이다. 팀과 자동 공유되는 것처럼 표현하지 않는다.
- import/export는 JSON으로 제공할 수 있지만 첫 릴리스 필수는 아니다.

### 2.1.5 기본 행

행은 다음 우선순위를 유지한다.

1. repository + PR number
2. title + author
3. action needed
4. review decision
5. checks
6. unresolved thread count
7. changed files/additions/deletions 또는 Viewed progress
8. updated relative time

`Action needed`는 단일 문자열이 아니라 우선순위가 있는 파생 값이다.

```ts
export type ReviewActionNeeded =
  | "resolve-conflict"
  | "fix-required-checks"
  | "address-changes-requested"
  | "respond-to-thread"
  | "review-requested"
  | "awaiting-author"
  | "awaiting-reviewers"
  | "ready-to-merge"
  | "draft"
  | "none"
  | "unknown";
```

우선순위는 위 union 순서다. 조건을 확정할 데이터가 없으면 `unknown`이며 빈 문자열로
숨기지 않는다.

### 2.1.6 다중 선택과 bulk action

지원:

- request reviewer/team
- remove requested reviewer/team
- add/remove label
- add/remove assignee
- set/clear milestone

금지:

- bulk review decision
- bulk merge/close
- bulk draft/ready

여러 repository의 PR을 선택했을 때:

1. 선택 수와 repository 수를 toolbar에 표시한다.
2. chooser option은 repository별 가능한 값을 조회한다.
3. 적용 전 preview에서 `will apply`, `no permission`, `not available`,
   `already set` count를 보여준다.
4. 사용자가 확인하면 repository별 최대 3개 concurrency로 mutation한다.
5. 각 PR mutation 후 재조회한다.
6. 부분 실패는 성공을 rollback하지 않고 결과 table과 Retry failed only를 제공한다.

### 2.1.7 Queue keyboard

input/textarea/contenteditable에 focus가 없을 때만 적용한다.

| key | action |
|---|---|
| `ArrowUp/ArrowDown` | 이전/다음 row |
| `Home/End` | 첫/마지막 loaded row |
| `Enter` | 선택 PR Review Workspace 열기 |
| `Space` | row 다중 선택 toggle |
| `Shift+Arrow` | 범위 선택 |
| `/` | 검색 focus |
| `r` | refresh |
| `Escape` | selection/inspector/overlay를 안쪽부터 닫기 |
| `?` | 현재 shortcut 도움말 |

문자 shortcut은 VS Code command가 아니라 webview focus 내부 local shortcut이다.

## 2.2 Review Workspace

### 2.2.1 공통 shell

```text
repo #418  Harden review draft recovery                    [Open on GitHub] […]
OPEN · Your review requested · 2 checks failed · 3 unresolved
base:main ← head:feature/review  abc1234  Updated 12m ago
[Overview] [Files 42] [Commits 7] [Checks 18] [Activity 26]
```

sticky header에 반드시 남는 값:

- repository + PR number
- title
- state/draft
- base/head
- short `headOid`
- viewer action needed
- review decision
- checks aggregate
- unresolved count
- head changed indicator

header action:

- primary: 현재 tab의 핵심 action. Files에서는 `Submit review` 또는 pending count.
- secondary: Open on GitHub.
- overflow: copy URL, checkout/open worktree, refresh, edit metadata, close/merge 기존
  command 연결.

### 2.2.2 Files tab 대형 폭

```text
┌───────────────┬────────────────────────────────────┬─────────────────────┐
│ Files 18/42   │ src/review/service.ts              │ Review              │
│ [filter]      │ [Unified|Split] [Viewed ✓] […]     │ Pending 3           │
│               │                                    │                     │
│ ○ src/a.ts    │ @@ -42,7 +42,9 @@                   │ Thread #12          │
│ ● src/b.ts  2 │  42 context                         │ A: Please…          │
│ ✓ src/c.ts    │ +43 addition     [+ comment]        │ You: …              │
│ …             │  44 context                         │ [Reply] [Resolve]   │
│               │                                    │                     │
│               │                                    │ [Submit review]     │
└───────────────┴────────────────────────────────────┴─────────────────────┘
```

### 2.2.3 File navigator

표시:

- Viewed state: `UNVIEWED`, optimistic pending, `VIEWED`, error
- change type: added, modified, deleted, renamed, copied
- additions/deletions
- unresolved/resolved/outdated/pending thread count
- binary/truncated/generated/large indicator
- current selected file

filter:

- text/path
- viewed/unviewed
- with comments
- unresolved
- change type
- file extension
- generated/binary

정렬:

- tree path
- flat path
- review order: unresolved → unviewed → viewed
- change size

기본은 `review order`다. 사용자가 tree/list를 바꾸면 PR별이 아니라 workspace 범위에
저장한다.

### 2.2.4 Diff

- unified/split를 지원한다.
- line number와 diff side를 분리해 저장한다.
- context 확장은 해당 file의 blob을 host에 요청하고 hunk 사이를 채운다.
- binary는 metadata + native/open action을 보여준다.
- patch가 truncated면 현재 fragment를 “전체 diff”처럼 보이지 않게 표시하고 native
  diff와 GitHub link를 제공한다.
- renamed file은 previous path와 current path를 header에 모두 표시한다.
- deleted file은 LEFT side comment만 허용한다.
- added file은 RIGHT side comment만 허용한다.
- unchanged context는 RIGHT side comment가 가능하다.
- diff line 전체를 tab stop으로 만들지 않는다. focusable file/thread navigation과
  line action button을 제공한다.
- selected range는 같은 side, 같은 hunk, 연속 line이어야 한다.

### 2.2.5 Review inspector

상단:

- pending review count
- viewed progress
- unresolved progress
- current head/revision

본문:

- 현재 선택 thread
- reply composer
- resolve/unresolve
- own comment edit/delete
- current selection comment composer
- review summary draft

하단 sticky action:

- `Submit review` primary
- pending comment count
- stale/error 상태

### 2.2.6 Overview tab

- title/body/author/refs
- viewer action needed
- reviewers/teams와 latest state
- assignees/labels/milestone
- review/check/policy summary
- mergeability/base behind/head changed
- linked stack
- 관리 metadata edit

Overview에서 같은 정보를 네 개의 같은 통계 카드로 반복하지 않는다. status summary
strip + labeled definition list + actionable sections를 사용한다.

### 2.2.7 Commits tab

- chronological commits
- verified status
- author/time/title/SHA
- “reviewed up to” marker
- 선택 commit diff로 전환
- force push/rebase로 사라진 commit 표시
- new commits since viewer last review 강조

### 2.2.8 Checks tab

- Required와 All 두 group
- bucket: pass/fail/pending/skipping/cancel
- name, workflow, state, started/completed, duration, link
- required 여부를 확인할 수 없으면 Required라고 추정하지 않는다.
- checks polling은 tab visible일 때만 10초 간격.
- link는 external open confirmation 없이 일반 안전한 link로 열되 tooltip에
  외부 GitHub임을 표시한다.

### 2.2.9 Activity tab

- PR body
- issue comments
- reviews
- review thread summary
- commits/push/force-push
- requested reviewer/assignee/label/milestone events
- checks/merge/draft/ready event

timeline은 날짜 group과 event type filter를 제공한다. code thread 상세는 Files로
deep-link한다.

### 2.2.10 Workspace keyboard

input/textarea/contenteditable에 focus가 없을 때:

| key | action |
|---|---|
| `Alt+J / Alt+K` | 다음/이전 file |
| `Alt+N / Alt+P` | 다음/이전 unresolved thread |
| `Alt+V` | current file Viewed toggle |
| `Alt+C` | current line/range comment composer |
| `Ctrl/Cmd+Enter` | 열린 composer를 pending review에 저장 |
| `Ctrl/Cmd+Shift+Enter` | Submit review dialog |
| `Alt+1…5` | Overview/Files/Commits/Checks/Activity |
| `Escape` | composer/overlay/drawer를 안쪽부터 닫기 |
| `?` | shortcut 도움말 |

shortcut은 tooltip과 도움말에 OS에 맞는 label로 표시한다.

## 3. Domain model

### 3.1 공통 비동기 상태

```ts
export type Loadable<T> =
  | { status: "idle" }
  | { status: "loading"; previous?: T; requestId: string }
  | { status: "ready"; value: T; receivedAt: number; revision: number }
  | { status: "partial"; value: T; issues: ReviewDataIssue[]; revision: number }
  | { status: "error"; error: ReviewError; previous?: T; retryable: boolean };

export interface ReviewError {
  code:
    | "auth-required"
    | "permission-denied"
    | "not-found"
    | "rate-limited"
    | "search-capped"
    | "network"
    | "unsupported"
    | "validation"
    | "head-changed"
    | "conflict"
    | "unknown-outcome"
    | "unknown";
  message: string;
  operation: string;
  retryAfter?: number;
  logContext?: string;
}
```

### 3.2 식별자

```ts
export interface GitHubRepositoryKey {
  host: string;
  owner: string;
  name: string;
}

export interface PullRequestKey extends GitHubRepositoryKey {
  number: number;
}

export interface PullRequestIdentity extends PullRequestKey {
  nodeId: string;
  url: string;
}
```

모든 cache/protocol/storage key는 `host/owner/name#number`를 사용한다. 같은 owner/name이
다른 GitHub host에 있을 수 있으므로 host를 생략하지 않는다.

### 3.3 Queue model

```ts
export interface PullRequestQueueItem {
  identity: PullRequestIdentity;
  title: string;
  author: GitHubActor;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  labels: PullRequestLabel[];
  assignees: GitHubActor[];
  summarySource: "search";
  hydration: Loadable<PullRequestQueueHydration>;
}

export interface PullRequestQueueHydration {
  baseRefName: string;
  baseOid?: string;
  headRefName: string;
  headOid: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  requestedReviewers: RequestedReviewer[];
  latestReviews: LatestReview[];
  checks: CheckSummary;
  policy: PolicySummary;
  changedFiles: number;
  additions: number;
  deletions: number;
  totalComments: number;
  unresolvedThreads: number | null;
  viewedFiles: number | null;
  stack?: PullRequestStackSummary;
  permissions: ReviewPermissions;
  actionNeeded: ReviewActionNeeded;
}
```

### 3.4 Review snapshot

```ts
export interface PullRequestReviewSnapshot {
  identity: PullRequestIdentity;
  title: string;
  body: string;
  author: GitHubActor;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  base: PullRequestRef;
  head: PullRequestRef;
  createdAt: string;
  updatedAt: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  viewer: ViewerReviewState;
  permissions: ReviewPermissions;
  requestedReviewers: RequestedReviewer[];
  latestReviews: LatestReview[];
  labels: PullRequestLabel[];
  assignees: GitHubActor[];
  milestone?: PullRequestMilestone;
  files: ReviewConnection<ReviewFile>;
  threads: ReviewConnection<ReviewThread>;
  commits: ReviewConnection<ReviewCommit>;
  activity: ReviewConnection<ReviewActivityItem>;
  checks: CheckSnapshot;
  policy: PolicySnapshot;
  stack?: PullRequestStackSnapshot;
  fetchedAt: number;
  revision: number;
}
```

`PullRequestRef`는 name, oid, repository owner/name, isCrossRepository를 갖는다.
`head.oid`가 모든 inline draft의 concurrency boundary다.

### 3.5 File/Viewed model

```ts
export interface ReviewFile {
  path: string;
  previousPath?: string;
  changeType: "ADDED" | "MODIFIED" | "DELETED" | "RENAMED" | "COPIED" | "CHANGED";
  additions: number;
  deletions: number;
  patch?: string;
  patchState: "complete" | "truncated" | "binary" | "missing";
  serverViewedState: "VIEWED" | "UNVIEWED" | "DISMISSED";
  viewedMutation:
    | { status: "idle" }
    | { status: "marking"; desired: "VIEWED" | "UNVIEWED"; operationId: string }
    | { status: "error"; desired: "VIEWED" | "UNVIEWED"; error: ReviewError };
  threadCounts: {
    unresolved: number;
    resolved: number;
    outdated: number;
    pending: number;
  };
  isGenerated?: boolean;
}
```

UI에서 보여주는 Viewed는 `viewedMutation.desired ?? serverViewedState`로 계산한다.
mutation 실패 시 server state로 rollback하고 같은 위치에 Retry를 보인다.

### 3.6 Thread/comment model

```ts
export interface ReviewThread {
  id: string;
  path: string;
  subjectType: "LINE" | "FILE";
  diffSide?: "LEFT" | "RIGHT";
  startLine?: number;
  line?: number;
  originalStartLine?: number;
  originalLine?: number;
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy?: GitHubActor;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  comments: ReviewConnection<ReviewComment>;
}

export interface ReviewComment {
  id: string;
  databaseId?: string;
  author?: GitHubActor;
  body: string;
  createdAt: string;
  updatedAt: string;
  state: "PENDING" | "SUBMITTED";
  path?: string;
  diffSide?: "LEFT" | "RIGHT";
  startLine?: number;
  line?: number;
  originalStartLine?: number;
  originalLine?: number;
  commitOid?: string;
  originalCommitOid?: string;
  outdated: boolean;
  viewerDidAuthor: boolean;
  viewerCanUpdate: boolean;
  viewerCanDelete: boolean;
  suggestions: SuggestedChange[];
}
```

`databaseId`는 GitHub의 64-bit 전환을 고려해 JS `number`가 아니라 string으로
normalization한다. GraphQL node id를 기본 mutation 식별자로 사용한다.

### 3.7 Permissions

```ts
export interface ReviewPermissions {
  canComment: boolean;
  canApprove: boolean;
  canRequestChanges: boolean;
  canReply: boolean;
  canResolveThreads: boolean;
  canMarkViewed: boolean;
  canApplySuggestion: boolean;
  canEditTitleBody: boolean;
  canEditBase: boolean;
  canAssign: boolean;
  canLabel: boolean;
  canSetMilestone: boolean;
  canRequestReviewers: boolean;
  canConvertDraft: boolean;
  canMarkReady: boolean;
  canClose: boolean;
  canMerge: boolean;
  reasons: Partial<Record<keyof ReviewPermissions, string>>;
}
```

GitHub field가 직접 제공하는 권한은 그대로 사용한다. API가 직접 제공하지 않는
review event 권한은 viewer identity, PR author 여부, repository permission,
draft/state를 조합해 보수적으로 계산하고, 403/422 응답을 최종 권한 판정으로
취급한다. 추정 권한이 false면 action을 비활성화하며 이유 tooltip을 제공한다.

### 3.8 Pending review draft

```ts
export type ReviewSubmitEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface PendingReviewDraft {
  version: 1;
  key: PullRequestKey;
  pullRequestNodeId: string;
  serverReviewId?: string;
  serverReviewDatabaseId?: string;
  headOid: string;
  baseOid?: string;
  body: string;
  selectedEvent: ReviewSubmitEvent;
  comments: PendingReviewComment[];
  createdAt: number;
  updatedAt: number;
  status:
    | "local"
    | "creating"
    | "pending"
    | "stale"
    | "submitting"
    | "outcome-unknown"
    | "error";
  lastError?: ReviewError;
}

export interface PendingReviewComment {
  localId: string;
  serverThreadId?: string;
  serverCommentId?: string;
  target: ReviewCommentTarget;
  body: string;
  contextHash: string;
  contextBefore: string[];
  contextAfter: string[];
  status: "local" | "creating" | "pending" | "outdated" | "unanchored" | "error";
  error?: ReviewError;
}
```

Local draft는 review body와 comment text를 담으므로 사용자 설정 동기화 대상에서
제외하고 workspaceState에만 저장한다. token/cookie는 절대 포함하지 않는다.

## 4. 서비스 아키텍처

### 4.1 파일 배치

새 파일은 한 책임당 300–600라인을 목표로 한다. 100라인 미만 micro-module을
양산하지 않고 관련 타입/정규화 책임을 묶는다.

```text
src/git/
├─ ghRunner.ts                         # injectable interface; runGh adapter
├─ pullRequestReviewServiceRegistry.ts # host/repo/local-root scope 조립
├─ pullRequestReviewModel.ts           # review domain type + normalization
├─ pullRequestManagementModel.ts       # 관리 field/permission/bulk model
├─ pullRequestReviewQueryCompiler.ts   # saved queue → search/client predicate
├─ pullRequestReviewQueueService.ts    # search/scope/queue page read
├─ pullRequestReviewQueryService.ts    # PR shell/files/threads/commits/activity
├─ pullRequestReviewPatch.ts           # GitHub patch parser
├─ pullRequestReviewLocation.ts        # line/side/context mapping
├─ pullRequestReviewCapabilityService.ts # host/version 기능 탐지
├─ pullRequestReviewPolicyService.ts   # checks/rules/protection normalization
├─ pullRequestReviewMutationService.ts # review/Viewed/thread mutation
├─ pullRequestReviewDraftService.ts    # local/server pending lifecycle
├─ pullRequestReviewHeadCoordinator.ts # head/base 변경과 draft 영향
├─ pullRequestReviewCache.ts           # TTL/invalidation/request coalescing
├─ pullRequestManagementService.ts     # 관리 read/write + post-read
├─ pullRequestManagementPreviewService.ts # bulk eligibility/preview
├─ pullRequestManagementScheduler.ts   # bounded bulk execution
├─ pullRequestSuggestion.ts            # suggestion parse/compose
└─ pullRequestSuggestionApplyService.ts # local preview/apply/undo

src/webview/
├─ reviewProtocol.ts                   # 공통 envelope/error/progress
├─ reviewRequestCoordinator.ts         # revision/dedupe/cancel/mutation registry
├─ reviewMessageValidation.ts          # runtime message guards
├─ reviewStateMigration.ts             # webview/global/workspace state migration
├─ reviewQueueStorage.ts               # saved queue/preferences persistence
├─ reviewQueuePanel.ts
├─ reviewQueueProtocol.ts
├─ reviewQueueHtml.ts
├─ reviewQueueMessages.ts
├─ pullRequestReviewPanel.ts
├─ pullRequestReviewProtocol.ts
├─ pullRequestReviewHtml.ts
├─ pullRequestReviewMessages.ts
└─ pullRequestReviewNativeBridge.ts

media/review-queue/
├─ reviewQueue.css
├─ reviewQueue.js
├─ reviewQueueState.js
├─ reviewQueueRows.js
├─ reviewQueueFilters.js
├─ reviewQueueInspector.js
├─ reviewQueueBulkActions.js
├─ reviewQueueManagementDrawer.js
└─ reviewQueuePickers.js

media/review-workspace/
├─ reviewWorkspace.css
├─ reviewWorkspace.js
├─ reviewWorkspaceState.js
├─ reviewHeader.js
├─ reviewTabs.js
├─ reviewFiles.js
├─ reviewFileNavigator.js
├─ reviewDiff.js
├─ reviewThreads.js
├─ reviewComposer.js
├─ reviewSubmit.js
├─ reviewSuggestion.js
├─ reviewManagement.js
├─ reviewOverview.js
├─ reviewCommits.js
├─ reviewChecks.js
└─ reviewActivity.js
```

기존 `pullRequestPreview*` 파일에서 재사용 가능한 parsing/markdown/diff 함수는
`src/git/`, `src/ui/`, 새 shared renderer로 옮긴다. 기존 Preview class를 새
Review class가 상속하지 않는다.

### 4.2 주입 가능한 gh 실행

```ts
export interface GhRunOptions {
  signal?: AbortSignal;
  maxBufferBytes?: number;
  /**
   * 오류/로그에 전체 args 대신 표시할 안전한 operation 이름이다.
   */
  operation: string;
}

export interface GhRunner {
  run(
    args: readonly string[],
    cwd: string,
    options: GhRunOptions
  ): Promise<string>;

  runJson<T>(
    args: readonly string[],
    cwd: string,
    options: GhRunOptions
  ): Promise<T>;
}

export class DefaultGhRunner implements GhRunner {
  public async run(
    args: readonly string[],
    cwd: string,
    options: GhRunOptions
  ): Promise<string> {
    return runGh([...args], cwd, options);
  }

  public async runJson<T>(
    args: readonly string[],
    cwd: string,
    options: GhRunOptions
  ): Promise<T> {
    const stdout = await this.run(args, cwd, options);
    return parseGhJson<T>(stdout, options.operation);
  }
}
```

- 기존 `runGh(args, cwd)` 호출을 깨지 않도록 세 번째 optional options를 추가한다.
- options가 있으면 `execFile`에 `signal`, `maxBuffer`를 전달한다.
- abort는 `CANCELLED`로 정규화하고 transient spawn retry를 하지 않는다.
- production은 확장된 기존 `runGh`를 유일한 process 실행 지점으로 유지한다.
- service constructor에 `GhRunner`를 주입해 fixture test가 실제 GitHub를 쓰지
  않게 한다.
- review path의 오류는 `GhCliError.message`에 전체 args를 join하지 않는다.
  `operation`과 redacted stderr만 사용한다. 기존 call site 오류 형식은 호환
  adapter로 보존한다.
- args와 결과 body를 통째로 OUTPUT에 남기지 않는다. route/operation/count만
  로깅한다.
- write 요청은 service method마다 별도 type을 받으며 webview가 임의 gh args를
  전달하지 못하게 한다.

### 4.3 service registry

기존 `GitServiceRegistry`에 unrelated GitHub host scope를 억지로 넣지 않는다.
새 `src/git/pullRequestReviewServiceRegistry.ts`가 다음 service를 조립한다.

- `reviewQueueService`
- `reviewQueryService`
- `reviewCapabilityService`
- `reviewMutationService`
- `pullRequestManagementService`
- `reviewPolicyService`
- `reviewDraftService`
- `suggestionApplyService`

queue는 여러 repository/org를 다루므로 GitHub host/viewer scoped cache를 별도로
가진다. mutation service는 대상 local repository root가 없을 수 있으므로 `cwd`는
현재 workspace의 first matching repo, 없으면 extension workspace root를 사용한다.
git local apply가 필요한 suggestion만 정확한 repository root를 요구한다.

Registry key:

```text
read/cache services: githubHost
repository metadata: githubHost + owner/repo
local apply service: normalized local repository root
```

`src/git/serviceRegistry.ts`는 local GitService의 기존 책임을 유지한다.

### 4.4 webview client 모듈 방식

새 framework와 별도 production bundler를 추가하지 않는다. 현재 webview처럼
`media/`의 vanilla CSS/JS를 `build*Html`이 nonce와 versioned URI로 주입한다.

테스트 가능한 순수 client module은 다음 UMD-like pattern을 사용한다.

```js
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.__gscReview = Object.assign(root.__gscReview || {}, api);
  }
})(typeof globalThis === "object" ? globalThis : this, function () {
  function reduceReviewQueue(state, action) {
    // 순수 reducer
  }
  return { reduceReviewQueue };
});
```

규칙:

- `reviewQueueState.js`, `reviewWorkspaceState.js`, parser-free UI selector처럼 순수
  client logic에만 이 pattern을 사용한다.
- main entry는 기존처럼 IIFE이며 `window.__gscReview`의 명시된 API만 읽는다.
- shared scripts → state/component scripts → entry script 순으로 HTML에 주입한다.
- script 간 임의 global variable을 만들지 않는다.
- production renderer와 test renderer를 분리하지 않는다.
- JS 함수에도 프로젝트 지침의 한글 JSDoc을 작성한다.
- TypeScript protocol의 runtime validator가 host 경계를 보장하고 client는
  unknown message type을 무시하며 diagnostic message를 보낸다.
- CSS/JS resource version 계산에는 해당 surface의 모든 파일 mtime을 포함한다.
- CSP에 `unsafe-inline`, `unsafe-eval`, remote script를 추가하지 않는다.

## 5. GitHub API 계약

### 5.1 공통 원칙

- GitHub CLI의 인증/host resolution을 사용한다.
- GraphQL은 node id, thread, Viewed, capability 중심으로 사용한다.
- REST는 patch가 필요한 file 목록과 issue/PR metadata mutation에 사용한다.
- deprecated `position` 기반 review comment를 새 코드에서 사용하지 않는다.
- comment 위치는 `line`, `side`, `startLine`, `startSide`, `subjectType`을 사용한다.
- pagination은 `pageInfo.hasNextPage/endCursor` 또는 REST Link/page를 끝까지
  처리하되 명시된 안전 cap을 적용한다.
- API schema/host가 기능을 지원하지 않으면 capability를 false로 저장하고 UI에
  unavailable 이유를 표시한다.

### 5.2 Viewer와 host

초기:

```bash
gh auth status --hostname HOST
gh api --hostname HOST user
```

저장:

- host
- viewer login/node id
- authenticated 여부
- repository permission이 query될 경우 ADMIN/MAINTAIN/WRITE/TRIAGE/READ

auth error는 empty queue로 normalization하지 않는다.

### 5.3 Queue search

기본 명령:

```bash
gh search prs \
  --review-requested=@me \
  --state=open \
  --limit=100 \
  --json assignees,author,body,closedAt,commentsCount,createdAt,id,isDraft,isLocked,labels,number,repository,state,title,updatedAt,url
```

org/team/saved query는 raw qualifier와 flags를 조합한다. shell 문자열을 만들지 않고
args array로 전달한다.

cap:

- 첫 page 100개
- 사용자가 Load more 시 최대 1,000개
- 1,000개에 도달하면 `capped=true`
- blocked/stale 같은 hydrated client filter는 cap 범위에서만 계산됐음을 표시

visible window의 앞뒤 10개만 즉시 hydrate한다. idle 시 다음 20개를 preload한다.
filter/sort가 hydration field를 요구하면 필요한 row를 순차 hydrate하되 concurrency
4를 넘지 않는다.

### 5.4 PR shell GraphQL

`repository(owner, name) { pullRequest(number) { ... } }`에서 최소 다음 field를 읽는다.

```graphql
id number url title body state isDraft createdAt updatedAt
baseRefName baseRefOid headRefName headRefOid
mergeable mergeStateStatus reviewDecision totalCommentsCount
viewerDidAuthor viewerLatestReview { id state submittedAt commit { oid } }
viewerLatestReviewRequest { id requestedReviewer { ... on User { id login } } }
viewerCanApplySuggestion viewerCanAssign viewerCanClose
viewerCanEditFiles viewerCanEnableAutoMerge viewerCanLabel
viewerCanReopen viewerCanUpdate viewerCanUpdateBranch
author { login avatarUrl url }
assignees(first: 50) { nodes { login avatarUrl id } }
labels(first: 100) { nodes { id name color description } }
milestone { id number title }
reviewRequests(first: 100) { nodes { id requestedReviewer { ... } } }
latestReviews(first: 100) { nodes { id state submittedAt author { login } } }
commits(last: 1) {
  nodes {
    commit {
      oid
      statusCheckRollup { state }
    }
  }
}
```

50/100 cap을 넘는 connection은 해당 tab/chooser가 열릴 때 추가 pagination한다.

### 5.5 Files

patch:

```text
GET /repos/{owner}/{repo}/pulls/{number}/files?per_page=100&page=N
```

Viewed:

```graphql
pullRequest(number: $number) {
  files(first: 100, after: $cursor) {
    nodes { path additions deletions changeType viewerViewedState }
    pageInfo { hasNextPage endCursor }
    totalCount
  }
}
```

REST/GraphQL 결과는 path로 결합한다. rename은 REST `previous_filename`을 저장한다.
한쪽에만 있는 file은 버리지 않고 `ReviewDataIssue`를 붙인다.

cap:

- files 최대 3,000
- 3,000 초과 또는 REST patch 누락은 partial 상태
- file metadata/Viewed는 계속 사용할 수 있음
- patchState를 file별로 계산

### 5.6 Review threads

GraphQL:

```graphql
reviewThreads(first: 100, after: $cursor) {
  nodes {
    id path subjectType diffSide startDiffSide startLine line
    originalStartLine originalLine
    isResolved isOutdated resolvedBy { login avatarUrl }
    viewerCanReply viewerCanResolve viewerCanUnresolve
    comments(first: 100) {
      nodes {
        id fullDatabaseId body createdAt updatedAt state
        path diffHunk startLine line originalStartLine originalLine
        commit { oid } originalCommit { oid }
        outdated viewerDidAuthor viewerCanUpdate viewerCanDelete
        author { login avatarUrl }
      }
      pageInfo { hasNextPage endCursor }
      totalCount
    }
  }
  pageInfo { hasNextPage endCursor }
  totalCount
}
```

한 thread의 comments가 100개를 넘으면 `node(id: $threadId)`로 그 thread comments만
추가 pagination한다. 전체 thread cap은 2,000이고 cap 도달 시 partial warning을
표시한다.

### 5.7 Commits와 activity

- commits는 GraphQL connection을 100개씩 최대 2,000개 읽는다.
- activity는 기존 `pullRequestPreviewConversation.ts`의 timeline/review/issue
  comment 정규화를 재사용하되 새 `ReviewActivityItem`으로 옮긴다.
- timeline 최대 2,000개, issue/review comment 최대 1,000개 각각 cap.
- cap은 숨기지 않고 status bar와 해당 tab에 표시한다.

### 5.8 Checks와 policy

All checks:

```bash
gh pr checks NUMBER \
  --repo HOST/OWNER/REPO \
  --json bucket,completedAt,description,event,link,name,startedAt,state,workflow
```

Required checks:

```bash
gh pr checks NUMBER \
  --repo HOST/OWNER/REPO \
  --required \
  --json bucket,completedAt,description,event,link,name,startedAt,state,workflow
```

policy:

```text
GET /repos/{owner}/{repo}/rules/branches/{baseRefName}?per_page=100&page=N
```

fallback:

```text
GET /repos/{owner}/{repo}/branches/{baseRefName}/protection
```

normalize:

- required status checks/workflows
- required approvals
- code owner review
- last-push approval
- stale review dismissal
- required thread resolution
- strict up-to-date requirement
- merge queue
- signed commits/linear history

rules endpoint 404/unsupported와 “정책 없음”을 구분한다. Required checks query가
실패하면 All checks만 보여주고 required 여부를 추정하지 않는다.

### 5.9 Pending review 생성

GraphQL primary:

```graphql
mutation AddReview($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) {
    pullRequestReview { id fullDatabaseId state commit { oid } }
  }
}
```

input:

```ts
{
  pullRequestId,
  commitOID: headOid,
  clientMutationId
}
```

`event`를 보내지 않아 PENDING review를 만든다. 이미 viewer pending review가 있으면
새로 만들지 않고 서버 review를 조회해 local draft와 연결한다.

### 5.10 Pending thread 추가

```graphql
mutation AddThread($input: AddPullRequestReviewThreadInput!) {
  addPullRequestReviewThread(input: $input) {
    thread {
      id path diffSide startLine line isResolved
      comments(first: 10) { nodes { id body state } }
    }
  }
}
```

line-level input:

```ts
{
  pullRequestReviewId,
  body,
  path,
  line,
  side,
  startLine,
  startSide,
  subjectType: "LINE",
  clientMutationId
}
```

file-level input:

```ts
{
  pullRequestReviewId,
  body,
  path,
  subjectType: "FILE",
  clientMutationId
}
```

single line에서는 `startLine/startSide`를 보내지 않는다.

### 5.11 Thread reply

```graphql
mutation Reply($input: AddPullRequestReviewThreadReplyInput!) {
  addPullRequestReviewThreadReply(input: $input) {
    comment { id body state createdAt }
  }
}
```

pending review에 reply를 포함할 때 `pullRequestReviewId`를 함께 보낸다. 즉시 제출
reply는 이 field 없이 보낸다. UI는 `Add to pending review`와 `Reply now`를
명시적으로 구분한다.

### 5.12 Submit review

```graphql
mutation SubmitReview($input: SubmitPullRequestReviewInput!) {
  submitPullRequestReview(input: $input) {
    pullRequestReview { id state submittedAt }
  }
}
```

input:

```ts
{
  pullRequestReviewId,
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  body,
  clientMutationId
}
```

validation:

- `COMMENT`: body 또는 pending comment가 하나 이상
- `REQUEST_CHANGES`: body 필수
- `APPROVE`: body 선택
- 자기 PR, draft/closed/merged, 권한 없음에 따라 event 비활성화
- submit 직전 headOid 재조회

GraphQL pending review mutation이 capability false면 REST fallback:

```text
POST /repos/{owner}/{repo}/pulls/{number}/reviews
POST /repos/{owner}/{repo}/pulls/{number}/reviews/{review_id}/events
```

REST도 `line/side/start_line/start_side`만 사용하고 deprecated `position`은 사용하지
않는다.

### 5.13 Viewed

mark:

```graphql
mutation MarkViewed($input: MarkFileAsViewedInput!) {
  markFileAsViewed(input: $input) {
    pullRequest { id }
    clientMutationId
  }
}
```

input: `{ pullRequestId, path, clientMutationId }`

unmark:

```graphql
mutation UnmarkViewed($input: UnmarkFileAsViewedInput!) {
  unmarkFileAsViewed(input: $input) {
    pullRequest { id }
    clientMutationId
  }
}
```

Viewed mutation은 idempotent하므로 network retry를 최대 1회 허용한다. 최종적으로
file viewerViewedState를 재조회한다.

### 5.14 Resolve/unresolve

```graphql
resolveReviewThread(input: {
  threadId,
  clientMutationId
})

unresolveReviewThread(input: {
  threadId,
  clientMutationId
})
```

optimistic state를 적용하고 실패 시 rollback한다. viewer permission과 thread의
현재 state를 다시 확인한다.

### 5.15 Comment edit/delete

- edit: `updatePullRequestReviewComment`
- delete: `deletePullRequestReviewComment`
- own comment + viewer permission일 때만 action 노출
- delete는 confirmation 후 수행
- pending review의 마지막 comment 삭제가 review를 자동 삭제하지는 않는다.
- timeline issue comment edit/delete는 기존 Issues REST endpoint를 별도 action으로
  처리한다.

### 5.16 Management mutation

review request:

```text
POST   /repos/{owner}/{repo}/pulls/{number}/requested_reviewers
DELETE /repos/{owner}/{repo}/pulls/{number}/requested_reviewers
body: { reviewers: string[], team_reviewers: string[] }
```

assignee:

```text
POST   /repos/{owner}/{repo}/issues/{number}/assignees
DELETE /repos/{owner}/{repo}/issues/{number}/assignees
body: { assignees: string[] }
```

labels:

```text
POST   /repos/{owner}/{repo}/issues/{number}/labels
DELETE /repos/{owner}/{repo}/issues/{number}/labels/{name}
```

milestone:

```text
PATCH /repos/{owner}/{repo}/issues/{number}
body: { milestone: number | null }
```

title/body/base:

```text
PATCH /repos/{owner}/{repo}/pulls/{number}
body: { title?, body?, base? }
```

draft/ready:

- `convertPullRequestToDraft`
- `markPullRequestReadyForReview`

모든 REST management mutation은 성공 status만 믿지 않고 대상 field를 재조회한다.
권한 부족 시 assignee/label/milestone이 silently ignored될 수 있으므로 기대 값과
서버 값을 비교하고 mismatch를 partial failure로 보여준다.

### 5.17 API capability probe

GitHub host + gh version별로 session 최초 1회:

- GraphQL query에 `viewerViewedState`, `reviewThreads`, thread permissions 포함
- mutation schema는 실제 write probe를 하지 않는다.
- GraphQL introspection이 허용되면 mutation field 존재를 확인한다.
- introspection이 막히면 read field와 host 종류를 기준으로 `unknown`으로 두고
  사용 시 실제 오류를 capability false로 cache한다.
- capability cache TTL 24시간, extension/gh version 변경 시 invalidate.

```ts
export interface ReviewCapabilities {
  reviewThreads: boolean | "unknown";
  lineBasedThreads: boolean | "unknown";
  threadReplies: boolean | "unknown";
  threadResolution: boolean | "unknown";
  viewedFiles: boolean | "unknown";
  draftConversion: boolean | "unknown";
  rulesForBranch: boolean | "unknown";
  requiredChecks: boolean | "unknown";
}
```

기능이 false일 때 action을 숨기지 말고 disabled action + 이유 tooltip 또는
unavailable empty state를 사용한다.

## 6. Webview protocol

### 6.1 공통 envelope

Review Center와 Review Workspace는 문자열 기반 ad-hoc message를 추가하지 않는다.
모든 요청과 응답은 다음 envelope를 사용한다.

```ts
export type RequestId = string;
export type ResourceKey =
  | `queue:${string}`
  | `pr:${string}:${string}:${number}`
  | `file:${string}:${string}:${number}:${string}`
  | `thread:${string}`
  | `mutation:${string}`;

export interface RequestEnvelope<TType extends string, TPayload> {
  type: TType;
  requestId: RequestId;
  resourceKey: ResourceKey;
  /**
   * UI가 메시지를 만들 때 알고 있던 resource revision이다.
   * read 요청은 생략할 수 있고 mutation은 반드시 포함한다.
   */
  baseRevision?: number;
  payload: TPayload;
}

export interface ResponseEnvelope<TType extends string, TPayload> {
  type: TType;
  requestId?: RequestId;
  resourceKey: ResourceKey;
  /**
   * host가 resource에 부여한 단조 증가 revision이다.
   */
  revision: number;
  payload: TPayload;
}
```

규칙:

1. `requestId`는 webview가 `crypto.randomUUID()`로 만든다.
2. host는 동일 `requestId`의 mutation을 session 내에서 한 번만 실행한다.
3. `resourceKey`별 revision은 host가 관리한다.
4. UI는 현재 revision보다 작은 response를 버리고 `staleResponseSkipped`를
   OUTPUT에 debug level로 기록한다.
5. mutation의 `baseRevision`이 현재보다 작으면 host는 서버 상태를 재조회한 뒤
   자동 merge 가능한 field mutation만 계속한다.
6. comment body, review event, base branch처럼 충돌 가능성이 있는 mutation은
   `REVISION_CONFLICT`로 중단하고 최신 값과 사용자의 입력을 함께 반환한다.
7. protocol의 모든 payload는 JSON 직렬화 가능해야 한다. `Date`, `Map`, `Set`,
   `Error`, `URL` 객체를 직접 보내지 않는다.

`src/webview/reviewProtocol.ts`는 공통 envelope, 오류, progress 타입을 정의한다.
Center/Workspace 전용 union은 별도 파일로 나눈다.

### 6.2 공통 오류와 progress

```ts
export type ReviewErrorCode =
  | "AUTH_REQUIRED"
  | "HOST_UNSUPPORTED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "REVISION_CONFLICT"
  | "HEAD_CHANGED"
  | "RATE_LIMITED"
  | "OFFLINE"
  | "GH_MISSING"
  | "GH_FAILED"
  | "GRAPHQL_FAILED"
  | "REST_FAILED"
  | "CANCELLED"
  | "PARTIAL_FAILURE"
  | "UNKNOWN";

export interface ReviewErrorPayload {
  code: ReviewErrorCode;
  userMessage: string;
  detail?: string;
  retryable: boolean;
  retryAfterMs?: number;
  fieldErrors?: Record<string, string>;
  correlationId: string;
}

export interface MutationProgress {
  completed: number;
  total: number;
  currentLabel?: string;
  succeeded: number;
  failed: number;
}
```

`userMessage`는 l10n된 안전한 문자열이고 `detail`은 민감 정보가 제거된 기술
정보다. gh stderr 전체, token, Authorization header, PR body는 message에 넣지
않는다. 상세 원문은 기존 redaction 정책을 거쳐 OUTPUT에만 남긴다.

### 6.3 Review Center: webview → host

`src/webview/reviewQueueProtocol.ts`에 다음 union을 그대로 정의한다.

```ts
export type ReviewQueueWebviewMessage =
  | RequestEnvelope<"queue.ready", {
      persistedVersion?: number;
    }>
  | RequestEnvelope<"queue.load", {
      descriptor: ReviewQueueDescriptor;
      cursor?: string;
      replace: boolean;
    }>
  | RequestEnvelope<"queue.hydrateRange", {
      keys: PullRequestKey[];
      fields: QueueHydrationField[];
    }>
  | RequestEnvelope<"queue.refresh", {
      descriptor: ReviewQueueDescriptor;
      reason: "user" | "focus" | "mutation";
    }>
  | RequestEnvelope<"queue.cancel", {
      targetRequestId: RequestId;
    }>
  | RequestEnvelope<"queue.openReview", {
      key: PullRequestKey;
      sourceQueueId: string;
      focus?: "overview" | "files" | "checks" | "activity";
    }>
  | RequestEnvelope<"queue.save", {
      draft: SavedReviewQueueDraft;
    }>
  | RequestEnvelope<"queue.delete", {
      queueId: string;
    }>
  | RequestEnvelope<"queue.reorderSaved", {
      orderedQueueIds: string[];
    }>
  | RequestEnvelope<"queue.updateColumns", {
      queueId: string;
      columns: ReviewQueueColumnId[];
      sort: ReviewQueueSort;
    }>
  | RequestEnvelope<"queue.setScope", {
      scope: ReviewScope;
    }>
  | RequestEnvelope<"queue.previewBulkMutation", {
      selection: PullRequestKey[];
      mutation: BulkManagementMutation;
    }>
  | RequestEnvelope<"queue.runBulkMutation", {
      previewId: string;
      confirmedSelection: PullRequestKey[];
    }>
  | RequestEnvelope<"queue.retryBulkFailures", {
      operationId: string;
      failedKeys: PullRequestKey[];
    }>
  | RequestEnvelope<"queue.openExternal", {
      url: string;
    }>
  | RequestEnvelope<"queue.openSettings", {
      section: "authentication" | "review" | "management";
    }>
  | RequestEnvelope<"queue.showOutput", Record<string, never>>;
```

`queue.hydrateRange`는 IntersectionObserver가 관찰한 화면 행과 위·아래 10개
overscan 행만 요청한다. 같은 key/field 요청은 webview에서 100ms 동안 합치고,
host에서 in-flight dedupe한다.

### 6.4 Review Center: host → webview

```ts
export type ReviewQueueHostMessage =
  | ResponseEnvelope<"queue.initialize", {
      viewer: ReviewViewer;
      host: GitHubHost;
      capabilities: ReviewCapabilities;
      savedQueues: SavedReviewQueue[];
      builtInQueues: ReviewQueueSummary[];
      selectedQueueId: string;
      preferences: ReviewQueuePreferences;
      restoredFocus?: ReviewFocusAnchor;
    }>
  | ResponseEnvelope<"queue.loading", {
      mode: "initial" | "replace" | "append" | "refresh";
      preserveRows: boolean;
    }>
  | ResponseEnvelope<"queue.page", {
      queueId: string;
      items: ReviewQueueItem[];
      nextCursor?: string;
      totalCount?: number;
      replace: boolean;
      receivedAt: string;
    }>
  | ResponseEnvelope<"queue.hydrationPatch", {
      patches: QueueHydrationPatch[];
    }>
  | ResponseEnvelope<"queue.counts", {
      counts: Record<string, number | null>;
      computedAt: string;
    }>
  | ResponseEnvelope<"queue.saved", {
      savedQueue: SavedReviewQueue;
    }>
  | ResponseEnvelope<"queue.deleted", {
      queueId: string;
      fallbackQueueId: string;
    }>
  | ResponseEnvelope<"queue.bulkPreview", {
      preview: BulkMutationPreview;
    }>
  | ResponseEnvelope<"queue.mutationStarted", {
      operationId: string;
      optimisticPatches: QueueHydrationPatch[];
    }>
  | ResponseEnvelope<"queue.mutationProgress", {
      operationId: string;
      progress: MutationProgress;
      itemResult?: BulkMutationItemResult;
    }>
  | ResponseEnvelope<"queue.mutationFinished", {
      operationId: string;
      summary: BulkMutationSummary;
      authoritativePatches: QueueHydrationPatch[];
    }>
  | ResponseEnvelope<"queue.error", ReviewErrorPayload>
  | ResponseEnvelope<"queue.requestCancelled", {
      cancelledRequestId: string;
    }>;
```

Center가 `queue.page`를 받을 때:

- `replace=true`면 기존 선택을 key 기준으로 보존하되 결과에서 사라진 key는
  선택 해제한다.
- `replace=false`면 key로 dedupe하고 현재 sort에 맞춰 append한다.
- 화면의 scroll anchor는 `{firstVisibleKey, offsetPx}`로 저장하고 patch 적용 후
  복구한다.
- 사용자가 키보드 탐색 중이면 hydration으로 행 높이가 변하지 않도록 placeholder
  셀과 실제 셀의 높이를 동일하게 유지한다.

### 6.5 Review Workspace: webview → host

`src/webview/pullRequestReviewProtocol.ts`에 다음 union을 정의한다.

```ts
export type PullRequestReviewWebviewMessage =
  | RequestEnvelope<"review.ready", {
      key: PullRequestKey;
      persistedVersion?: number;
    }>
  | RequestEnvelope<"review.loadTab", {
      tab: ReviewWorkspaceTab;
      force?: boolean;
    }>
  | RequestEnvelope<"review.selectFile", {
      path: string;
      anchor?: ReviewFileAnchor;
    }>
  | RequestEnvelope<"review.loadPatchContext", {
      path: string;
      beforeLine: number;
      afterLine: number;
      direction: "before" | "after" | "both";
    }>
  | RequestEnvelope<"review.setDiffMode", {
      mode: "unified" | "split";
    }>
  | RequestEnvelope<"review.toggleViewed", {
      path: string;
      next: boolean;
    }>
  | RequestEnvelope<"review.createPending", {
      event: PendingReviewEvent;
    }>
  | RequestEnvelope<"review.addThread", AddThreadInput>
  | RequestEnvelope<"review.replyThread", {
      threadId: string;
      body: string;
    }>
  | RequestEnvelope<"review.editComment", {
      commentId: string;
      kind: "review" | "issue";
      body: string;
      expectedUpdatedAt: string;
    }>
  | RequestEnvelope<"review.deleteComment", {
      commentId: string;
      kind: "review" | "issue";
      expectedUpdatedAt: string;
    }>
  | RequestEnvelope<"review.setThreadResolved", {
      threadId: string;
      resolved: boolean;
    }>
  | RequestEnvelope<"review.updateDraft", {
      body: string;
      event: PendingReviewEvent;
    }>
  | RequestEnvelope<"review.submit", {
      reviewId: string;
      body: string;
      event: PendingReviewEvent;
      expectedHeadOid: string;
    }>
  | RequestEnvelope<"review.restartDraft", {
      event: PendingReviewEvent;
    }>
  | RequestEnvelope<"review.discardPending", {
      reviewId: string;
    }>
  | RequestEnvelope<"review.previewSuggestionApply", {
      commentId: string;
      suggestionIndex: number;
    }>
  | RequestEnvelope<"review.confirmSuggestionApply", {
      previewId: string;
      expectedWorkingTreeHash: string;
    }>
  | RequestEnvelope<"review.undoSuggestionApply", {
      undoToken: string;
      expectedWorkingTreeHash: string;
    }>
  | RequestEnvelope<"review.openNativeDiff", {
      path: string;
      side: "head-working" | "base-head";
      line?: number;
    }>
  | RequestEnvelope<"review.openInBrowser", {
      url: string;
    }>
  | RequestEnvelope<"review.previewManagementMutation", {
      mutation: ManagementMutation;
    }>
  | RequestEnvelope<"review.runManagementMutation", {
      previewId: string;
    }>
  | RequestEnvelope<"review.refresh", {
      reason: "user" | "focus" | "headChanged" | "mutation";
      areas?: ReviewDataArea[];
    }>
  | RequestEnvelope<"review.cancel", {
      targetRequestId: RequestId;
    }>
  | RequestEnvelope<"review.showOutput", Record<string, never>>;
```

다음 action은 별도 message로 만들지 않는다.

- 단순 tab/inspector/accordion 변경: webview local state
- draft body keystroke: webview local state + debounced `setState`
- row hover/selection: webview local state
- theme/contrast 변경: CSS의 VS Code token이 즉시 반영

### 6.6 Review Workspace: host → webview

```ts
export type PullRequestReviewHostMessage =
  | ResponseEnvelope<"review.initialize", {
      snapshot: PullRequestReviewSnapshot;
      capabilities: ReviewCapabilities;
      preferences: ReviewWorkspacePreferences;
      restored: ReviewWorkspacePersistedState;
    }>
  | ResponseEnvelope<"review.shellPatch", {
      patch: Partial<PullRequestReviewSnapshot>;
      reason: "refresh" | "mutation" | "subscription";
    }>
  | ResponseEnvelope<"review.tabLoading", {
      tab: ReviewWorkspaceTab;
      preserveContent: boolean;
    }>
  | ResponseEnvelope<"review.tabLoaded", {
      tab: ReviewWorkspaceTab;
      data: ReviewTabData;
      loadedAt: string;
    }>
  | ResponseEnvelope<"review.fileSelected", {
      file: ReviewFile;
      patch: ReviewPatch;
      threads: ReviewThread[];
      anchor?: ReviewFileAnchor;
    }>
  | ResponseEnvelope<"review.patchContext", {
      path: string;
      hunks: ReviewPatchHunk[];
      reachedStart: boolean;
      reachedEnd: boolean;
    }>
  | ResponseEnvelope<"review.viewedMutation", {
      path: string;
      viewed: boolean;
      viewedCount: number;
      optimistic: boolean;
    }>
  | ResponseEnvelope<"review.pendingPatch", {
      pending: PendingReviewDraft | null;
      threads: ReviewThread[];
    }>
  | ResponseEnvelope<"review.threadPatch", {
      thread: ReviewThread;
      mutation: "created" | "replied" | "edited" | "resolved";
    }>
  | ResponseEnvelope<"review.threadRemoved", {
      threadId: string;
      commentId?: string;
    }>
  | ResponseEnvelope<"review.submitStarted", {
      reviewId: string;
    }>
  | ResponseEnvelope<"review.submitFinished", {
      submittedReview: SubmittedReviewSummary;
      refreshedSnapshot: PullRequestReviewSnapshot;
    }>
  | ResponseEnvelope<"review.headChanged", {
      previousHeadOid: string;
      currentHeadOid: string;
      changedFiles: HeadChangeFileImpact[];
      pendingImpact?: PendingReviewHeadImpact;
    }>
  | ResponseEnvelope<"review.suggestionPreview", {
      preview: SuggestionApplyPreview;
    }>
  | ResponseEnvelope<"review.suggestionApplied", {
      result: SuggestionApplyResult;
      undoToken: string;
    }>
  | ResponseEnvelope<"review.suggestionUndone", {
      path: string;
      currentWorkingTreeHash: string;
    }>
  | ResponseEnvelope<"review.managementPreview", {
      preview: ManagementMutationPreview;
    }>
  | ResponseEnvelope<"review.managementFinished", {
      result: ManagementMutationResult;
      snapshotPatch: Partial<PullRequestReviewSnapshot>;
    }>
  | ResponseEnvelope<"review.error", ReviewErrorPayload>;
```

### 6.7 revision과 취소 규칙

Host의 `ReviewRequestCoordinator`가 다음 map을 갖는다.

```ts
interface RequestCoordinatorState {
  revisions: Map<ResourceKey, number>;
  inFlightReads: Map<string, Promise<unknown>>;
  mutationResults: Map<RequestId, CachedMutationResult>;
  abortControllers: Map<RequestId, AbortController>;
}
```

키 생성 규칙:

- read dedupe key:
  `method + normalizedResource + stableStringify(sortedPayload)`
- PR resource:
  `pr:${host}:${owner}/${repo}:${number}`
- file resource:
  path를 `encodeURIComponent`하지 않고 원 문자열로 map key에 보관한다.
- mutation result TTL: panel session 동안 또는 30분 중 먼저 끝나는 시점

취소:

1. webview가 다른 queue/PR로 이동하면 이전 read에 `queue.cancel` 또는
   `review.cancel`을 보낸다.
2. host는 gh child process에 abort signal을 전달하고 종료한다.
3. 이미 서버에 전달된 mutation은 abort하지 않는다.
4. mutation 도중 panel이 닫히면 operation은 host에서 끝까지 추적하고 OUTPUT에
   결과를 남긴다.
5. panel을 다시 열면 진행 중 operation을 initialize payload에 포함한다.

### 6.8 persisted state

민감하지 않은 UI 상태만 `webview.setState`와 `workspaceState`에 저장한다.

```ts
export interface ReviewWorkspacePersistedStateV1 {
  version: 1;
  key: PullRequestKey;
  selectedTab: ReviewWorkspaceTab;
  selectedFilePath?: string;
  diffMode: "unified" | "split";
  fileFilter: string;
  fileTreeExpandedPaths: string[];
  inspectorWidth: number;
  fileNavigatorWidth: number;
  inspectorSectionStates: Record<string, boolean>;
  scrollAnchors: Partial<Record<ReviewWorkspaceTab, ReviewScrollAnchor>>;
  localDraft?: {
    body: string;
    event: PendingReviewEvent;
    serverReviewId?: string;
    baseHeadOid: string;
    updatedAt: string;
  };
}
```

저장하지 않는 것:

- access token, Authorization header
- 전체 PR body/comment body cache
- collaborator/team 목록
- diff 원문과 repository 파일 내용
- server response/error stderr

Center의 queue 정의와 column 설정은 `globalState`에, repo/owner scope와 마지막
선택 queue는 `workspaceState`에 저장한다. Draft review의 서버 ID와 local body는
workspace별로 저장하고 extension activate 시 서버 pending review와 reconcile한다.

버전 migration:

1. version 없음은 legacy state로 간주하고 안전한 field만 읽는다.
2. 알 수 없는 future version은 state를 버리되 saved queue 원본은 보존한다.
3. migration 실패는 panel을 막지 않고 default state로 연 뒤 OUTPUT에 한 번
   기록한다.
4. migration 함수는 `src/webview/reviewStateMigration.ts`의 순수 함수로 구현하고
   fixture 기반 unit test를 둔다.

## 7. 상태 모델, reducer, 동시성

### 7.1 Review Center state

`media/review-queue/reviewQueueState.js`는 DOM을 모르는 순수 reducer다.

```ts
export interface ReviewQueueState {
  phase: "booting" | "ready" | "fatal";
  viewer?: ReviewViewer;
  host?: GitHubHost;
  capabilities?: ReviewCapabilities;
  queueSummaries: ReviewQueueSummary[];
  activeQueueId?: string;
  descriptor?: ReviewQueueDescriptor;
  rows: ReviewQueueItem[];
  rowIndexByKey: Record<string, number>;
  hydration: Record<string, QueueItemHydration>;
  nextCursor?: string;
  totalCount?: number;
  load: Loadable<null>;
  appendLoad: Loadable<null>;
  selection: Record<string, true>;
  rangeAnchorKey?: string;
  focusKey?: string;
  columns: ReviewQueueColumnId[];
  sort: ReviewQueueSort;
  filtersOpen: boolean;
  bulk?: BulkMutationUiState;
  scrollAnchor?: ReviewFocusAnchor;
  banner?: ReviewBanner;
}

export type ReviewQueueAction =
  | { type: "initialized"; payload: QueueInitialization }
  | { type: "queueRequested"; replace: boolean }
  | { type: "pageReceived"; page: ReviewQueuePage }
  | { type: "pageFailed"; error: ReviewErrorPayload; append: boolean }
  | { type: "hydrationReceived"; patches: QueueHydrationPatch[] }
  | { type: "activeQueueChanged"; queueId: string }
  | { type: "selectionToggled"; key: string; additive: boolean }
  | { type: "selectionRangeExtended"; key: string }
  | { type: "selectionCleared" }
  | { type: "focusMoved"; key: string }
  | { type: "columnsChanged"; columns: ReviewQueueColumnId[] }
  | { type: "sortChanged"; sort: ReviewQueueSort }
  | { type: "bulkPreviewed"; preview: BulkMutationPreview }
  | { type: "bulkStarted"; operationId: string }
  | { type: "bulkProgressed"; result: BulkMutationItemResult }
  | { type: "bulkFinished"; summary: BulkMutationSummary }
  | { type: "optimisticPatchApplied"; patches: QueueHydrationPatch[] }
  | { type: "authoritativePatchApplied"; patches: QueueHydrationPatch[] }
  | { type: "bannerSet"; banner?: ReviewBanner };
```

Reducer invariant:

- `rows`는 같은 `PullRequestKey`를 두 번 포함하지 않는다.
- `rowIndexByKey`는 reducer가 page를 적용한 직후 한 번 재계산한다.
- 선택은 행 index가 아니라 canonical key로 저장한다.
- `load.status="refreshing"`일 때 기존 rows를 유지한다.
- initial load 실패 때만 full error state를 그린다.
- append/refresh 실패는 기존 rows 위의 inline banner로 표시한다.
- optimistic patch는 반드시 같은 operation의 authoritative patch 또는 rollback
  patch로 끝난다.
- reducer는 `postMessage`, DOM, timers를 호출하지 않는다.

### 7.2 Review Workspace state

`media/review-workspace/reviewWorkspaceState.js`의 state는 data와 UI를 분리한다.

```ts
export interface PullRequestReviewState {
  phase: "booting" | "ready" | "fatal";
  identity?: PullRequestKey;
  capabilities?: ReviewCapabilities;
  permissions?: PullRequestPermissions;
  shell: Loadable<PullRequestReviewSnapshot>;
  tabs: Record<ReviewWorkspaceTab, Loadable<ReviewTabData>>;
  activeTab: ReviewWorkspaceTab;
  files: ReviewFile[];
  fileIndexByPath: Record<string, number>;
  selectedPath?: string;
  patch: Loadable<ReviewPatch>;
  threadsByFile: Record<string, ReviewThread[]>;
  viewedOptimistic: Record<string, boolean>;
  pending: PendingReviewUiState;
  composer: ReviewComposerState;
  management: ManagementUiState;
  preferences: ReviewWorkspacePreferences;
  layout: ReviewWorkspaceLayoutState;
  banners: ReviewBanner[];
  mutations: Record<string, ReviewMutationUiState>;
  currentHeadOid?: string;
}
```

```ts
export type PendingReviewUiState =
  | { status: "none"; localDraft?: LocalReviewDraft }
  | { status: "creating"; localDraft: LocalReviewDraft }
  | {
      status: "pending";
      server: PendingReviewDraft;
      localDraft: LocalReviewDraft;
      sync: "clean" | "dirty" | "saving" | "error";
    }
  | {
      status: "headChanged";
      server?: PendingReviewDraft;
      localDraft: LocalReviewDraft;
      impact: PendingReviewHeadImpact;
    }
  | { status: "submitting"; server: PendingReviewDraft }
  | { status: "submitted"; submitted: SubmittedReviewSummary };
```

Workspace reducer action은 protocol response와 1:1로 매핑하되 다음 local action을
추가한다.

```ts
type ReviewLocalAction =
  | { type: "tabSelected"; tab: ReviewWorkspaceTab }
  | { type: "fileFilterChanged"; value: string }
  | { type: "fileFocusMoved"; path: string }
  | { type: "composerOpened"; anchor: DiffAnchor }
  | { type: "composerBodyChanged"; body: string }
  | { type: "composerSuggestionToggled"; enabled: boolean }
  | { type: "composerCancelled" }
  | { type: "draftBodyChanged"; body: string }
  | { type: "draftEventChanged"; event: PendingReviewEvent }
  | { type: "inspectorSectionToggled"; section: string }
  | { type: "layoutResized"; pane: "navigator" | "inspector"; width: number }
  | { type: "bannerDismissed"; id: string };
```

Invariant:

- 현재 선택 파일은 `files`에 존재하거나 `undefined`다.
- `currentHeadOid`가 shell의 head OID와 다르면 write action을 허용하지 않는다.
- draft body가 비어도 `COMMENT` submit은 허용하되 confirmation을 거친다.
- `APPROVE`/`REQUEST_CHANGES` 가능 여부는 permissions와 PR 상태를 함께 본다.
- author가 자신의 PR을 approve할 수 없는 경우 button은 disabled + 이유 tooltip.
- unresolved thread 수는 `threadsByFile`에서 직접 매 render마다 계산하지 않고
  selector memoization으로 계산한다.
- pending composer가 있는 diff line이 사라지면 composer를 닫지 않고 stale 상태로
  전환해 텍스트를 복사할 수 있게 한다.

### 7.3 selector

DOM render 함수가 raw state를 임의 해석하지 않도록 selector를 둔다.

```text
selectVisibleQueueRows
selectQueueToolbarState
selectBulkActionAvailability
selectReviewHeaderBadges
selectVisibleFiles
selectSelectedFile
selectFileReviewProgress
selectVisibleThreads
selectSubmitAvailability
selectManagementActionAvailability
selectReviewEmptyState
```

각 selector는 순수 함수이고 입력 state가 같으면 동일 참조를 반환하는 간단한
memoization을 적용한다. 단, 수십 행 수준의 selector에 무거운 cache library를
추가하지 않는다.

### 7.4 초기 로딩 순서

Review Center:

```text
panel resolve
  → queue.ready
  → viewer/host/capabilities + saved queues 병렬 조회
  → queue.initialize
  → active queue search
  → queue.page (shell rows)
  → visible range hydration
  → queue.hydrationPatch batches
  → idle 시 다음 page prefetch 여부 판단
```

Review Workspace:

```text
panel resolve
  → review.ready
  → viewer + PR shell + permissions 병렬 조회
  → review.initialize
  → active tab이 Files면:
      files first page + reviewThreads + pending review 병렬
  → 첫 미검토 파일 또는 persisted selected file 선택
  → selected patch fetch
  → checks/commits/activity는 해당 tab 최초 진입 때 lazy load
```

구현 규칙:

- PR shell이 도착하기 전에는 skeleton header를 표시한다.
- shell이 도착하면 tab bar와 action permission을 먼저 활성화한다.
- thread와 pending review를 합칠 때 둘 중 하나가 실패해도 Files tab 자체는
  표시한다.
- 첫 file patch 실패는 navigator를 유지하고 diff pane만 error state로 바꾼다.
- `review.initialize`는 최대한 작은 shell payload여야 하며 files 전체를 포함하지
  않는다.
- 초기 화면에 필요한 요청은 최대 4개 동시, background hydration은 최대 3개
  동시로 제한한다.

### 7.5 cache

`src/git/pullRequestReviewCache.ts`에 process-memory cache를 둔다.

| Resource | TTL | Stale-while-refresh | Invalidate |
|---|---:|---:|---|
| viewer/host | 30분 | 허용 | auth/host/gh version 변경 |
| capabilities | 24시간 | 허용 | host/gh version 변경, capability 오류 |
| queue shell page | 30초 | 2분 | queue mutation, manual refresh |
| PR shell | 20초 | 2분 | any PR mutation, focus refresh |
| files/viewed | 20초 | 2분 | viewed/head/base 변경 |
| review threads | 10초 | 1분 | any comment/thread mutation |
| checks | 15초 | 1분 | checks tab focus, PR head 변경 |
| rules/policy | 5분 | 30분 | base branch 변경 |
| collaborators/teams | 10분 | 1시간 | management drawer manual refresh |
| labels/milestones | 10분 | 1시간 | mutation 또는 drawer refresh |

Cache entry:

```ts
interface ReviewCacheEntry<T> {
  value: T;
  etag?: string;
  fetchedAt: number;
  expiresAt: number;
  staleUntil: number;
  sourceHeadOid?: string;
}
```

캐시 원칙:

- write 후 관련 cache를 단순 삭제하지 말고 mutation 응답으로 즉시 patch한 뒤
  background authoritative refresh한다.
- head OID가 다른 file/thread/check cache는 즉시 사용 금지한다.
- queue row shell과 hydrated data는 cache key를 분리한다.
- disk에 API response cache를 영속화하지 않는다.
- ETag가 제공되는 REST endpoint는 `If-None-Match`를 사용한다.
- GraphQL은 client-side TTL만 사용한다.

### 7.6 focus refresh

VS Code window가 다시 active가 되었을 때:

1. 마지막 refresh가 30초 이내면 아무것도 하지 않는다.
2. pending mutation이 있으면 해당 mutation 완료까지 기다린다.
3. Center는 active queue 첫 page만 refresh한다.
4. Workspace는 shell OID/state/updatedAt를 가볍게 조회한다.
5. 동일하면 현재 tab 데이터는 유지한다.
6. 변경됐으면 affected resource만 stale로 표시하고 background refresh한다.
7. 사용자 입력 중인 composer/draft는 덮어쓰지 않는다.

Focus refresh가 수행되거나 skip된 이유를 OUTPUT에 남긴다.

### 7.7 PR head 변경 감지

감지 지점:

- focus refresh
- comment/Viewed/submit 직전 preflight
- Files/Commits tab manual refresh
- API mutation response의 head OID

알고리즘:

```text
if serverHeadOid === currentHeadOid:
  continue
else:
  pause all new writes
  fetch changed files for old...new if refs are reachable
  map selected path and pending thread anchors
  classify each anchor:
    unchanged | shifted | modified | deleted | unknown
  emit review.headChanged
  require explicit user action
```

UI banner:

```text
New commits were pushed to this pull request.
[Review changes] [Reload] [Keep draft and reload]
```

동작:

- `Review changes`: Commits tab에 새 commit 범위를 열고 write는 계속 잠근다.
- `Reload`: server pending review가 없고 local draft도 비어 있을 때만 즉시 수행.
- `Keep draft and reload`: body/event를 보존하고 anchor impact를 보여준 뒤 reload.
- modified/deleted line comment draft는 자동 재배치하지 않는다.
- unchanged 또는 exact context match인 anchor만 새 line에 제안한다.
- submit은 최신 head OID로 재검증하기 전까지 disabled다.

### 7.8 pending review reconcile

초기화 시 local/server 상태 조합:

| Local | Server | 처리 |
|---|---|---|
| 없음 | 없음 | `none` |
| 있음 | 없음 | local draft 복구, 첫 line comment 때 server pending 생성 |
| 없음 | 있음 | server pending을 로드하고 빈 submit body로 표시 |
| 있음, 같은 ID | 있음 | updatedAt 비교 후 dirty/clean 판정 |
| 있음, 다른 ID | 있음 | 충돌 banner, 둘 다 보존하여 선택 |
| 이전 head | 있음/없음 | `headChanged`로 진입 |

같은 사용자는 같은 PR에 pending review를 하나만 가질 수 있다는 GitHub 제약을
서비스 invariant로 둔다. `addPullRequestReview`에서 이미 pending 오류가 오면
pending review를 재조회하고 사용자의 local draft를 그 review에 연결한다.

### 7.9 mutation queue

같은 PR resource의 write는 직렬화하고 서로 다른 PR의 bulk mutation은 제한된
병렬 실행을 허용한다.

```ts
export interface MutationSchedulerOptions {
  perPullRequestConcurrency: 1;
  bulkConcurrency: 3;
  maxRetries: 2;
  retryBaseDelayMs: 500;
}
```

재시도 대상:

- network reset, timeout
- 502, 503, 504
- secondary rate limit의 명시된 retry-after

자동 재시도 금지:

- submit review
- add thread/reply처럼 중복 생성 위험이 있는 mutation
- 401, 403, 404, 409, 422
- 사용자가 cancel한 operation

중복 생성 위험 mutation에서 응답이 유실되면:

1. 같은 request를 다시 보내지 않는다.
2. thread/pending review를 authoritative refresh한다.
3. client request의 body hash + viewer + 2분 이내 createdAt + anchor로 결과를
   추론한다.
4. 하나로 식별되면 success-recovered로 처리한다.
5. 0개 또는 여러 개면 ambiguous state를 표시하고 GitHub에서 확인 링크를 준다.

### 7.10 optimistic update

허용:

- Viewed toggle
- local queue selection/column setting
- thread resolved toggle
- assignee/label UI chip의 pending 표시

금지:

- review submitted 상태
- comment/thread 생성
- base branch 변경
- reviewer/team request 완료 상태
- mergeability/check conclusion

Viewed와 resolve의 optimistic update는:

1. 기존 snapshot 저장
2. UI patch + spinner dot 표시
3. API 실행
4. success 시 authoritative response 반영
5. failure 시 snapshot rollback + row-local 오류

같은 toggle을 연속 클릭하면 마지막 의도만 남기되 in-flight mutation이 끝난 후
필요하면 반대 mutation을 한 번 더 실행한다.

### 7.11 rate limit, offline, auth

Rate limit:

- primary rate limit remaining/reset을 response header에서 읽는다.
- remaining이 50 미만이면 background hydration/prefetch를 멈춘다.
- primary exhausted면 reset 상대 시간을 banner에 표시한다.
- secondary limit은 `Retry-After`를 우선 사용한다.
- bulk 작업 중 제한에 걸리면 완료 항목은 유지하고 나머지는 paused로 둔다.

Offline:

- cache가 있으면 stale badge와 함께 읽기만 허용한다.
- write 버튼은 disabled + `Connect to GitHub to continue` tooltip.
- retry button은 하나만 제공하고 자동 retry countdown을 강요하지 않는다.

Auth:

- `gh auth status --hostname`으로 활성 계정을 확인한다.
- unauthenticated면 전체 빈 화면 대신 shell + sign-in 안내를 표시한다.
- `Sign in with GitHub CLI`는 terminal에 안전한 안내 command를 열거나 명시적
  command를 실행한다. 실행 전 사용자에게 동작을 알린다.
- 다른 host에 인증된 상태를 github.com 인증으로 오인하지 않는다.
- scope 부족과 repository permission 부족을 별도 메시지로 구분한다.

### 7.12 오류 경계

오류를 다음 범위로 격리한다.

- Center 전체 initialize
- queue page
- row hydration
- bulk operation
- Workspace shell
- 각 tab
- 선택 file patch
- 개별 thread
- composer mutation
- management drawer

row hydration 하나의 실패가 queue 전체를 error로 만들지 않는다. thread reply
실패가 diff를 숨기지 않는다. 오류 action은 가능한 가장 작은 영역에 배치하고
`Retry`, `Open on GitHub`, `Show Output` 중 실제로 도움이 되는 것만 표시한다.

## 8. 라인 댓글, suggestion, 로컬 적용

### 8.1 patch parser의 출력 계약

기존 diff parser와 UI parser를 중복시키지 않는다.
`src/git/pullRequestReviewPatch.ts`의
순수 함수가 GitHub file patch와 필요한 full diff를 다음 model로 변환한다.

```ts
export interface ReviewPatch {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed";
  isBinary: boolean;
  isTruncated: boolean;
  hunks: ReviewPatchHunk[];
  headOid: string;
  baseOid: string;
}

export interface ReviewPatchHunk {
  id: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ReviewPatchLine[];
}

export interface ReviewPatchLine {
  key: string;
  kind: "context" | "addition" | "deletion" | "noNewline";
  text: string;
  oldLine?: number;
  newLine?: number;
  diffPosition?: number;
  canCommentLeft: boolean;
  canCommentRight: boolean;
  contextHash: string;
}
```

`contextHash`:

```text
sha256(
  normalizedPath + "\n" +
  side + "\n" +
  previousNonMarkerLine + "\n" +
  currentLine + "\n" +
  nextNonMarkerLine
)
```

CRLF는 LF로 normalize하되 line text의 나머지 공백은 보존한다. Hash는 UI에
노출하지 않고 head 변경 시 anchor 안전성 판단에만 쓴다.

### 8.2 GitHub line anchor 매핑

새 line comment는 deprecated `position`을 사용하지 않고 `line`/`side`를 쓴다.

| UI 대상 | API side | line |
|---|---|---:|
| 추가 줄 | RIGHT | `newLine` |
| 변경되지 않은 context의 head 쪽 | RIGHT | `newLine` |
| 삭제 줄 | LEFT | `oldLine` |
| context의 base 쪽을 명시적으로 선택 | LEFT | `oldLine` |

Multi-line:

- 사용자가 같은 side의 연속 줄만 선택할 수 있다.
- `start_line <= line`을 검증한다.
- `start_side`와 `side`는 동일하게 유지한다.
- addition과 deletion을 가로지르는 선택은 금지하고 안내한다.
- hunk 경계를 넘는 선택은 금지한다.
- single-line에서는 `start_line`/`start_side`를 보내지 않는다.

`AddThreadInput`:

```ts
export type AddThreadInput = AddLineThreadInput | AddFileThreadInput;

export interface AddLineThreadInput {
  subjectType: "LINE";
  body: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  expectedHeadOid: string;
  contextHash: string;
}

export interface AddFileThreadInput {
  subjectType: "FILE";
  body: string;
  path: string;
  expectedHeadOid: string;
}
```

Mutation 직전 검증:

1. PR current head OID 재조회 또는 TTL 5초 이내 snapshot 확인
2. path가 current files에 존재하는지 확인
3. current patch에서 line/side/contextHash 재매핑
4. exact match면 실행
5. line만 shift되고 context hash가 유일하게 일치하면 새 line을 사용자에게 preview
6. 일치하지 않으면 `HEAD_CHANGED`로 중단

File-level은 line/contextHash 대신 current head OID와 path 존재만 검증한다.
파일이 삭제된 변경도 PR changed file 목록에 존재하면 file-level comment가
가능하다.

### 8.3 diff line interaction

각 diff 행은 다음 구조를 사용한다.

```html
<div class="diff-line" role="row" data-line-key="...">
  <div role="gridcell" class="line-actions">
    <button
      class="icon-button add-comment"
      title="Add a review comment"
      aria-label="Add a review comment on line 42">
      <i class="codicon codicon-add-comment" aria-hidden="true"></i>
    </button>
  </div>
  <div role="gridcell" class="line-number old">...</div>
  <div role="gridcell" class="line-number new">...</div>
  <div role="gridcell" class="line-code">...</div>
</div>
```

- comment button은 hover-only로 완전히 숨기지 않는다. 비hover 상태에서도
  focusable하고, pointer 환경에서는 낮은 opacity로 보인다.
- keyboard focus 시 opacity 1, focus ring 표시.
- line number click은 selection anchor를 시작하고 Shift+click은 범위를 확장한다.
- Escape는 selection/composer를 닫되 입력이 있으면 discard confirmation.
- `C`는 현재 focused line에 composer를 연다. input 안에서는 shortcut을
  가로채지 않는다.
- 오래된/outdated thread는 현재 line에 억지로 붙이지 않고 hunk 상단의
  `Outdated comments` group에 둔다.
- file header의 `Add file comment` button은 `subjectType:"FILE"` composer를
  연다. binary/truncated file에서도 file-level comment는 가능하다.

### 8.4 composer

Composer 구성:

```text
┌ Comment on lines 42–45 · RIGHT ───────────────────────────┐
│ Markdown textarea                                         │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ [Add suggestion]             [Cancel] [Start review]     │
└──────────────────────────────────────────────────────────┘
```

상태:

- idle
- composing
- validating
- creatingPending
- submitting
- error
- staleAnchor

세부 규칙:

- textarea auto-grow는 4–14 line까지만, 이후 내부 scroll.
- Markdown toolbar를 새로 만들지 않는다. keyboard shortcut 안내만 제공한다.
- `Start review`가 기본 action이다.
- pending review가 이미 있으면 label은 `Add review comment`.
- `Add single comment now`는 overflow menu에 두고 즉시 공개 댓글임을
  confirmation에 명시한다.
- body trim 결과가 빈 문자열이면 submit disabled.
- 65,536자 제한 전에 60,000자부터 counter warning을 보인다.
- 전송 중 textarea를 read-only로 만들되 text selection/copy는 허용한다.
- 실패 시 입력과 selection anchor를 보존한다.
- 버튼, icon button, overflow action 모두 `title`과 `aria-label`을 가진다.

### 8.5 suggestion 작성

`Add suggestion`을 켜면 선택 범위의 RIGHT-side 결과를 editable code textarea에
넣는다. 최종 body:

````text
선택적 설명

```suggestion
replacement lines
```
````

규칙:

- suggestion fence는 서비스에서 생성한다. 사용자의 replacement를 fence 밖에
  두지 않는다.
- replacement에 triple backtick이 포함되면 fence 길이를 4개 이상으로 늘리지
  않는다. GitHub suggestion 문법의 호환성을 위해 해당 입력은 validation
  error로 막고 일반 comment로 전환할 수 있게 한다.
- deletion suggestion은 replacement를 빈 string으로 허용한다.
- binary, deleted file, LEFT-only selection에는 suggestion을 허용하지 않는다.
- 선택 범위가 100줄을 넘으면 일반 comment만 허용한다.
- 원문/대체문 mini preview를 submit 전 표시한다.
- suggestion이 포함된 comment임을 review summary의 draft count에서 별도 표기한다.

### 8.6 suggestion parsing

다른 사용자가 남긴 comment에서 suggestion을 파싱할 때:

```ts
export interface ParsedSuggestion {
  index: number;
  replacement: string;
  fenceStartOffset: number;
  fenceEndOffset: number;
  applicable: boolean;
  reason?: SuggestionUnavailableReason;
}
```

- Markdown 전체 parser를 새로 작성하지 않는다.
- fenced block scanner는 line-oriented 순수 함수로 구현한다.
- `suggestion` 바로 뒤의 optional attributes는 보수적으로 무시한다.
- nested/unterminated fence는 suggestion으로 취급하지 않는다.
- 한 comment의 여러 suggestion은 각각 index를 부여한다.
- HTML을 직접 render하지 않고 comment markdown renderer의 sanitize 경로를
  통과시킨다.

### 8.7 로컬 suggestion 적용 전제

`Apply locally`는 다음 조건을 모두 만족할 때만 enabled다.

- PR repository와 현재 VS Code workspace repository가 동일 remote identity
- PR head branch가 current working tree branch이거나 사용자가 명시적으로
  checkout/worktree를 연결함
- file이 workspace root 아래의 추적 파일
- file이 symlink로 workspace 밖을 가리키지 않음
- suggestion anchor가 current working file에서 유일하게 일치
- 해당 범위에 unsaved editor change가 있지 않거나 VS Code document API를 통해
  동일 buffer에 적용 가능
- file이 binary가 아님
- repository state가 merge/rebase conflict 중이 아님

조건이 안 맞으면 button을 숨기지 않고 disabled + 정확한 이유 tooltip을 보인다.
`Open patch preview`는 가능하면 계속 제공한다.

### 8.8 suggestion preview algorithm

`src/git/pullRequestSuggestionApplyService.ts`:

```ts
export interface SuggestionApplyPreview {
  previewId: string;
  path: string;
  before: string;
  after: string;
  startLine: number;
  endLine: number;
  source:
    | "exactWorkingTree"
    | "exactHead"
    | "contextRelocated";
  workingTreeHash: string;
  warnings: SuggestionApplyWarning[];
  expiresAt: string;
}
```

알고리즘:

1. repository identity를 canonical remote로 비교한다.
2. VS Code text document가 열려 있으면 buffer text를 authoritative source로 쓴다.
3. 아니면 workspace file을 읽는다.
4. comment의 original diff anchor에서 base/head 원문 범위를 복원한다.
5. 동일 line 범위가 exact match면 사용한다.
6. 아니면 앞·뒤 최대 3줄 context를 포함한 candidate를 전체 문서에서 찾는다.
7. candidate가 정확히 1개면 relocated preview로 표시한다.
8. 0개면 `SOURCE_CHANGED`, 2개 이상이면 `AMBIGUOUS_CONTEXT`.
9. replacement를 적용한 전체 text와 line ending을 계산한다.
10. 원문/결과 diff preview와 warning을 webview로 보낸다.

절대 fuzzy distance만으로 적용 위치를 고르지 않는다.

### 8.9 suggestion confirm와 undo

Confirm:

1. preview가 만료되지 않았는지 확인한다. TTL 2분.
2. current working buffer hash를 `expectedWorkingTreeHash`와 비교한다.
3. 다르면 preview를 폐기하고 다시 확인하도록 한다.
4. `WorkspaceEdit`로 열린 document buffer에 적용한다.
5. document가 닫혀 있으면 `workspace.fs.writeFile`보다 document를 열어
   `WorkspaceEdit`을 적용해 VS Code undo stack을 보존한다.
6. 자동 save하지 않는다.
7. 자동 stage/commit/push하지 않는다.
8. 변경 후 hash, original range, replacement, document version을 undo token에
   저장한다.
9. diff editor에서 변경 결과를 보여줄 선택 action을 제공한다.

Undo:

1. token TTL은 panel session 또는 10분.
2. current buffer hash가 apply 직후 hash와 동일한지 확인한다.
3. 동일할 때만 inverse `WorkspaceEdit`.
4. 다르면 사용자 변경을 덮지 않고 `Cannot undo safely`를 표시한다.
5. VS Code 자체 Undo도 정상 동작해야 한다.

`Apply locally` 성공은 GitHub comment를 resolve하거나 Viewed로 만들지 않는다.

### 8.10 thread 표시와 상태

Thread card:

```text
┌ avatar  @reviewer · 12m · Outdated? ───── [•••] ┐
│ rendered Markdown                                │
│ suggestion preview + Apply locally              │
│                                                  │
│ 2 replies                         [Resolve]      │
│ [Reply…]                                          │
└──────────────────────────────────────────────────┘
```

표시 규칙:

- pending comment: `Pending` badge + viewer에게만 보인다는 설명 tooltip
- resolved: 내용을 접되 첫 comment summary와 `Unresolve` action 유지
- outdated: `Outdated` badge, 현재 diff line과 분리
- minimized/hidden comment: GitHub reason을 표시하고 기본 접힘
- deleted user: avatar fallback과 `Ghost user`
- long unbroken text: `overflow-wrap:anywhere`
- code block: 가로 scroll, page 전체 폭 확장 금지
- edited: `Edited` label과 updated time

권한 action:

- resolve: `viewerCanResolve`
- unresolve: `viewerCanUnresolve`
- edit/delete: comment author + API permission
- reply: PR read/write permission과 thread 상태
- permission unknown이면 disabled 상태로 시작하고 hydration 후 활성화한다.

### 8.11 review summary와 submit

오른쪽 inspector 하단에는 고정 footer를 둔다.

```text
3 pending comments · 1 suggestion
[Review summary textarea]
( ) Comment
( ) Approve
( ) Request changes
[Submit review]
```

정확한 동작:

- 첫 line comment를 만들 때 server pending review가 생성된다.
- summary body/event는 local draft로 300ms debounce 저장한다.
- `Comment`: body가 비어도 pending comments가 있으면 가능.
- pending comments와 body가 모두 없으면 `Nothing to submit`.
- `Approve`: own PR, draft PR, permission 부족일 때 disabled.
- `Request changes`: body 필수. 비어 있으면 inline validation.
- pending comment가 0개여도 summary-only review 가능.
- submit click 후 확인 dialog에 event, comment 수, 대상 PR/head short SHA 표시.
- submit 전 current head OID preflight.
- 성공 후 pending state를 제거하고 threads/activity/shell을 refresh.
- 성공 toast에는 `View activity` action.
- 실패하면 draft를 그대로 유지하고 재시도 action.
- 중복 클릭은 requestId + submitting state로 차단.

Submit dialog의 destructive hierarchy:

- Comment: primary button
- Approve: primary button, positive 색을 별도 hard-code하지 않음
- Request changes: primary button이지만 VS Code error 배경을 사용하지 않음
- Discard pending review: destructive secondary flow + typed confirmation 불필요,
  명확한 일반 confirmation 필요

### 8.12 VS Code Comment API 연동

Webview와 native diff를 병행하되 comment state source는 `GitHubReviewService` 하나다.

`providers/pullRequestCommentController.ts`:

- base↔head native diff를 열 때 review threads를 CommentThread로 투영한다.
- CommentThread `contextValue`에 `pending`, `resolved`, `outdated`,
  `canResolve`를 조합한다.
- reply/edit/delete/resolve command는 동일 service mutation을 호출한다.
- webview에서 mutation이 성공하면 provider event로 native thread를 refresh한다.
- native command 성공 시 open webview panel에 protocol patch를 broadcast한다.
- native draft input과 webview composer는 동시에 같은 line에서 자동 merge하지
  않는다. 한쪽에 미전송 입력이 있으면 다른 surface에 안내 banner.
- native Comment API가 multi-line/suggestion UI를 충분히 표현하지 못하는
  경우 `Continue in Review Workspace` command를 제공한다.

Native diff는 편집 가능한 working tree 비교와 read-only base↔head 비교를 명확히
구분한다. GitHub review comment는 항상 PR base↔head anchor에 연결한다.

## 9. 팀·조직 관리 UI 상세 명세

### 9.1 제품 원칙

관리 UI는 개인 리뷰 기능을 구현한 뒤 붙이는 부가 기능이 아니다. 다음 두
vertical slice를 같은 milestone과 품질 기준으로 진행한다.

```text
개인 리뷰 slice
Queue → PR 열기 → 파일 검토 → 코멘트 → submit

관리 slice
Org/repo queue → 다중 선택 → 담당/리뷰/label 관리 → 진행 확인
```

공통 기반(protocol, GitHub service, cache, component, accessibility)이 준비되는
즉시 두 slice를 교차 구현한다. 관리 UI 전용 acceptance가 통과하지 않으면 PR
Review 1차 완료로 보지 않는다.

관리 UI는 다음을 최적화한다.

- 누가 무엇을 기다리는지 빠르게 분류
- reviewer/assignee/label/milestone을 안전하게 조정
- draft, conflicts, checks, approval, stale 상태를 한 화면에서 구분
- 여러 repository의 queue를 저장하고 재사용
- 일부 실패를 숨기지 않는 bulk operation
- GitHub 권한과 정책을 정확히 반영

관리 UI는 다음을 하지 않는다.

- 승인/Request changes의 bulk 제출
- 보호 규칙/ruleset 편집
- 자동 reviewer 할당 정책 실행
- GitHub 밖의 조직 데이터 warehouse
- 개인별 생산성 점수, ranking, 감시성 metric
- 자체 backend나 장기 server-side snapshot

### 9.2 관리 domain model

`src/git/pullRequestManagementModel.ts`:

```ts
export type ReviewScope =
  | { kind: "repository"; host: string; owner: string; repo: string }
  | { kind: "owner"; host: string; owner: string }
  | {
      kind: "repositories";
      host: string;
      repositories: Array<{ owner: string; repo: string }>;
    };

export interface SavedReviewQueue {
  id: string;
  name: string;
  scope: ReviewScope;
  query: ReviewQueueQuery;
  columns: ReviewQueueColumnId[];
  sort: ReviewQueueSort;
  createdAt: string;
  updatedAt: string;
  version: 1;
}

export interface ReviewQueueQuery {
  text?: string;
  states: Array<"open" | "closed" | "merged">;
  draft?: boolean;
  authors?: string[];
  assignees?: string[];
  reviewRequested?: string[];
  teamReviewRequested?: string[];
  reviewedBy?: string[];
  labels?: string[];
  excludesLabels?: string[];
  milestones?: string[];
  baseBranches?: string[];
  headBranches?: string[];
  checks?: Array<"pending" | "failed" | "passed" | "unknown">;
  reviewDecisions?: Array<
    "approved" | "changesRequested" | "reviewRequired" | "unknown"
  >;
  conflicts?: boolean;
  updated?: {
    operator: "before" | "after";
    isoDate: string;
  };
  sort: ReviewQueueSort;
}

export interface QueueManagementFields {
  assignees: ActorSummary[];
  requestedReviewers: ActorSummary[];
  requestedTeams: TeamSummary[];
  labels: LabelSummary[];
  milestone?: MilestoneSummary;
  reviewDecision?: ReviewDecision;
  mergeState?: MergeState;
  checks?: CheckSummary;
  policy?: BranchPolicySummary;
  permissions: QueueItemPermissions;
}
```

`ReviewQueueQuery`는 UI의 canonical model이다. GitHub search qualifier로 완전히
표현할 수 없는 field(checks, exact policy, team hydration)는 first-stage search
후 client hydration/filter로 처리한다.

### 9.3 관리 mode 진입

Review Center 상단:

```text
[Review Center] [scope: acme ▾] [queue search................] [Refresh]
┌ Personal ──────────────┐
│ Review requested   12  │
│ Authored            4  │
│ Mentioned           2  │
├ Team & organization ──┤
│ Needs reviewer       8 │
│ Changes requested    5 │
│ Failing checks       3 │
│ Saved queues           │
│  Frontend release   17 │
│  Security review     6 │
│  + New saved queue     │
└────────────────────────┘
```

- `Personal`과 `Team & organization`은 같은 nav level이다.
- 관리 queue를 선택해도 별도 앱으로 이동하지 않는다.
- management-only mode switch를 두지 않는다. Queue 정의가 surface를 결정한다.
- 권한 없는 사용자도 public/readable queue는 볼 수 있고 mutation만 제한한다.
- 모든 관리 action이 unavailable이어도 queue 분석/필터/PR 열기는 동작한다.

### 9.4 scope picker

Scope picker는 popover가 아니라 폭이 좁으면 modal-like drawer, 넓으면 anchored
popover로 표시한다.

구조:

```text
Choose scope
[Search organizations or repositories]

Recent
  acme
  acme/frontend
  personal/repo

Organizations
  acme
    □ frontend
    □ api
    □ mobile

[Cancel] [Use selected repositories]
```

동작:

- current gh host의 viewer organizations를 lazy load.
- organization expand 시 accessible repository 목록을 cursor pagination.
- repository 1개 선택은 repository scope.
- organization root 선택은 owner scope.
- 임의 repository 복수 선택은 repositories scope.
- host를 섞은 scope는 금지.
- 최대 저장 repository 수 기본 25. 넘으면 owner scope 또는 더 좁은 선택 안내.
- private repository 이름을 logs/telemetry에 보내지 않는다.
- 마지막 5개 scope를 workspaceState에 저장.
- organization/repository search 입력은 250ms debounce.
- Escape는 picker를 닫고 trigger focus 복구.

오류:

- org 목록 permission 부족: 직접 owner/repo 입력 제공
- repo 한 곳 조회 실패: 선택 목록에 warning, 나머지 유지
- GHES에서 organization query 차이: capability에 따라 직접 입력 fallback

### 9.5 saved queue builder

`+ New saved queue`는 3단계가 아니라 한 drawer 안의 progressive sections로
구성한다.

```text
New saved queue

Name
[Frontend release review]

Scope
[acme/frontend + acme/design-system ▾]

Match
[Open] [Not draft]
[Base: main]
[Label: release] [Label: frontend]
[Checks: failed or pending]
[Review: required]

Columns
☑ Review  ☑ Checks  ☑ Age  ☑ Assignee  ☐ Milestone

Sort
[Oldest updated first ▾]

Preview
17 pull requests · preview first 5

[Cancel] [Save queue]
```

필터 추가 UI:

- `Add filter` combobox로 field를 고른다.
- 같은 field는 의미가 명확할 때 chip group에 합친다.
- include/exclude label은 색과 아이콘뿐 아니라 `is`/`is not` text를 표시.
- custom search syntax 입력란은 `Advanced query` 접힘 영역에 둔다.
- advanced query와 visual filter가 충돌하면 save를 막고 field-level error.
- preview는 500ms debounce, 이전 request 취소.
- preview 실패가 saved queue 전체 설정을 잃게 하지 않는다.
- 이름은 1–60자, trim 후 중복 이름 허용하되 scope subtitle로 구분.
- built-in queue는 편집할 수 없고 `Duplicate as saved queue` 제공.

저장 형식:

- `globalState` key: `review.savedQueues.v1`
- stable UUID 사용
- queue schema version 포함
- 최대 50개
- drag reorder와 keyboard move up/down 제공
- export/import는 이번 범위가 아니다.

### 9.6 query compiler

`src/git/pullRequestReviewQueryCompiler.ts`는 UI model을 다음 두 단계로
compile한다.

```ts
export interface CompiledReviewQueueQuery {
  searchQuery: string;
  clientPredicates: ReviewQueueClientPredicate[];
  hydrationFields: QueueHydrationField[];
  warnings: QueryCompilationWarning[];
}
```

예:

```text
UI:
scope=acme/frontend
state=open
draft=false
base=main
labels=[release]
checks=[failed,pending]
reviewDecision=[reviewRequired]

searchQuery:
repo:acme/frontend is:pr is:open -is:draft base:main label:release

hydration:
checks, reviewDecision

client predicates:
checks ∈ {failed,pending}
reviewDecision == reviewRequired
```

정확성 규칙:

- 값은 shell escaping이 아니라 gh argument array로 전달한다.
- 따옴표가 필요한 search token은 compiler가 GitHub search 문법에 맞춰 encode.
- user text를 command string에 보간하지 않는다.
- client filter 때문에 page가 50개 미만이면 다음 search page를 최대 5 page까지
  가져와 target page size를 채운다.
- 5 page 후에도 target 미달이면 `Filtered from first 500 matches`를 표시한다.
- count가 정확하지 않으면 숫자 뒤에 `+` 또는 `~`를 표시하고 tooltip로 근거 설명.
- queue count 요청은 UI row 요청보다 낮은 priority.

### 9.7 management queue table

기본 column:

| Column | 최소 폭 | 내용 |
|---|---:|---|
| Select | 32px | checkbox |
| PR | 300px | repo, number, title, draft/state |
| Review | 132px | decision, requested count |
| Checks | 112px | passed/pending/failed |
| Author | 104px | avatar + login |
| Assignee | 120px | 최대 2명 + overflow |
| Age | 80px | updated relative time |
| Actions | 40px | overflow menu |

Optional:

- Labels 160px
- Milestone 120px
- Base 112px
- Merge state 112px
- Requested teams 140px
- Required approvals 120px

Row density:

- row height 36px 기본
- title은 한 줄 ellipsis
- selected row는 background + left indicator
- focus row는 selected와 독립적인 focus outline
- failing check, conflict, changes requested를 색만으로 구분하지 않고 icon/text 사용
- draft는 opacity 감소 대신 `Draft` badge
- repo가 여러 개인 scope에서는 repo를 title 앞에 항상 표시
- repo 하나 scope에서는 repo column을 숨길 수 있음

Header:

- sticky
- sort button은 column label 전체가 동작하며 `aria-sort`
- resize handle은 8px hit target, keyboard `Alt+Arrow`로 8px 조정
- column menu에 show/hide/reset
- table 폭 부족 시 선택/PR/Review/Actions를 남기고 optional column 우선 숨김
- 가로 scroll은 800px 이상에서 마지막 fallback으로만 허용

### 9.8 row quick actions

Hover/focus 시 actions:

- Assign
- Request review
- Add label
- Open review
- More

규칙:

- hover-only action도 tab focus 가능.
- 각 icon button에 `title`과 PR 번호를 포함한 `aria-label`.
- row quick action은 drawer를 열고 바로 mutation하지 않는다.
- `Open review`만 즉시 navigation.
- unavailable permission은 disabled + 원인 tooltip.
- narrow layout에서는 `More` 하나만 유지.

Overflow:

- Open on GitHub
- Copy PR URL
- Edit milestone
- Change base branch
- Convert to draft / Mark ready
- Remove from current queue는 saved query를 바꾸지 않으므로 제공하지 않음

### 9.9 selection과 bulk toolbar

선택 semantics:

- checkbox click: 단일 toggle
- Shift+checkbox: 현재 정렬에서 range
- header checkbox:
  - 현재 로드된 eligible rows 모두 선택
  - 전체 query 결과를 자동 선택하지 않음
- header checkbox tooltip: `Select 50 loaded pull requests`
- 결과 전체 선택 기능은 이번 범위에서 제공하지 않는다.
- queue/filter/sort 변경 시 selection clear 전에 비어 있지 않으면 confirmation.
- PR을 열었다 돌아와도 같은 queue revision이면 selection 복구.

Bulk toolbar:

```text
12 selected
[Request review] [Assign] [Labels] [Milestone] [More ▾] [Clear]
```

폭이 좁으면:

```text
12 selected     [Actions ▾] [Clear]
```

허용 bulk mutation:

- reviewer/user 추가 및 제거
- reviewer/team 추가 및 제거
- assignee 추가 및 제거
- label 추가 및 제거
- milestone 설정/해제
- draft → ready 전환

제외:

- approve, request changes, comment submit
- base branch bulk 변경
- title/body bulk 편집
- close/reopen/merge
- pending review discard

### 9.10 mutation drawer

예: Request review

```text
Request reviews
12 pull requests selected

[Search people or teams]

Suggested
  user alice      Eligible on 12
  team frontend   Eligible on 10 · unavailable on 2

Selected
  team frontend

Operation
(•) Add review request
( ) Remove review request

Affected
  10 will change
   2 will be skipped
     acme/legacy#18 · team unavailable
     acme/api#42 · no permission

[Cancel] [Review changes]
```

공통 drawer sections:

1. selection summary
2. target picker
3. add/remove/set operation
4. eligibility preview
5. warning/error list
6. confirmation

Picker data:

- repository scope: collaborator/requestable reviewer + teams
- multi-repo scope: intersection을 기본 `Available to all` group으로 표시
- 일부 repo만 가능한 대상은 `Available to some` group과 eligible count 표시
- 이미 모든 PR에 적용된 대상은 add mode에서 disabled
- user/team은 icon과 text로 구분
- 검색 결과가 100개 이상이면 pagination

`Review changes`를 누르면 final confirmation step:

```text
Request review from @alice on 10 pull requests?

10 will change
2 will be skipped

[Back] [Request reviews]
```

Mutation action은 이 final button에서만 시작한다.

### 9.11 bulk eligibility

`src/git/pullRequestManagementPreviewService.ts`의 preview는 항목별 결과를
만든다.

```ts
export type EligibilityReason =
  | "eligible"
  | "noPermission"
  | "repositoryUnavailable"
  | "targetUnavailable"
  | "alreadyApplied"
  | "notApplied"
  | "pullRequestClosed"
  | "draftRequired"
  | "capabilityUnavailable"
  | "unknown";

export interface BulkMutationPreviewItem {
  key: PullRequestKey;
  eligible: boolean;
  reason: EligibilityReason;
  before: ManagementFieldSnapshot;
  intendedAfter?: ManagementFieldSnapshot;
}

export interface BulkMutationPreview {
  id: string;
  mutation: BulkManagementMutation;
  createdAt: string;
  expiresAt: string;
  items: BulkMutationPreviewItem[];
  eligibleCount: number;
  skippedCount: number;
  warnings: ReviewWarning[];
}
```

Preview TTL 2분. Confirm 때:

- 선택 key가 preview와 정확히 같은지 확인
- field snapshot이 바뀐 항목만 다시 preview
- permission unknown은 eligible로 가정하지 않음
- API가 idempotent한 add/remove라도 서버 값 재조회

### 9.12 bulk execution과 결과

실행:

- repository별로 group
- 전체 concurrency 3
- 같은 PR mutation 직렬
- progress는 item 완료마다 protocol로 전달
- panel이 닫혀도 완료
- rate limit 시 pause

Progress UI:

```text
Requesting reviews…
██████████░░░░░░ 7 / 10
6 succeeded · 1 failed · 3 remaining
Current: acme/api#42
[Run in background] [Cancel remaining]
```

`Cancel remaining`:

- 이미 시작한 mutation을 강제 취소하지 않음
- 시작하지 않은 item만 cancelled
- 완료 항목 rollback 없음

결과:

```text
Review requests updated
8 succeeded · 2 failed · 2 skipped

Failed
  acme/api#42      Permission changed       [Retry]
  acme/legacy#18   Team unavailable         [Open]

[Copy summary] [Retry failures] [Done]
```

- 성공 row는 authoritative patch.
- 실패 row는 optimistic patch rollback.
- skipped는 실패로 계산하지 않음.
- `Copy summary`에는 token/민감 stderr 없이 repo#number/reason.
- operation result는 session 동안 다시 열 수 있음.
- 완료 toast만으로 결과를 숨기지 않고 drawer가 결과 state를 유지.

### 9.13 Workspace management inspector

PR 하나의 management는 Overview tab 오른쪽 inspector와 header `Manage` button에서
연다.

Sections:

```text
Management
Reviewers
  @alice · Approved
  @bob · Requested
  team/frontend · Requested
  [+ Request review]

Assignees
  @owner
  [+ Assign]

Labels
  bug  release
  [+ Add label]

Milestone
  v2.1

Base branch
  main

State
  Draft [Mark ready]
```

편집 방식:

- inline chip remove는 confirmation 없이 가능하되 5초 Undo action 제공.
- Undo는 inverse API mutation이며 original state가 그대로일 때만 실행.
- reviewer/assignee/labels picker는 drawer component 재사용.
- milestone은 searchable single select + clear.
- base branch 변경은 별도 danger-aware dialog:
  - current/next base
  - files/commits/review impact 경고
  - typed branch name 불필요
  - explicit `Change base branch`
- draft/ready 변환은 영향 설명 후 confirmation.
- title/body 편집은 Overview의 `Edit details` drawer:
  - title single line
  - Markdown body
  - unsaved close confirmation
  - updatedAt revision conflict 처리

### 9.14 permission-aware rendering

Permission source:

1. GraphQL viewer capability fields
2. repository permission
3. endpoint-specific preview/read
4. actual mutation error

UI 상태:

| Permission | 표현 |
|---|---|
| true | enabled |
| false | disabled + 이유 tooltip |
| unknown, 조회 중 | disabled + small spinner + `Checking permission…` |
| unknown, capability 없음 | disabled + `Unavailable on this GitHub host` |
| mutation 중 권한 변경 | rollback + row-local error |

Action을 단순히 숨기는 경우:

- 기능이 현재 GitHub host schema에 완전히 없음
- PR 상태상 의미 자체가 없음(merged PR을 draft로 변환 등)

그 외에는 disabled 상태를 보여 기능 발견성과 원인을 유지한다.

### 9.15 reviewers와 teams

Reviewer picker:

- users와 teams를 한 검색 결과에 섞되 section을 분리
- avatar 없는 team은 organization/team icon
- requested/approved/changes requested 상태 표시
- PR author는 disabled + `Author cannot review their own pull request`
- 이미 requested user/team은 add mode disabled
- team을 request할 수 없는 repository에서는 disabled
- team membership은 UI에 노출 가능한 정보만 표시
- stale team slug mutation 실패 시 목록 refresh

Review request 제거:

- 이미 제출한 approval/review는 삭제하지 않는다.
- requested 상태만 제거함을 dialog/tooltip에 명시한다.
- team request 제거와 individual request 제거를 구분한다.

### 9.16 assignee, label, milestone

Assignee:

- assignee 가능 사용자만 표시
- `Assign yourself` quick option
- duplicate add는 no-op로 성공 처리하되 결과에 `Already assigned`
- 삭제 후 author/reviewer 상태에는 영향 없음

Label:

- repository label color를 VS Code theme 위에서 읽을 수 있게 foreground contrast를
  계산한다.
- label color만으로 의미 전달 금지; 항상 text.
- multi-repo bulk에서 같은 이름/다른 색은 `Varies by repository` 표시.
- 없는 label을 생성하지 않는다.
- bulk remove에서 label 없는 PR은 skipped `notApplied`.

Milestone:

- open milestone 기본, `Show closed milestones` toggle.
- multi-repo에서 milestone은 repository-local identity다.
- 같은 title이어도 각 repository에서 존재하는 항목에만 적용.
- number가 아닌 `{repoKey, milestoneNumber}` mapping을 preview에 저장.

### 9.17 checks와 branch policy

Checks summary:

```ts
export interface CheckSummary {
  state: "pending" | "failed" | "passed" | "neutral" | "unknown";
  total: number;
  passed: number;
  pending: number;
  failed: number;
  skipped: number;
  required?: {
    source: "ghRequired" | "rulesForBranch" | "unavailable";
    total: number;
    passed: number;
    pending: number;
    failed: number;
  };
}
```

정확성:

- `gh pr checks --required`가 명시적으로 반환한 결과는 required source로 사용.
- rules-for-branch endpoint가 반환한 policy는 base branch 기준.
- 둘 다 불가능하면 일반 checks를 required로 추정하지 않는다.
- unavailable이면 `Required status unavailable` text + tooltip.
- mergeable state가 `UNKNOWN`이면 conflict 없음으로 표시하지 않는다.
- review decision 없음과 review required를 구분한다.
- dismissed review가 approval count에 남지 않도록 GraphQL state를 따른다.

Checks tab management affordance:

- Re-run/dispatch workflow는 이번 범위 아님.
- 실패 check row: details link, name, app, duration, conclusion.
- required filter.
- `Open checks on GitHub`.
- policy card: required approvals, required teams/code owners 표현.
- policy 편집 button 없음.

Queue의 checks hydration은 visible rows 우선. `Failed checks` queue는 결과 정확성을
위해 client-filter pagination limit을 표시한다.

### 9.18 queue health summary

Team queue header에는 집계가 가능할 때만 compact summary를 제공한다.

```text
17 open · 6 need review · 3 failing · 2 stale
```

정의:

- `need review`: hydrated `reviewDecision=REVIEW_REQUIRED`
- `failing`: hydrated check state failed
- `stale`: saved queue가 정한 updated-before 조건 또는 UI preference 기본 7일
- counts는 현재 query에서 scan한 범위만 반영할 수 있다.

정확하지 않은 집계:

- `~17` 또는 `17+`
- tooltip: `Based on the first 500 matching pull requests`
- pie/bar chart를 만들지 않는다.
- reviewer performance, response time leaderboard는 만들지 않는다.
- scope와 scan 범위를 항상 함께 표시한다.

### 9.19 관리 refresh와 consistency

개별 mutation 후:

1. Workspace snapshot patch
2. 열린 Center row patch
3. built-in/saved queue count invalidate
4. active queue predicate를 다시 평가
5. mutation 때문에 row가 queue에서 빠지면 600ms success transition 후 제거
6. focus/selection을 다음 row로 이동

Bulk mutation 후:

- 각 item authoritative patch
- active queue에서 사라질 row를 operation 완료 전에는 유지
- 완료 후 `8 items no longer match this queue` banner
- `Show updated items` action으로 임시 결과 view 제공
- manual refresh 전까지 failure rows 유지

외부 GitHub 변경:

- focus refresh가 updatedAt/OID 변화 감지
- 사용자가 management drawer에서 편집 중이면 server change banner
- 단순 add/remove set은 current server value와 intention을 merge
- title/body/base/milestone set conflict는 사용자 확인

### 9.20 관리 UI 키보드

Center:

- `J/K` 또는 Arrow Down/Up: row focus
- `Space`: row selection toggle
- `Shift+Space`: range selection
- `Enter`: Review Workspace 열기
- `A`: Assign drawer
- `R`: Request review drawer
- `L`: Label drawer
- `M`: More menu
- `/`: queue search
- `Cmd/Ctrl+R`: refresh
- `Escape`: drawer/menu/selection의 가장 안쪽 layer 닫기

규칙:

- input/textarea/contenteditable에서는 single-letter shortcut 비활성.
- shortcut은 command palette/tooltip의 보조 수단이며 유일한 접근 경로가 아님.
- shortcut help dialog를 `?`로 열고 모든 action에 tooltip 제공.
- bulk toolbar가 나타나도 focus를 강제로 옮기지 않고 screen reader live region으로
  selection count만 알린다.

Workspace management:

- `G M`: management section focus
- picker list는 Arrow, Home/End, Enter, Space
- chip remove는 Delete/Backspace, 제거 전에 screen reader label 명확히 제공
- drawer 닫힘 시 trigger focus 복구

### 9.21 관리 UI의 완료 조건

다음이 모두 충족되어야 관리 UI 1차 완료다.

- repository, owner, multi-repository scope 생성 가능
- built-in 관리 queue와 saved queue가 같은 shell에서 동작
- 필터 preview와 compiler warning 표시
- 관리 table의 keyboard 탐색/selection/column 조절 가능
- reviewer user/team, assignee, label, milestone bulk preview/실행/부분 실패 처리
- 단일 PR management inspector에서 동일 field 편집
- permission unknown/false/changed 상태 검증
- checks와 required policy의 출처/불확실성 표시
- bulk 중 rate limit/cancel remaining/panel close 처리
- mutation 후 Center/Workspace consistency
- 영어/한국어/긴 문자열/고대비 검증
- 실제 Extension Development Host에서 개인 리뷰 flow와 별개로 관리 flow를
  desktop 폭에서 끝까지 수행

## 10. UI 상태 명세

### 10.1 공통 상태 표현

| State | 시각 표현 | 행동 | 접근성 |
|---|---|---|---|
| Initial loading | 실제 layout과 같은 skeleton | action disabled | `aria-busy=true`, 반복 announce 금지 |
| Refreshing | 기존 content 유지 + toolbar progress | 탐색/읽기 가능, 충돌 write만 잠금 | live region에 한 번 |
| Empty | icon + 원인 + 1개 primary action | filter reset/refresh | heading과 설명 연결 |
| Partial data | 해당 cell/section placeholder | 나머지 기능 유지 | unavailable 이유 text |
| Inline error | 영향 영역 안 error row/card | retry/output | `role=alert`는 새 오류에만 |
| Fatal error | shell 안 full state | retry/sign-in/output | panel title 유지 |
| Success | authoritative state + 짧은 toast | undo 가능 시 제공 | polite live region |
| Disabled | 정상 opacity의 label + disabled control | hover/focus tooltip 이유 | native `disabled` 또는 `aria-disabled` |
| Hover | VS Code list hover background | pointer affordance | hover에만 정보 의존 금지 |
| Focus | 2px VS Code focus border | keyboard action | `:focus-visible` |
| Selected | selected background + indicator | bulk/active state | `aria-selected`/checkbox |
| Pending mutation | local spinner/status dot | 중복 action 제한 | `aria-busy` 영역 국소 적용 |
| Stale | stale badge/banner | refresh 가능 | 상태를 text로 표현 |
| Offline | stale content + offline banner | write disabled | 연결 필요 이유 |
| Rate limited | reset time banner | background load pause | 시간 text |

Skeleton 규칙:

- shimmer animation을 쓰지 않는다.
- `prefers-reduced-motion`과 무관하게 subtle static block.
- 실제 content와 동일한 최소 높이로 layout shift 방지.
- avatar skeleton은 원형, text는 최대 3개 길이 variant.
- 10개 넘는 row skeleton을 만들지 않는다.

### 10.2 Review Center state matrix

| Scenario | Main content | Toolbar/action | Recovery |
|---|---|---|---|
| Boot | nav + header skeleton, 8 rows | disabled | 자동 |
| gh 없음 | 설치 안내 | `Install gh`/docs | 설치 후 retry |
| 인증 없음 | scope shell + sign-in empty | `Sign in` | auth status 재확인 |
| queue 결과 0 | `No pull requests match` | `Edit filters`, `Reset` | query 수정 |
| built-in queue 0 | queue별 긍정 empty copy | refresh | 없음 |
| owner scope repo 0 | 접근 가능한 repo 없음 | change scope | scope picker |
| first page 실패 | full table error | retry/output | 같은 query retry |
| append 실패 | 마지막 row 아래 inline error | retry page | cursor 유지 |
| hydration 실패 일부 | cell에 `Unavailable` | row retry overflow | shell 유지 |
| refresh | 기존 rows + progress | refresh disabled | 완료/오류 |
| saved queue 삭제 | fallback queue로 이동 | undo 5초 | queue 복구 |
| filter preview 중 | preview skeleton | save disabled | 자동 |
| bulk preview 0 eligible | reasons list | confirm disabled | target/selection 수정 |
| bulk 실행 | rows 유지 + drawer progress | cancel remaining | background 가능 |
| bulk 일부 실패 | success patch + failure list | retry failures | 결과 유지 |
| active queue에서 rows 이탈 | success transition | show updated | 다음 focus |
| 1,000+ search matches | page virtualized | load more | cursor paging |

Queue-specific empty copy:

- Review requested: `No pull requests are waiting for your review.`
- Authored: `You have no open pull requests in this scope.`
- Needs reviewer: `Every pull request has a reviewer assigned.`
- Failing checks: `No matching pull requests have failing checks.`
- Changes requested: `No matching pull requests are waiting on requested changes.`

한국어 번역은 같은 의미를 유지하되 문장 길이를 강제로 맞추지 않는다.

### 10.3 Queue row state matrix

| Row state | 표시 |
|---|---|
| Draft | `Draft` badge, normal text opacity |
| Open | open state icon + text는 screen-reader label |
| Merged | merge icon + `Merged` |
| Closed | closed icon + `Closed` |
| Review required | yellow 계열 theme token icon + `Review required` |
| Approved | pass icon + `Approved` |
| Changes requested | warning/error icon + `Changes requested` |
| Checks pending | spinner icon은 animation optional, `Pending` |
| Checks failed | error icon + failed count |
| Checks passed | pass icon + `Passed` |
| Checks unavailable | question icon + `Unavailable` |
| Conflict | warning icon + `Conflicts` |
| Merge state unknown | question icon + `Checking…`/`Unknown` |
| Pending mutation | field chip spinner |
| Permission denied | action disabled, row readable |
| Hydration loading | fixed-width cell skeleton |
| Hydration error | `—` + tooltip가 아니라 `Unavailable` |
| Very long title | 한 줄 ellipsis, native title에 전체 제목 |
| Long repo/name | middle ellipsis 금지; end ellipsis + title |
| Deleted account | Ghost avatar + `ghost` |

### 10.4 Review Workspace shell matrix

| Scenario | Header | Tabs | Primary action |
|---|---|---|---|
| Initial | skeleton | skeleton | disabled |
| Open PR | state/review/check badges | all available tabs | Review changes |
| Draft PR | Draft badge | Files/Commits/Checks/Activity | submit 권한별 |
| Closed PR | Closed badge | read-only | comments 권한별, review submit disabled |
| Merged PR | Merged badge | read-only | review submit disabled |
| Head changed | blocking banner | 읽기 가능 | write disabled |
| Base changed | warning banner | stale data 표시 | reload |
| Offline cached | stale + offline | cached tabs | writes disabled |
| Auth lost | content 유지 | read cache | sign in |
| PR deleted/no access | fatal body | 없음 | open browser 가능 시 |
| Partial permission | shell 정상 | 모두 읽기 | 해당 action disabled |

### 10.5 Files tab state matrix

| Scenario | Navigator | Diff | Inspector |
|---|---|---|---|
| 0 files | empty | `No changed files` | review summary |
| Loading files | row skeleton | placeholder | thread skeleton |
| File selected | active row | patch | matching threads |
| Patch truncated | file row warning | partial patch + load context | warning |
| Binary | file row binary icon | metadata + native/open action | general thread only |
| Deleted | deleted badge | LEFT lines | suggestion disabled |
| Renamed | old → new path | rename header | threads by current path |
| Huge diff | metadata first | hunk virtualization | threads lazy |
| Patch error | navigator 유지 | local error + retry | existing threads 유지 |
| No file selected | list | instruction empty | review summary |
| No threads | 정상 | diff | `No comments on this file` |
| Thread load error | 정상 | diff | local error |
| All viewed | 100% progress | selected diff | next unviewed disabled |
| Viewed toggle pending | optimistic check | 유지 | status dot |
| Viewed failed | rollback | 유지 | inline error |
| Filter result 0 | original count subtitle | `No files match` | reset filter |

### 10.6 composer/submit matrix

| Scenario | Composer | Submit |
|---|---|---|
| Empty body | start review disabled | summary rules 적용 |
| Valid body | enabled | event별 enabled |
| Over 60k | warning counter | enabled until hard limit |
| Over hard limit | field error | disabled |
| Pending creation | read-only + spinner | disabled |
| Creation failed | body/anchor preserved | retry |
| Anchor stale | body preserved, old context | re-anchor/copy/discard |
| Own PR | comment 가능 | approve/request changes disabled |
| Draft PR | comment 가능 | approve/request changes disabled |
| Request changes + empty summary | n/a | inline required error |
| Pending comments only + Comment | n/a | enabled |
| Nothing pending/body empty | n/a | disabled + reason |
| Submit preflight | n/a | spinner, no duplicate |
| Submit ambiguous | draft 유지 | refresh/GitHub 확인 |
| Submit success | composer closed | success toast/activity |

### 10.7 thread state matrix

| Scenario | 표현 | Actions |
|---|---|---|
| Active | expanded | reply, resolve permission별 |
| Resolved | collapsed summary | unresolve |
| Outdated | separate group | reply 가능 여부, open original |
| Pending | Pending badge | edit/delete own, no resolve |
| Reply sending | optimistic placeholder 금지, spinner draft | duplicate disabled |
| Reply failed | input preserved | retry |
| Edited | Edited label | own edit/delete |
| Deleted | remove card or deleted placeholder if replies | 없음 |
| Minimized | reason + collapsed | expand |
| Author deleted | ghost | permission별 |
| Very long markdown | max width + wrap/scroll | copy code |
| Multiple suggestions | numbered cards | each preview/apply |
| Apply unavailable | preview read-only | disabled reason |
| Resolve failed | optimistic rollback | retry |

### 10.8 management drawer matrix

| Scenario | Picker | Preview | Confirm |
|---|---|---|---|
| Loading targets | skeleton rows | unavailable | disabled |
| No targets | reason empty | 0 eligible | disabled |
| Search 0 | `No matches` | current selection 유지 | selection 있으면 가능 |
| All eligible | target list | affected count | enabled |
| Some eligible | groups + warning | change/skip 목록 | enabled |
| None eligible | disabled reasons | full skipped list | disabled |
| Permission checking | target pending | unknown | disabled |
| Permission denied | readable target | skipped reason | eligible 있을 때만 |
| Preview expired | values 유지 | stale notice | re-preview |
| Server values changed | diff 재계산 | changed items | reconfirm |
| Running | picker read-only | progress | cancel remaining |
| Partial failure | targets 유지 | result groups | retry failures |
| Complete | authoritative values | summary | done |
| Rate limited | current progress | paused/reset time | resume 자동/수동 |
| Panel reopened | operation status | current progress/result | 적절 action |

### 10.9 responsive states

Review Center:

| Width | Layout |
|---:|---|
| `<560px` | queue nav drawer, card rows, bulk actions menu, filters full-screen drawer |
| `560–799px` | compact nav rail 또는 drawer, essential columns만 |
| `800–1199px` | 좌측 queue nav 220px + table, optional columns 일부 |
| `>=1200px` | queue nav 240px + full configurable table |

Review Workspace:

| Width | Layout |
|---:|---|
| `<560px` | file navigator/diff/inspector 한 번에 하나, top segmented switch |
| `560–799px` | navigator collapsible, diff main, inspector bottom drawer |
| `800–1199px` | navigator 220px + diff, inspector overlay drawer |
| `>=1200px` | navigator 240px + diff + inspector 320px |

세부:

- 최소 지원 폭 320px.
- width는 window가 아니라 webview container의 `ResizeObserver`로 판단.
- resize 중 content를 unmount하지 않는다.
- active composer/thread/draft를 pane 전환해도 보존.
- compact mode에서도 submit action은 inspector/summary route에서 도달 가능.
- table을 320px에 축소해 모든 column을 구겨 넣지 않는다.
- touch target은 coarse pointer에서 최소 36px, 기본 compact desktop control 28px.

### 10.10 motion states

허용:

- drawer 120ms opacity/translate
- row removal 120ms height/opacity
- success check 120ms opacity
- progress indicator

금지:

- looping decorative animation
- row hover scale
- layout을 흔드는 spring
- skeleton shimmer
- parallax/gradient animation

`prefers-reduced-motion: reduce`:

- 모든 transition duration 0–1ms
- progress 의미는 text로 유지
- animated spinner는 static codicon + `Loading…` text 또는 최소 회전

### 10.11 confirmation policy

| Action | Confirmation |
|---|---|
| Viewed toggle | 없음 |
| Resolve/unresolve | 없음 + 실패 rollback |
| Edit comment | 저장 button |
| Delete comment | 일반 confirmation |
| Add line comment to pending | 없음 |
| Add single comment now | 공개 즉시 게시 confirmation |
| Submit Comment review | review summary confirmation |
| Approve | review summary confirmation |
| Request changes | review summary confirmation |
| Discard pending review | 일반 confirmation |
| Apply suggestion locally | diff preview + confirm |
| Undo suggestion | safe hash면 즉시 |
| Add/remove assignee/label 단일 | 즉시 + 가능 시 undo |
| Request/remove reviewer 단일 | final action confirmation |
| Bulk mutation | eligibility preview + final confirmation |
| Change base | impact dialog |
| Convert draft/ready | 일반 confirmation |
| Delete saved queue | 일반 confirmation + local undo |

확인 dialog의 primary label은 `OK`가 아니라 실제 동사로 작성한다.

## 11. 횡단 품질 요구사항

### 11.1 접근성 기준

목표:

- WCAG 2.2 AA에 부합하는 keyboard, focus, contrast, naming
- VS Code high contrast/light/dark theme에서 의미 보존
- 200% zoom과 320px container에서 주요 작업 완료
- screen reader로 queue 선택, PR 열기, comment, submit, management mutation 가능

Semantic structure:

- panel root 안에 하나의 `h1`
- major section은 `h2`, card title은 heading level 연속성 유지
- navigation은 `<nav aria-label="Review queues">`
- tab은 `role=tablist/tab/tabpanel` 완전한 pattern
- queue는 실제 `<table>` 또는 동일한 table semantics를 갖는 grid. 단순 div list에
  table ARIA를 흉내 내지 않도록 우선 native table을 사용한다.
- virtualized table 때문에 native table이 불가능하면 `role=rowgroup/row/gridcell`,
  `aria-rowindex`, `aria-rowcount`, `aria-colindex`를 구현한다.
- diff는 interactive grid지만 code line 자체를 screen reader가 과도하게 읽지
  않도록 file/hunk navigation과 line label을 제공한다.
- status badge는 색 외 text 포함.

### 11.2 focus management

공통:

- mouse click 후 모든 요소에 focus ring을 강제하지 않고 `:focus-visible`.
- outline을 제거하지 않는다.
- modal/drawer는 focus trap, background inert, Escape close, trigger focus return.
- toast로 focus를 이동하지 않는다.
- 새 inline error는 focus를 강제로 옮기지 않고 live region announce.
- fatal error만 heading에 programmatic focus.

Center:

- queue 변경 후 첫 row에 강제 focus하지 않는다. table heading/기존 anchor 유지.
- refresh 후 같은 PR key/offset 복구.
- 선택 row가 결과에서 사라지면 다음 row, 없으면 이전 row, 모두 없으면 table
  container로 focus.
- bulk drawer close 후 원래 action button 또는 table focus row로 복구.

Workspace:

- tab 전환 시 panel heading에 focus하지 않는다. 선택 tab 유지, panel은
  `aria-labelledby`.
- file 선택 후 keyboard action이면 diff hunk heading에 focus할 수 있는 skip
  action 제공. pointer action이면 focus 유지.
- composer open 시 textarea focus.
- composer close 시 해당 line comment button으로 복구.
- submit dialog close 시 submit button.
- head change reload 후 persisted file/hunk anchor 복구가 실패하면 file title.

### 11.3 keyboard 상세

모든 custom interactive element는 native button/input/select를 우선 사용한다.
`div role=button`은 필요한 경우에만 쓰고 Enter와 Space 둘 다 구현한다.

Roving tabindex:

- queue nav
- virtualized queue rows
- file navigator tree/list
- diff line action column
- reviewer/label picker options
- thread overflow menus

Tab은 surface 간 이동, Arrow/J/K는 surface 내부 이동으로 역할을 분리한다.
Home/End, PageUp/PageDown을 virtual list에서 지원한다. focus 대상이 unmount되는
virtualization은 금지하고 focused row는 overscan 안에 pin한다.

Shortcut collision:

- macOS `Cmd+R`은 VS Code/webview 동작과 충돌할 수 있으므로 실제 key event와
  command contribution을 검증해 안전할 때만 사용.
- browser/VS Code 예약 shortcut은 가로채지 않는다.
- 문자 shortcut은 `event.ctrlKey/metaKey/altKey`가 없고 editable target이 아닐
  때만 처리.

### 11.4 tooltip과 accessible name

모든 button/button-like control:

- visible text가 있더라도 의미 보강이 필요하면 `title`
- icon-only는 `title` + `aria-label`
- toggle은 `aria-pressed`
- menu trigger는 `aria-haspopup` + `aria-expanded`
- disabled reason을 hover와 focus 모두에서 볼 수 있어야 함

Native `title`이 disabled button에서 표시되지 않는 플랫폼 문제를 피하려면
disabled control을 tooltip wrapper로 감싸고 button 자체에는 `aria-describedby`를
연결한다. Wrapper가 action을 대신 실행해서는 안 된다.

Tooltip copy 예:

```text
Refresh review queue
Request a review from people or teams
Mark src/app.ts as viewed
Submit 3 comments as a review
Unavailable: you cannot approve your own pull request
Unavailable: required checks are not exposed by this GitHub host
```

Tooltip에 shortcut이 있으면 마지막에 `— R`처럼 보조 표기한다.

### 11.5 contrast와 theme

CSS는 `DESIGN.md`의 VS Code semantic token만 사용한다.

필수 확인 theme:

- Dark+ 기본
- Light+ 기본
- Dark High Contrast
- Light High Contrast

규칙:

- text contrast 4.5:1 목표, large text 3:1
- focus/non-text boundary 3:1
- GitHub label의 arbitrary color는 배경을 그대로 쓰지 않고 contrast helper로
  foreground/border를 계산
- addition/deletion background는 VS Code diff token 사용
- selection과 hover가 겹쳐도 focus ring 식별 가능
- disabled를 opacity 하나로 표현하지 않음
- error/warning/success icon에 text/accessible label
- inline code/comment Markdown renderer도 theme variables 사용

### 11.6 zoom, 긴 문자열, overflow

검증:

- VS Code zoom 0, +2, +4
- UI locale English/Korean
- 80자 repository name
- 200자 branch
- 300자 PR title
- 50자 login/team slug
- label 100자
- comment에 500자 unbroken URL/token-like string
- 1,000줄 code block

처리:

- identifier는 `overflow-wrap:anywhere`를 제한적으로 사용
- branch/repo/file path는 end ellipsis + full title
- code는 wrap하지 않고 horizontal scroll 기본
- drawer footer는 content가 길어져도 sticky
- viewport 전체를 밀어내는 `min-width:auto` flex child를 방지하기 위해 필요한
  child에 `min-width:0`
- menu/popover는 container 경계를 벗어나지 않게 position clamp
- tooltip은 320px max width와 wrap

### 11.7 성능 budget

측정 환경:

- macOS/Windows 일반 개발 장비
- 1,000 PR search result 중 100개 로드
- PR changed files 1,000개
- selected file patch 10,000 lines
- review threads 500개

Budget:

| Metric | Target |
|---|---:|
| Center shell first render | panel resolve 후 100ms 이내 |
| Cached queue usable | 300ms 이내 |
| Network queue first page | API 제외 UI 처리 150ms 이내 |
| Workspace shell render | shell payload 후 100ms 이내 |
| File selection feedback | 50ms 이내 |
| Scroll frame | p95 16.7ms 목표, 33ms 초과 frame 최소화 |
| Key navigation response | 50ms 이내 |
| Hydration patch render | 100 rows batch당 50ms 이내 |
| Memory | review panel 추가 heap 150MB 미만 목표 |
| Initial webview JS | 각 surface minified 250KB 미만 목표 |

구현:

- queue row virtualization은 200 rows 이상에서 활성화
- file list는 300 files 이상에서 virtualization
- diff는 hunk 단위 virtualization, thread anchor가 있는 hunk pin
- Markdown은 visible thread만 render
- avatar image lazy load
- row hydration batch 최대 20 keys
- progress message throttle 100ms
- resize handler `requestAnimationFrame`
- scroll listener passive
- render loop에서 `innerHTML` 전체 교체 금지
- delegated events 또는 component-local listener 사용
- sanitized Markdown result는 comment ID/updatedAt로 memoize

측정 hook:

```ts
performance.mark("review:center:render:start");
performance.mark("review:center:first-rows");
performance.measure(...);
```

개발 모드에서만 OUTPUT에 p50/p95가 아니라 개별 주요 measure를 debug log로
남긴다. 사용자 source/body를 performance mark에 넣지 않는다.

### 11.8 i18n

기본 영어, 한국어 bundle을 함께 구현한다.

파일:

- `l10n/bundle.l10n.ko.json`: runtime host strings
- webview initialize payload의 `strings`: webview UI strings
- `package.nls.json`, `package.nls.ko.json`: command/view title

Webview에서 자체 영어 string을 DOM에 흩뿌리지 않는다.

```ts
export interface ReviewWebviewStrings {
  centerTitle: string;
  reviewRequested: string;
  teamOrganization: string;
  requestReview: string;
  submitReview: string;
  approve: string;
  requestChanges: string;
  markViewed: string;
  // surface별 nested object로 300–600 line 파일에 분할
}
```

형식:

- count는 `vscode.l10n.t("{0} pull requests", count)` 방식의 locale-aware source.
- 상대 시간은 `Intl.RelativeTimeFormat`.
- 날짜는 `Intl.DateTimeFormat`.
- 숫자는 `Intl.NumberFormat`.
- login, branch, file path는 번역하지 않음.
- dynamic sentence를 문자열 조각으로 이어 붙이지 않음.
- 영어/한국어 key parity test.
- aria-label/tooltip/error/empty state도 번역.

### 11.9 observability

OUTPUT channel `Git Simple Compare`에 다음 event를 structured prefix로 남긴다.

```text
[review-center] initialize host=... scopeKind=owner
[review-center] queue.load queueId=... replace=true
[review-center] queue.loaded items=50 hasNext=true durationMs=...
[review-center] hydration.batch items=20 fields=checks,reviewDecision
[review-center] refresh.skipped reason=fresh
[review-workspace] open repo=... pr=123
[review-workspace] tab.load tab=files
[review-workspace] head.changed old=abc1234 new=def5678
[review-workspace] draft.reconciled result=server-linked
[review-mutation] start kind=submitReview correlationId=...
[review-mutation] complete kind=toggleViewed durationMs=...
[review-management] bulk.start kind=requestReview total=12
[review-management] bulk.progress completed=6 failed=1
[review-management] bulk.complete succeeded=9 failed=1 skipped=2
```

반드시 log:

- panel activate/dispose
- load start/complete/failure/cancel/skip
- refresh trigger/skip reason
- cache hit/stale/miss
- head/base/state transition
- pending review reconcile result
- mutation start/complete/failure/ambiguous
- bulk item aggregate progress
- capability disabled/unknown → false
- rate limit pause/resume
- webview message validation failure

로그 금지/마스킹:

- token, Authorization
- comment/review/PR body
- source code/diff content
- full private repository URL
- arbitrary query text
- user email

Repository identity는 기존 Output 정책과 일치시키고 필요한 경우 owner/repo만
기록한다. body는 길이만 기록할 수 있다.

모든 오류는 `correlationId`를 UI와 OUTPUT에 연결한다. 사용자에게는
`Show Output` action을 제공하고 ID를 복사할 수 있게 한다.

### 11.10 security

- gh/API argument는 배열 기반 실행, shell interpolation 금지.
- external URL은 `https`와 현재 GitHub host allowlist 검증 후
  `vscode.env.openExternal`.
- webview CSP:
  - default-src 'none'
  - img-src webviewSource https: data:
  - style-src webviewSource 'nonce-...' 또는 필요한 VS Code 방식
  - script-src 'nonce-...'
  - connect-src 금지; API는 extension host만
- comment Markdown HTML sanitize.
- raw user string을 `innerHTML`에 직접 대입 금지.
- path traversal 방지: suggestion path를 workspace root와 realpath 기준 검증.
- symlink escape 검증.
- workspace trust가 없으면 local suggestion apply, checkout 관련 action disabled.
- command URI는 필요한 command만 allowlist.
- pending state에 API response/token 저장 금지.
- logs에 body/source 금지.
- bulk mutation preview ID는 random UUID + session map, UI가 payload를 바꿔
  confirm하지 못하게 함.

### 11.11 데이터 최소화와 관리 윤리

- queue는 GitHub에서 현재 필요한 page만 조회.
- team membership 전체를 장기 저장하지 않음.
- private repository 데이터는 local process memory를 벗어나지 않음.
- 자체 telemetry를 추가하지 않음.
- 관리 summary는 작업 상태만 보여주고 사람별 평가 지표를 만들지 않음.
- saved queue는 query definition만 저장하고 결과 snapshot은 저장하지 않음.
- `Copy summary`는 사용자가 명시적으로 누른 경우에만 clipboard 변경.

## 12. 테스트 계획

### 12.1 테스트 층

```text
순수 unit
  domain/parser/query/reducer/migration/location/suggestion

service contract
  fake GhRunner로 GraphQL/REST request와 오류 매핑

protocol
  message validation, revision, cancel, stale response

DOM component
  render/state/keyboard/ARIA

extension integration
  command registration, panel lifecycle, provider sync, persistence

end-to-end
  Extension Development Host + controlled GitHub fixture/mock boundary

visual QA
  실제 rendered webview의 theme/width/state 스크린샷

manual live GitHub smoke
  별도 disposable test repository에서 read/write flow
```

기능 테스트 성공과 visual QA 성공을 별도 체크한다.

### 12.1.1 테스트 실행 인프라

현재 `package.json`의 unit test entry가 파일명을 모두 직접 나열하므로 R00에서
새 test를 자동 발견하도록 먼저 바꾼다.

새 파일:

```text
scripts/run-node-tests.mjs
playwright.config.ts
test/webview/
test/a11y/
test/extension/
test/visual/
```

`scripts/run-node-tests.mjs`:

1. `test/` 바로 아래의 `*.test.ts`를 정렬해 찾는다.
2. esbuild API로 `out-test/`에 bundle한다.
3. 생성된 `*.test.js`를 정렬한다.
4. `node --test <각 파일 절대 경로>`를 `spawn`한다.
5. child exit code를 그대로 반환한다.
6. `test/webview|a11y|extension|visual`의 `*.spec.ts`는 unit build에서 제외한다.

Planned scripts:

```json
{
  "test": "node scripts/run-node-tests.mjs",
  "test:webview": "playwright test test/webview",
  "test:a11y": "playwright test test/a11y",
  "test:extension": "node out-test-extension/run.js",
  "test:visual": "playwright test test/visual"
}
```

Planned dev dependencies:

- `@playwright/test`
- `@axe-core/playwright`
- `@vscode/test-electron`

설치/브라우저 다운로드는 구현 시 사용자 환경과 CI 정책에 맞춰 명시적으로 한다.
production dependency에는 넣지 않는다. Extension host test compile/run script는
기존 VS Code engine version과 호환되는 Electron을 고정한다.

### 12.2 fixture 원칙

`test/fixtures/githubReview/`:

```text
viewer.github-com.json
viewer.ghes.json
queue.search.page1.json
queue.search.page2.json
queue.hydration.mixed.json
pr.open.json
pr.draft.json
pr.closed.json
pr.merged.json
pr.permissions.readonly.json
files.small.json
files.renamed-deleted-binary.json
files.1000.generated.json
patch.single-hunk.diff
patch.multi-hunk.diff
patch.crlf.diff
patch.truncated.diff
patch.10000-lines.generated.diff
threads.active.json
threads.pending-resolved-outdated.json
threads.500.generated.json
checks.mixed.json
checks.required-unavailable.json
policy.rules.json
pending.none.json
pending.existing.json
management.people-teams.json
management.labels-milestones.json
errors.rate-limit.json
errors.permission.json
errors.validation.json
```

규칙:

- 실제 private repository 응답을 복사하지 않는다.
- login/repo/body/source는 synthetic.
- generated fixture는 generator source를 commit하고 giant JSON을 무조건
  commit하지 않는다.
- fixture schema에 API version/source endpoint 주석 metadata.
- GraphQL fixture는 `data`/`errors` 조합도 포함.
- REST fixture는 status/header/body를 함께 표현.

### 12.3 순수 unit test 파일

다음 파일명을 기준으로 구현한다.

```text
test/pullRequestReviewQueryCompiler.test.ts
test/pullRequestReviewPatch.test.ts
test/pullRequestReviewLocation.test.ts
test/pullRequestSuggestion.test.ts
test/pullRequestSuggestionApplyService.test.ts
test/reviewQueueState.test.ts
test/pullRequestReviewState.test.ts
test/pullRequestReviewSelectors.test.ts
test/reviewStateMigration.test.ts
test/pullRequestReviewPermission.test.ts
test/pullRequestReviewCache.test.ts
test/pullRequestReviewMutationScheduler.test.ts
test/reviewI18nParity.test.ts
```

`pullRequestReviewQueryCompiler`:

- repository/owner/multi-repo scope
- include/exclude label
- quoted space/special character
- user text가 argument 하나로 유지
- client predicate/hydration field 생성
- unsupported combination warning
- exact count 불가 marker
- saved query serialize/deserialize round-trip

`pullRequestReviewPatch`:

- addition/deletion/context old/new line
- no-newline marker
- multi hunk diffPosition
- rename/empty patch/binary/truncated
- CRLF normalize
- malformed hunk graceful error
- 10,000 lines performance budget

`pullRequestReviewLocation`:

- LEFT/RIGHT single line
- file-level on text/binary/deleted file
- multi-line same side
- mixed side reject
- hunk crossing reject
- head shift unique context
- ambiguous context reject
- deleted file/outdated anchor
- head OID mismatch

`pullRequestSuggestion`:

- single/multiple suggestion
- empty replacement
- description + fence
- ordinary code block 제외
- unterminated/nested fence
- triple backtick in replacement rejection
- Unicode/CRLF

`pullRequestSuggestionApplyService`:

- exact working buffer
- exact head/current file
- unique context relocate
- 0/2 candidates reject
- workspace 밖 path reject
- symlink escape reject
- unsaved document WorkspaceEdit
- hash race reject
- safe undo
- changed-after-apply undo reject
- line endings/trailing newline preservation

`reviewQueueState`:

- replace/append dedupe
- sort 유지
- selection key 보존/제거
- hydration patch가 row height model을 안 바꿈
- refresh failure content 유지
- optimistic/rollback/authoritative
- bulk progress
- stale response skip는 coordinator와 함께 검증

`pullRequestReviewState`:

- initialize/tab load
- selected file 삭제 시 fallback
- Viewed optimistic/rollback
- pending create/reconcile/submit
- head changed write lock
- thread add/edit/delete/resolve
- composer stale anchor
- management patch
- fatal과 local error 격리

### 12.4 service contract test

```text
test/pullRequestReviewQueryService.test.ts
test/pullRequestReviewMutationService.test.ts
test/pullRequestReviewQueueService.test.ts
test/pullRequestManagementService.test.ts
test/pullRequestReviewPolicyService.test.ts
test/pullRequestReviewCapabilityService.test.ts
test/ghRunner.test.ts
```

Fake:

```ts
class FakeGhRunner implements GhRunner {
  readonly calls: GhCall[] = [];
  enqueue(result: GhResult | Error): void;
  runJson<T>(request: GhRequest, signal?: AbortSignal): Promise<T>;
}
```

검증:

- `gh api graphql` variable이 query string 보간이 아닌 `-F`/safe input
- host가 모든 API request에 전달
- REST api version header
- pagination cursor/page
- GraphQL partial `data + errors`
- 401/403 permission/scope 구분
- 404 no access/not found 안전 메시지
- 422 field error mapping
- 429/secondary limit retry-after
- abort가 child process 정리
- stdout JSON 오류
- stderr redaction
- response body 없는 204

Review thread:

- pending review create/reuse
- add single/multi line thread
- reply pending/submitted thread
- submit COMMENT/APPROVE/REQUEST_CHANGES
- empty Request changes validation
- mark/unmark Viewed
- resolve/unresolve
- edit/delete review comment
- ambiguous create recovery query

Management:

- user/team review request add/remove
- assignee add/remove
- label add/remove
- milestone set/clear
- title/body/base patch
- draft/ready mutation
- eligibility across multi-repo
- silent mismatch authoritative verification
- partial bulk failure
- concurrency 3
- cancel remaining
- preview expiration/revision

Checks/policy:

- general/required checks separation
- unavailable required state
- rules base branch
- neutral/skipped/pending aggregation
- review decision mapping
- merge state unknown

### 12.5 protocol test

```text
test/reviewProtocolValidation.test.ts
test/reviewRequestCoordinator.test.ts
test/reviewPanelRouting.test.ts
test/reviewQueuePanelRouting.test.ts
```

검증:

- unknown type 거부
- missing/invalid payload field
- invalid URL/path/resourceKey
- read response revision ordering
- mutation baseRevision conflict
- same requestId dedupe
- cancel read
- mutation panel-close continuation
- resource별 직렬 mutation
- different PR bulk concurrency
- stale response OUTPUT log
- disposed panel에 post 금지
- reopened panel operation restore
- protocol payload에 Error/Date 객체 없음

Runtime validator는 외부 dependency를 새로 넣지 않고 type guard를 작은 도메인
함수로 분리한다. Validator test가 모든 union type을 enumerate하도록 type-level
exhaustiveness helper를 둔다.

### 12.6 DOM component test

`@playwright/test`로 실제 HTML builder와 media asset을 로드한다.
`src/webview/shared/webviewTestHarness.ts`가 `acquireVsCodeApi`,
message/state/host response fixture만 대체한다. production renderer와 다른
테스트 전용 renderer를 만들지 않는다. UI framework는 도입하지 않는다.

```text
test/webview/reviewUiButton.spec.ts
test/webview/reviewUiTabs.spec.ts
test/webview/reviewUiQueueTable.spec.ts
test/webview/reviewUiQueueNav.spec.ts
test/webview/reviewUiPicker.spec.ts
test/webview/reviewUiDrawer.spec.ts
test/webview/reviewUiDiff.spec.ts
test/webview/reviewUiThread.spec.ts
test/webview/reviewUiComposer.spec.ts
test/webview/reviewUiSummary.spec.ts
```

Button:

- icon button title/aria-label 필수
- disabled reason aria-describedby
- toggle aria-pressed
- pending aria-busy

Tabs:

- Arrow/Home/End
- selected/tabindex
- panel aria-labelledby
- focus 유지

Queue table:

- table/grid semantics
- aria row/column indexes
- sort aria-sort
- row keyboard/selection/range
- virtual focused row pin
- long text title
- responsive column hiding

Picker/drawer:

- focus trap/return
- search keyboard
- selected chips remove
- loading/empty/error/partial
- Escape hierarchy

Diff/composer:

- line accessible label
- comment button tooltip
- LEFT/RIGHT selection
- C shortcut input collision
- composer focus/recovery
- stale anchor/input preservation

Thread/review summary:

- pending/resolved/outdated badges
- permission action states
- Markdown sanitization
- submit event validation
- duplicate click prevention

### 12.7 accessibility automation

가능하면 axe-core를 DOM harness와 실제 rendered surface에 사용한다.

검사:

- serious/critical violation 0
- accessible name
- duplicate ID
- ARIA required child/parent
- color contrast는 automated + manual theme 확인
- heading order
- landmark
- form label/error association
- dialog name/focus trap

자동 검사가 대체하지 못하는 수동 검사:

- logical focus order
- live region 과다 announce
- keyboard shortcut 충돌
- tooltip hover/focus
- high contrast에서 selection/focus 구분
- 200% zoom reflow
- screen reader table/diff usability

### 12.8 extension integration test

```text
test/extension/reviewCommands.integration.test.ts
test/extension/reviewCenter.integration.test.ts
test/extension/reviewWorkspace.integration.test.ts
test/extension/reviewCommentController.integration.test.ts
test/extension/reviewPersistence.integration.test.ts
```

검증:

- commands/package contributions 등록
- Review Center view resolve/dispose/reopen
- PR key로 singleton/reveal 또는 multi-panel 정책 준수
- workspace folder/repository 연결
- Output channel log
- global/workspace state migration
- Comment API provider/webview refresh broadcast
- window focus refresh/skip
- extension deactivate 중 child process cleanup
- untrusted workspace의 local apply disabled

### 12.9 end-to-end scenario

E2E harness는 GitHub API boundary를 deterministic fake server/runner로 대체하고
Extension Development Host에서 실제 webview DOM을 조작한다.

Scenario E01 개인 review:

1. Review Center 열기
2. Review requested 12 count 확인
3. keyboard로 두 번째 PR 열기
4. Files tab 첫 unviewed file
5. line 42에 comment 입력
6. pending badge/count
7. suggestion comment 추가
8. file Viewed
9. Request changes + summary
10. confirmation
11. activity에 submitted review
12. Center row review state refresh

E02 existing pending:

1. server pending review fixture
2. local draft 복구
3. existing threads 표시
4. reply/edit/delete
5. Comment submit

E03 head push:

1. composer 입력 중 head OID 변경
2. banner/write lock
3. unchanged/modified/deleted impact
4. local body 보존
5. reload 후 안전 anchor만 재제안
6. submit 최신 OID

E04 management saved queue:

1. owner scope
2. filters/check/review decision 설정
3. preview 17
4. queue 저장
5. column/sort 설정
6. reopen 후 persistence

E05 bulk review request:

1. 12 rows 선택
2. team frontend picker
3. 10 eligible/2 skipped
4. confirm
5. progress 8 success/2 failure
6. failure retry
7. row/count authoritative refresh

E06 permission:

1. read-only PR
2. review/manage action disabled reason
3. permission hydration
4. external permission change
5. mutation rollback/error

E07 rate limit/offline:

1. cached rows
2. rate limit background stop
3. bulk pause/resume
4. offline write disabled
5. reconnect refresh

E08 suggestion:

1. exact local head suggestion
2. preview
3. unsaved buffer apply
4. no auto-save/stage
5. safe undo
6. concurrent edit 후 unsafe undo block

E09 narrow width:

1. 375px Center
2. nav drawer
3. card row selection/bulk actions
4. Workspace navigator→diff→inspector
5. comment/submit 완료

E10 Korean/high contrast:

1. locale 한국어
2. Dark High Contrast
3. long strings
4. keyboard-only management flow
5. tooltip/focus/selection 확인

### 12.10 live GitHub smoke repository

실제 write 검증은 사용자가 승인한 disposable test repository에서만 한다.
production repository에 테스트 review/comment를 남기지 않는다.

준비:

- test PR open/draft 각각 1개
- changed text file, rename, deletion, binary
- GitHub Actions success/failure/pending fixture workflow
- branch rule 적용 가능 시 required check/approval
- test user/team 권한

Smoke:

- queue search
- Viewed mark/unmark
- pending review + line/multi-line comment
- suggestion
- reply/edit/delete
- resolve/unresolve
- Comment/Approve/Request changes(권한 가능한 계정)
- reviewer/assignee/label/milestone add/remove
- draft/ready
- checks/policy

Cleanup:

- test comments/reviews는 API 제약에 맞춰 별도 test PR 폐기로 정리
- label/milestone/reviewer 원상 복구
- test branch/PR 정리는 별도 명시적 사용자 승인 범위 안에서만

### 12.11 visual QA matrix

각 조합 전체 Cartesian product를 만들지 않고 risk 기반 대표 조합을 고정한다.

| Surface | Width | Theme | State |
|---|---:|---|---|
| Center personal | 1440 | Dark+ | dense rows |
| Center management | 1280 | Light+ | selected + bulk |
| Center compact | 375 | Dark+ | nav drawer/card |
| Center | 800 | Dark HC | partial error |
| Workspace Files | 1440 | Dark+ | threads/composer |
| Workspace Files | 1024 | Light+ | truncated diff |
| Workspace compact | 375 | Dark+ | submit flow |
| Workspace | 800 | Light HC | head changed |
| Management drawer | 1280 | Dark+ | partial eligibility |
| Management result | 1280 | Light+ | partial failure |
| Suggestion preview | 1024 | Dark+ | apply/undo |
| Empty/auth/error | 375/1280 | all relevant | state-specific |

각 screenshot에서 확인:

- hierarchy/alignment/spacing
- truncation/overflow
- focus ring
- tooltip
- selected vs hover
- disabled reason
- sticky header/footer
- no layout shift
- diff readability
- long Korean strings
- high contrast borders

스크린샷은 baseline 승인 전까지만 review artifact로 사용한다. Pixel diff를
무조건 gate로 쓰지 않고 deterministic region에만 tolerance를 적용한다.

### 12.12 회귀 명령

각 구현 PR 최소:

```text
npm run check-types
npm run compile
npm test
```

UI PR:

```text
review DOM/component tests
extension integration tests
target E2E scenarios
visual QA matrix의 해당 surface
```

검증 결과 기록 template:

```text
Functional
- [ ] typecheck
- [ ] compile
- [ ] unit/service/protocol
- [ ] integration/E2E scenario IDs

Visual
- [ ] actual Extension Development Host
- [ ] widths
- [ ] themes
- [ ] interactions
- [ ] screenshots reviewed

Accessibility
- [ ] keyboard
- [ ] focus
- [ ] accessible names/tooltips
- [ ] axe
- [ ] high contrast/zoom

Limitations
- ...
```

실제로 수행하지 않은 viewport/theme/browser/interaction을 완료로 체크하거나
완료 보고에 포함하지 않는다.

## 13. Terra High 실행용 작업 명세

### 13.1 실행 규칙

이 절은 구현자가 추가 제품 결정을 하지 않고 순서대로 수행하는 작업 목록이다.

각 작업의 공통 순서:

1. 해당 작업이 수정할 기존 파일과 인접 test를 읽는다.
2. 문서의 domain/protocol/API 계약과 다른 점이 발견되면 임의로 바꾸지 않고
   `docs/pr-review-workspace-plan.ko.md`에 discrepancy를 기록한다.
3. 먼저 실패하는 unit/contract test를 추가한다.
4. domain/service를 구현한다.
5. panel/message routing을 구현한다.
6. UI component/state를 구현한다.
7. l10n/tooltip/ARIA/log를 같은 작업에서 완성한다.
8. typecheck/compile/target test.
9. user-visible change면 실제 Extension Development Host visual/interaction QA.
10. 파일 600라인 초과 전에 책임별 분리한다.

각 함수에는 프로젝트 지침에 따라 다음을 포함한 한글 설명 주석을 작성한다.

- 무엇을 하는지
- 왜 이 경계/검증이 필요한지
- 매개변수 의미
- 반환값 의미
- mutation이면 안전/동시성 전제

### 13.2 의존성

```text
R00 계약/fixture
  └─ R01 shared UI + request coordinator
       └─ R02 sidebar Reviews shell
            ├─ R03 Review Center read + management queues
            │    └─ R05 management writes
            └─ R04 Review Workspace read
                 ├─ R05 draft/comment writes
                 ├─ R06 submit/thread/Viewed/head-change
                 └─ R07 suggestion/local bridge

R03 + R04 + R05 + R06 + R07
  └─ R12 hardening
       └─ R13 legacy preview retirement
            └─ R14 release visual QA
```

R03과 R04는 R01/R02 뒤 병렬 구현 가능하다. R05에서는 관리 mutation과 개인
review draft를 같은 변경 PR 안에서 각각 독립 commit으로 구현한다.

### 13.3 R00 — 계약과 fixture

#### R00.01 계획 문서 고정

파일:

- `PRODUCT.md`
- `DESIGN.md`
- `.impeccable/design.json`
- `docs/ui-overhaul-plan.ko.md`
- `docs/pr-review-workspace-plan.ko.md`

작업:

- 관리 UI가 동급 1차 범위라는 문장이 모든 문서에서 일치하는지 검색.
- GitHub-only/no external backend/full review 범위 일치 확인.
- canonical 새 파일명이 문서 내에서 하나로 통일됐는지 검사.
- deprecated `position` 기반 새 comment 계획이 없는지 검사.
- 구현 비범위가 모든 계획에서 모순 없는지 확인.

완료:

- 문서 링크/heading 유효.
- 관리 UI를 개인 UI 완료 뒤로 배치하거나 2차 범위로 분류하는 긍정문이 없음.
  “후순위가 아니다” 같은 결정문은 허용하고 검색 결과를 사람이 문맥 검토한다.

#### R00.02 fixture schema

파일:

- `test/fixtures/githubReview/README.md`
- `test/helpers/fakeGhRunner.ts`
- 12.2의 fixture

작업:

- `FakeGhResponse {status, headers, stdout, stderr}` schema.
- GraphQL/REST/gh search fixture loader.
- API request matcher는 method/route/operationName/variables를 비교.
- unmatched call은 즉시 test failure.
- fixture에 synthetic marker와 API version 기록.

완료:

- network/실제 gh 없이 fixture load test 통과.

#### R00.03 test runner

파일:

- `package.json`
- `scripts/run-node-tests.mjs`
- `playwright.config.ts`

작업:

- 12.1.1의 unit auto-discovery runner.
- Playwright webview/a11y/visual project.
- Extension Development Host test entry.
- CI와 local에서 동일 script.
- 기존 unit test 전체가 새 runner에서도 통과하는지 확인.

완료:

- 새 unit test 파일을 `package.json`에 수동 추가하지 않아도 발견.
- `npm test` 기존 suite 회귀 없음.
- UI dependency는 devDependency만.

### 13.4 R01 — shared UI와 request 기반

#### R01.01 semantic token

파일:

- `media/shared/tokens.css`
- `media/shared/layout.css`
- `media/shared/feedback.css`

작업:

- `DESIGN.md` YAML token을 `--gsc-*` alias로 매핑.
- 값은 VS Code var를 참조하고 theme hex를 hard-code하지 않음.
- spacing 2/4/6/8/12/16/24, control 28, row 26/36.
- forced-colors/reduced-motion rules.
- 기존 `instantTooltip`과 중복 tooltip system을 만들지 않음.

Test/QA:

- primitive fixture Dark/Light/HC.
- CSS var 존재 및 hard-coded theme color lint/search.

#### R01.02 primitive

파일:

- `media/shared/controls.js`
- `media/shared/navigation.js`
- `media/shared/feedback.js`
- `media/shared/dialog.js`
- `media/shared/virtualList.js`
- 각 CSS counterpart

구현 순서:

1. text/icon/toggle button helper
2. tooltip wrapper + disabled reason
3. badge/status
4. skeleton/empty/error/banner
5. tabs
6. menu/listbox
7. drawer/dialog focus management
8. splitter
9. virtual list

API는 DOM node와 explicit props를 받고 global state를 읽지 않는다.
innerHTML string을 반환하는 helper와 live DOM helper를 섞지 않는다. 기존
webview가 string builder 중심이면 safe escape helper를 경계에 둔다.

완료:

- keyboard/ARIA component test.
- 모든 icon action title/aria-label.
- 320px/200% zoom.

#### R01.03 protocol common

파일:

- `src/webview/reviewProtocol.ts`
- `src/webview/reviewRequestCoordinator.ts`
- `src/webview/reviewMessageValidation.ts`
- `src/webview/reviewStateMigration.ts`
- target tests

작업:

- 6.1/6.2 envelope/error 구현.
- stable stringify/dedupe key.
- resource revision.
- AbortController lifecycle.
- mutation requestId result cache.
- panel dispose/reopen operation registry.
- validation failure log/redaction.

완료:

- 12.5 protocol test 전체 통과.
- read cancel/mutation continuation 실제 child process fake 검증.

#### R01.04 gh runner

파일:

- 기존 `src/git/ghCli.ts`
- 새 `src/git/ghRunner.ts`
- 새 `src/git/pullRequestReviewServiceRegistry.ts`

작업:

- 기존 `runGh`를 감싸는 injectable `GhRunner`.
- args array, cwd, signal, max buffer, safe operation name 지원.
- host와 API version header는 service가 allowlisted gh args로 조립.
- stdout JSON generic helper.
- exit/status/stderr → typed error.
- 기존 call site를 불필요하게 전면 migration하지 않음.
- review service만 새 interface를 사용.
- 기존 `src/git/serviceRegistry.ts`의 local GitService 책임은 변경하지 않음.

완료:

- 기존 gh 기능 회귀 없음.
- abort/redaction/malformed JSON test.

### 13.5 R02 — Sidebar Reviews shell

#### R02.01 mode navigation

파일:

- 기존 `src/webview/changesViewProvider.ts`
- 기존 `src/webview/changesViewState.ts`
- 기존 `src/webview/changesHtml.ts`
- 기존 `media/changes/changes.js`
- `media/changes/changes.css`
- 필요하면 `media/changes/changesShell.js`

작업:

- existing view ID 유지.
- Changes/Reviews top-level segmented navigation.
- mode state v1 migration.
- Reviews mode용 auth/loading/error/queue summary shell.
- Changes DOM을 reviews 안에 중복 render하지 않음.
- current repository와 Review scope를 별도 상태로 표시.

완료:

- Changes 기능/상태 그대로.
- Reviews shell 실제 auth/viewer/queue summary service 사용.
- 280/360/480px actual view QA.

#### R02.02 Review command contributions

파일:

- `package.json`
- `package.nls.json`
- `package.nls.ko.json`
- `src/commands/index.ts`
- 새 `src/commands/pullRequestReview.ts`

Command ID:

```text
gitSimpleCompare.openReviewCenter
gitSimpleCompare.openPullRequestReview
gitSimpleCompare.refreshReviewQueue
gitSimpleCompare.showReviewOutput
```

작업:

- title/tooltip을 `%key%`로 등록.
- PR URL, owner/repo/number, graph PR item에서 canonical key normalize.
- invalid/unsupported host error.
- `openPullRequestReview`는 singleton panel 정책을 명시:
  같은 PR은 reveal, 다른 PR은 새 panel을 허용하되 최대 3개; 초과 시 LRU
  inactive panel 재사용 전 confirmation 없이 기존 panel을 replace하지 말고
  quick pick로 선택.

완료:

- command palette/side bar/graph bridge에서 동일 command.
- 영어/한국어 contribution.

### 13.6 R03 — Review Center read + 관리 queue

#### R03.01 domain model

파일:

- `src/git/pullRequestReviewModel.ts`
- `src/git/pullRequestManagementModel.ts`
- `test/pullRequestReviewModel.test.ts`

작업:

- 3절과 9.2의 타입/normalizer.
- GraphQL nullable/unknown enum을 UI model로 안전 변환.
- canonical `PullRequestKey` serialize/parse.
- `ReviewDecision`, `MergeState`, `CheckSummary` unknown 보존.
- actor/team/label/milestone identity.

완료:

- 모든 enum unknown fixture.
- model은 vscode/DOM 비의존.

#### R03.02 query compiler

파일:

- `src/git/pullRequestReviewQueryCompiler.ts`
- `test/pullRequestReviewQueryCompiler.test.ts`

작업:

- 9.6 compile 계약.
- GitHub search qualifier allowlist.
- user text escaping.
- multi-repo query 분할/merge plan.
- client predicate와 hydration fields.
- scan cap/exactness metadata.

완료:

- 12.3 compiler cases.
- raw shell command 생성 없음.

#### R03.03 queue service

파일:

- `src/git/pullRequestReviewQueueService.ts`
- `src/git/pullRequestReviewCache.ts`
- `test/pullRequestReviewQueueService.test.ts`

작업:

- viewer/host.
- built-in queue descriptors.
- `gh search prs --json` page.
- owner/repository/multi-repository scope.
- key dedupe/stable sort.
- client filter fill-to-page up to 5 pages/500.
- saved queue load/save는 service가 아니라 storage adapter와 분리.
- TTL/SWR/rate limit metadata.

완료:

- page/cursor/cap/partial/rate-limit.
- background count priority.

#### R03.04 hydration

파일:

- `src/git/pullRequestReviewQueryService.ts`
- `src/git/pullRequestReviewPolicyService.ts`
- tests

작업:

- PR shell batch/query.
- review decision/requested reviewers/teams.
- checks general/required.
- rules-for-branch.
- field별 partial error.
- visible keys batch 20, concurrency 3.

완료:

- hydration 하나 실패해도 다른 patch success.
- required unavailable을 일반 checks로 추정하지 않음.

#### R03.05 saved queue storage

파일:

- `src/webview/reviewQueueStorage.ts`
- `src/webview/reviewStateMigration.ts`
- tests

작업:

- global/workspace state key.
- max 50, schema v1, UUID.
- scope recent 5.
- column/sort/queue selection.
- migration/future version fallback.

완료:

- reload round trip.
- local draft와 저장 영역 분리.

#### R03.06 Review Center panel

파일:

- `src/webview/reviewQueuePanel.ts`
- `src/webview/reviewQueueProtocol.ts`
- `src/webview/reviewQueueMessages.ts`
- `src/webview/reviewQueueHtml.ts`
- routing tests

작업:

- CSP/nonce/resources.
- 6.3/6.4 union과 handlers.
- initialize/load/refresh/hydrate/cancel.
- open workspace.
- saved queue CRUD.
- scope picker data.
- bulk protocol은 preview placeholder가 아니라 read-only eligibility API까지
  연결하되 write는 R05에서 활성화.
- message handler switch exhaustive.

완료:

- dispose/cancel/restore.
- invalid message 무시 + log.
- 파일별 600라인 이하.

#### R03.07 Center state/render

파일:

- `media/review-queue/reviewQueue.js`
- `media/review-queue/reviewQueueState.js`
- `media/review-queue/reviewQueueRows.js`
- `media/review-queue/reviewQueueFilters.js`
- `media/review-queue/reviewQueueInspector.js`
- `media/review-queue/reviewQueueBulkActions.js`
- `media/review-queue/reviewQueue.css`
- 필요 시 책임별 CSS 분리

순서:

1. reducer/selectors
2. shell/nav/header
3. built-in/saved queue nav
4. table/card rows
5. visible hydration observer
6. filter/saved queue drawer
7. scope picker
8. selection/bulk toolbar read-only preview
9. restore scroll/focus
10. loading/empty/error/partial/responsive states

완료:

- 7.1 invariant unit test.
- 9절 관리 table/saved queue/scope UI.
- 개인/팀 queue 같은 hierarchy.
- 1,000 result stress.

#### R03.08 R03 integration/visual

Functional:

- built-in personal 3개 이상.
- built-in management 3개 이상.
- saved queue create/edit/delete/reorder.
- owner/multi-repo scope.
- hydration/partial/rate limit.
- keyboard selection/filter/sort/column.

Visual:

- 375, 800, 1280, 1440.
- Dark+, Light+, Dark HC.
- English/Korean.
- empty/loading/partial/dense/bulk selection.

R03 exit:

- 관리 UI가 placeholder가 아니라 실제 saved queue/table/eligibility preview까지
  동작한다.
- write button은 R05 전에는 `Available when management mutations are enabled`
  같은 사용자-facing 가짜 disabled UI로 출시하지 않는다. Feature flag가 꺼진
  개발 build에서는 action 자체를 내부 flag로 숨긴다.

### 13.7 R04 — Review Workspace read path

#### R04.01 PR query service

파일:

- `src/git/pullRequestReviewQueryService.ts`
- `src/git/pullRequestReviewLocation.ts`
- `test/pullRequestReviewQueryService.test.ts`
- `test/pullRequestReviewPatch.test.ts`
- `test/pullRequestReviewLocation.test.ts`

작업:

- shell/files/viewed/threads/commits/activity/checks API.
- REST patch + GraphQL Viewed/thread join.
- pagination.
- binary/rename/delete/truncated.
- patch parser/line side/context hash.
- own pending review read.
- permission/capability.

완료:

- 5.4–5.8 read contract.
- fixture variants.

#### R04.02 Workspace panel

파일:

- `src/webview/pullRequestReviewPanel.ts`
- `src/webview/pullRequestReviewProtocol.ts`
- `src/webview/pullRequestReviewMessages.ts`
- `src/webview/pullRequestReviewHtml.ts`
- tests

작업:

- PR singleton/reveal lifecycle.
- initialize/tab/file/context/open-native/open-browser/refresh/cancel.
- revision/head OID.
- persisted layout/tab/file/scroll.
- shared request coordinator.
- shell/tab/file 오류 경계.

완료:

- queue → workspace → queue anchor 보존.
- two PR panels resource isolation.

#### R04.03 Workspace state

파일:

- `media/review-workspace/reviewWorkspaceState.js`
- reducer/selector tests

작업:

- 7.2 state/actions/invariants.
- tab lazy state.
- file/thread indexes.
- layout/persistence.
- local composer state는 render와 분리.

완료:

- every host message → reducer action.
- stale response가 state에 적용되지 않음.

#### R04.04 shell/header/tabs

파일:

- `media/review-workspace/reviewWorkspace.js`
- `reviewHeader.js`
- `reviewTabs.js`
- `reviewWorkspace.css`

작업:

- header title/repo/number/author/state/head-base.
- checks/review/merge badges.
- tabs Overview/Files/Commits/Checks/Activity.
- management summary/Manage entry를 R05 전에도 read-only로 표시.
- skeleton/fatal/head placeholder.
- responsive pane shell.

완료:

- long title/branch/login.
- closed/merged/draft/open.
- tab keyboard/ARIA.

#### R04.05 Files navigator/diff

파일:

- `reviewFiles.js`
- `reviewFileNavigator.js`
- `reviewDiff.js`
- 관련 CSS

작업:

- flat/tree toggle.
- search/filter/viewed status.
- selected/keyboard.
- diff unified/split.
- hunk/context load.
- binary/truncated/renamed/deleted.
- line action buttons는 read-only tooltip까지 준비하되 composer는 R05에서 연결.
- open native diff.

완료:

- 1,000 files/10,000 line.
- 320/800/1440 layout.
- diff line accessible name.

#### R04.06 threads/inspector read

파일:

- `reviewThreads.js`
- `reviewOverview.js`
- `reviewCommits.js`
- `reviewChecks.js`
- `reviewActivity.js`

작업:

- active/resolved/outdated/pending thread render.
- sanitized Markdown.
- Overview description/people/metadata read.
- Commits/checks/activity lazy load.
- partial/error/empty.
- management inspector read state.

완료:

- 500 threads virtualization/lazy Markdown.
- required checks source.
- own/edit action은 permission을 보여주되 R06 전 feature flag에서 숨김.

#### R04.07 native bridge read

파일:

- `src/webview/pullRequestReviewNativeBridge.ts`
- `src/providers/pullRequestCommentController.ts`
- `src/ui/diffPresenter.ts`의 최소 확장
- tests

작업:

- base↔head read-only diff URI/presentation.
- threads → native CommentThread.
- webview file/line에서 native diff.
- native selected resource를 webview에 반영할 event.
- working tree editable diff와 PR review diff의 label/URI 분리.

완료:

- 같은 file/path/line anchor.
- no write action yet.

#### R04.08 R04 integration/visual

Functional:

- queue에서 open.
- all tabs lazy load.
- files/filter/tree/viewed read.
- binary/rename/delete/truncated.
- active/resolved/outdated/pending.
- native diff open.

Visual:

- 375/800/1024/1440.
- Dark/Light/HC.
- 200% zoom/long Korean.
- dense files/threads/error/head placeholder.

R04 exit:

- GitHub PR conversation/files/commits/checks/activity를 read-only로 완전히 탐색.
- management metadata도 동일 Workspace에서 읽을 수 있음.

### 13.8 R05 — 관리 mutation + review draft

R05는 관리와 개인 작업을 같은 release slice로 만드는 핵심이다. 아래 M 작업과
D 작업을 번갈아 merge 가능한 commit으로 구현하되 R05 전체가 통과하기 전
일부만 사용자에게 노출하지 않는다.

#### R05.M01 management model/permission

파일:

- `src/git/pullRequestManagementModel.ts`
- `src/git/pullRequestManagementPermission.ts`
- `test/pullRequestReviewPermission.test.ts`

작업:

- 9.2 management types.
- action별 true/false/unknown permission.
- PR state/capability/author 제약.
- disabled reason key.
- bulk eligibility reason.

완료:

- permission/state/capability truth table.
- UI 문자열은 model에 hard-code하지 않고 reason code.

#### R05.M02 management read sources

파일:

- `src/git/pullRequestManagementService.ts`
- `test/pullRequestManagementService.test.ts`

Read:

- requestable reviewers/users
- teams
- assignees
- labels
- milestones
- branch list/base candidates
- current PR metadata

작업:

- pagination/search.
- repository별 identity.
- cache TTL/invalidation.
- multi-repo intersection/partial availability.
- GHES capability fallback.

완료:

- 9.14–9.17 read states.
- target unavailable/permission unknown.

#### R05.M03 mutation preview

파일:

- `src/git/pullRequestManagementPreviewService.ts`
- `src/git/pullRequestManagementModel.ts`
- tests

작업:

- reviewer/team, assignee, label, milestone, draft/ready preview.
- current snapshot + intended after.
- eligible/skipped reason.
- random preview ID/session registry/TTL 2분.
- confirm revision recheck.
- multi-repo milestone mapping.

완료:

- selection tamper/expiry/value change.
- 0/some/all eligible.

#### R05.M04 mutation execution

파일:

- `src/git/pullRequestManagementService.ts`
- `src/git/pullRequestManagementScheduler.ts`
- tests

작업:

- 5.16 endpoints.
- concurrency 3/per PR 1.
- post-read verification.
- silent ignore → partial failure.
- cancel remaining.
- rate limit pause.
- authoritative result patch.
- redacted progress log.

완료:

- all mutation contract tests.
- panel close continuation/reopen.
- no bulk review submit.

#### R05.M05 Center drawer

파일:

- `media/review-queue/reviewQueueBulkActions.js`
- `media/review-queue/reviewQueueManagementDrawer.js`
- `media/review-queue/reviewQueuePickers.js`
- CSS/tests

작업 순서:

1. bulk toolbar action availability
2. shared target picker
3. add/remove/set mode
4. eligibility preview
5. final confirmation
6. progress
7. partial result/retry/copy summary
8. panel reopen restoration

각 action:

- Request review user/team
- Assign
- Labels
- Milestone
- Mark ready

완료:

- 9.9–9.12 그대로.
- 375px Actions menu.
- keyboard/focus/live progress.

#### R05.M06 Workspace management

파일:

- `media/review-workspace/reviewManagement.js`
- `media/review-workspace/reviewOverview.js`
- shared picker/drawer import
- panel/protocol handlers

작업:

- reviewer/assignee/label/milestone edit.
- chip remove + safe undo.
- title/body edit drawer.
- base branch impact dialog.
- draft/ready confirmation.
- permission/hydration/error.
- Center row broadcast patch.

완료:

- 9.13–9.19 단일 PR flow.
- conflict/revision and post-read.

#### R05.D01 pending draft service

파일:

- `src/git/pullRequestReviewDraftService.ts`
- `test/pullRequestReviewMutationService.test.ts`
- `test/reviewStateMigration.test.ts`

작업:

- local draft storage.
- server pending review query/create/reuse.
- reconcile matrix 7.8.
- expected head OID.
- local body/event debounce snapshot.
- discard pending review endpoint/capability.

완료:

- all local/server combinations.
- body/source/token leak 없음.

#### R05.D02 add thread mutation

파일:

- `src/git/pullRequestReviewMutationService.ts`
- `src/git/pullRequestReviewLocation.ts`
- tests

작업:

- single/multi line AddThreadInput.
- file-level AddThreadInput과 file header action.
- line/side/context/head validation.
- pending review create-then-thread.
- ambiguous response recovery.
- GraphQL error/permission/capability mapping.
- thread authoritative refresh.

완료:

- LEFT/RIGHT/multi-line.
- binary/truncated/deleted file-level.
- head shift exact preview vs unsafe block.

#### R05.D03 composer UI

파일:

- `media/review-workspace/reviewComposer.js`
- `media/review-workspace/reviewDiff.js`
- `media/review-workspace/reviewSubmit.js`
- CSS/component tests

작업:

- line/range selection.
- composer open/focus/cancel.
- body/limit/status.
- Start review/Add comment to pending.
- single immediate comment overflow + confirmation.
- pending count/summary shell.
- local persistence.
- stale anchor.

완료:

- 8.3/8.4/8.11 중 draft 관련.
- input loss 없는 failure.
- all icon controls tooltip.

#### R05.D04 native draft awareness

파일:

- `src/providers/pullRequestCommentController.ts`
- `src/webview/pullRequestReviewNativeBridge.ts`
- tests

작업:

- native thread read refresh after webview add.
- native unsent input conflict indicator.
- `Continue in Review Workspace`.
- 같은 line 중복 composer 방지 안내.

완료:

- webview/native source는 동일 service.
- 자동 merge 없음.

#### R05.09 R05 integration

Management scenario:

1. management queue 12 selection
2. team request 10 eligible/2 skipped
3. 1 failure
4. retry success
5. queue/Workspace count/metadata sync
6. single PR assignee/label/milestone
7. permission loss rollback

Draft scenario:

1. file line single/multi comment
2. server pending create
3. local summary persistence
4. panel close/reopen reconcile
5. head preflight failure
6. immediate comment confirmation

Visual:

- management drawer 375/800/1280.
- composer/draft 375/1024/1440.
- partial permission/failure/loading/Korean/HC.

R05 exit:

- 관리 mutation과 개인 draft/comment가 모두 production feature flag에서 함께
  활성화 가능.
- 한쪽만 완료되었으면 R05 미완료.

### 13.9 R06 — review completion

#### R06.01 thread mutation

파일:

- `src/git/pullRequestReviewMutationService.ts`
- target tests

작업:

- reply pending/submitted thread.
- edit/delete own review comment.
- edit/delete issue timeline comment.
- resolve/unresolve.
- permissions.
- post-read/revision.
- ambiguous reply recovery.

완료:

- 5.11, 5.14, 5.15.
- thread local error isolation.

#### R06.02 Viewed

파일:

- `src/git/pullRequestReviewMutationService.ts`
- `media/review-workspace/reviewFiles.js`
- state/tests

작업:

- mark/unmark GraphQL.
- optimistic/toggle coalescing/rollback.
- viewed count/progress/next unviewed.
- current head validation.
- existing preview local Viewed state와 섞지 않음.

완료:

- server reopen persistence.
- mutation failure.

#### R06.03 submit review

파일:

- `src/git/pullRequestReviewDraftService.ts`
- `src/git/pullRequestReviewMutationService.ts`
- `media/review-workspace/reviewSubmit.js`
- tests

작업:

- COMMENT/APPROVE/REQUEST_CHANGES.
- permission/body/state validation.
- head OID preflight.
- confirmation content.
- duplicate click/requestId.
- submit started/finished.
- success snapshot/thread/activity refresh.
- failed/ambiguous draft retention.

완료:

- browser 없이 full review flow.
- own/draft/closed/merged permission.

#### R06.04 head/base/state coordinator

파일:

- `src/git/pullRequestReviewHeadCoordinator.ts`
- `src/git/pullRequestReviewLocation.ts`
- panel/state/tests

작업:

- focus/preflight/manual detection.
- old/new head file impact.
- anchor unchanged/shifted/modified/deleted/unknown.
- blocking banner.
- keep/reload/review changes.
- base branch/state changes.
- all new write lock until reconcile.

완료:

- E03.
- draft text copy/recovery.
- unsafe auto re-anchor 없음.

#### R06.05 thread UI

파일:

- `media/review-workspace/reviewThreads.js`
- `reviewComposer.js`
- `reviewActivity.js`
- tests

작업:

- reply editor.
- edit/delete dialog.
- resolve/unresolve optimistic.
- pending/resolved/outdated/minimized.
- error/input preservation.
- thread action permissions/tooltips.

완료:

- 8.10/10.7.
- long Markdown/code.

#### R06.06 native Comment API write sync

파일:

- `src/providers/pullRequestCommentController.ts`
- `src/commands/pullRequestReview.ts`
- native bridge/tests

작업:

- reply/edit/delete/resolve command.
- pending draft sync.
- service event bus.
- native → webview patch, webview → native refresh.
- disposed consumer cleanup.

완료:

- both surface state consistency.
- no duplicate API mutation.

#### R06.07 R06 integration/visual

- E01, E02, E03, E06, E07.
- actual Comment/Approve/Request changes in disposable repo when authorized.
- submit dialog event별 screenshot.
- head change 375/1280.
- resolved/outdated/pending thread Dark/Light/HC.

R06 exit:

- conversation, line comments, suggestions 제외 thread operations, Viewed,
  Comment/Approve/Request changes를 VS Code 안에서 완료.
- head 변화에 안전.

### 13.10 R07 — suggestion + local bridge

#### R07.01 suggestion parser/writer

파일:

- `src/git/pullRequestSuggestion.ts`
- `test/pullRequestSuggestion.test.ts`

작업:

- 8.5/8.6.
- replacement/body composition.
- fence validation.
- multiple suggestion parse.
- applicable reason.

완료:

- fixture/Unicode/CRLF/empty delete.

#### R07.02 suggestion composer

파일:

- `media/review-workspace/reviewComposer.js`
- `media/review-workspace/reviewSuggestion.js`
- CSS/tests

작업:

- Add suggestion toggle.
- selected original/replacement.
- mini diff preview.
- validation/fallback general comment.
- draft count suggestion.

완료:

- RIGHT-only/100-line limit.
- keyboard/tooltip.

#### R07.03 local identity/safety

파일:

- `src/git/pullRequestSuggestionApplyService.ts`
- `src/git/githubRepository.ts` 재사용
- `src/utils/pathSafety.ts`가 이미 있으면 재사용, 없으면 domain-aligned 위치
- tests

작업:

- remote identity/branch/workspace trust.
- root/symlink/path.
- conflict/working buffer/document version.
- exact/unique context.
- encoding/line ending/trailing newline/file mode.

완료:

- 8.7/8.8 safety.
- fuzzy auto apply 없음.

#### R07.04 preview/apply/undo

파일:

- apply service
- panel/protocol
- `media/review-workspace/reviewSuggestion.js`
- tests

작업:

- preview ID/TTL/hash.
- before/after diff.
- WorkspaceEdit.
- no auto-save/stage/commit/push.
- undo token/hash.
- open native diff.
- failure reason.

완료:

- E08.
- dirty/concurrent edit.

#### R07.05 R07 integration/visual

- write suggestion pending review.
- read multiple suggestions.
- apply exact/relocated.
- unavailable states.
- safe/unsafe undo.
- 375/1024/Dark/Light/HC.

R07 exit:

- suggestion 작성과 안전한 local apply.
- 자동 stage/commit/push 없음.

### 13.11 R12 — review hardening

#### R12.01 literal/i18n audit

- `rg`로 review media의 user-visible literal inventory.
- English string map/host l10n/Korean parity.
- plural/date/relative time.
- long string fixture.

#### R12.02 accessibility audit

- web-design-guidelines checklist.
- axe serious/critical 0.
- keyboard-only E01/E05.
- screen reader spot check.
- 200% zoom.
- all icon/button-like tooltip scan.
- Dark/Light HC.

#### R12.03 performance

- Center 1,000/Workspace file 1,000/diff 10k/thread 500.
- virtualization focus pin.
- request cancel/hydration batch.
- dispose leak/heap snapshot.
- performance budget report.

#### R12.04 error/resilience

- auth loss/offline/rate limits.
- partial GraphQL.
- panel dispose/reopen.
- head/base changes.
- ambiguous mutation.
- bulk partial/cancel.
- state future migration.

R12 exit:

- 11절/12절 모든 gate에 evidence.

### 13.12 R13 — legacy PR Preview migration

선행 gate:

- R03–R07 functional parity.
- existing PR creation preview가 review workspace와 분리됨.
- legacy local Viewed 사용처 inventory.

작업:

1. 기존 compare/open PR command intent 분류.
2. existing PR이면 Review Workspace.
3. staged changes로 새 PR 생성 전이면 creation preview.
4. legacy persisted Viewed를 server state로 자동 write하지 않는다.
5. Preview local Viewed는 server state로 자동 write하거나 migration하지 않고 Preview 범위에서 유지한다.
6. staged Preview의 Conversation/files/commits renderer는 local model로 유지하며 existing PR live review renderer만 제거한다.
7. shared Markdown/diff helper만 남김.
8. dead CSS/protocol/message 제거.
9. command/l10n/docs 갱신.

완료:

- current feature regression suite.
- dead import/unused file.
- typecheck/compile/test.
- creation preview와 review workspace 오진입 없음.

### 13.13 R14 — release visual QA

작업:

1. fresh profile/English/Dark+.
2. Korean/Light+.
3. Dark/Light HC.
4. 375/800/1024/1280/1440 container.
5. actual personal flow E01.
6. actual management flow E04/E05.
7. head change E03.
8. suggestion E08.
9. auth/empty/error/partial/rate limit.
10. 발견 defect만 수정하고 새 feature 추가 금지.
11. screenshot matrix와 defect log.
12. Output log에 민감 정보 없음 확인.

Release gate:

- 개인과 관리 flow 모두 blocker 0.
- a11y serious/critical 0.
- visual P0/P1 0.
- typecheck/compile/test 통과.
- remaining limitation을 release notes에 명시.

### 13.14 각 작업 완료 보고 형식

```text
Task: R05.M05

Changed
- exact files
- behavior

Contracts
- protocol/API/model revision 없음 또는 변경 내용

Functional evidence
- commands and test names

Visual evidence
- actual host, width, theme, interactions

Accessibility evidence
- keyboard/focus/tooltip/axe

Risks/limitations
- only observed facts
```

`Terra High`는 visual evidence가 없으면 “UI 완료”로 보고하지 않는다. Browser나
Extension Development Host를 실행할 수 없으면 functional implementation까지
진행하고 visual QA는 명시적으로 미완료로 남긴다.

## 14. 최종 인수 기준

### 14.1 범위/정보 구조

- [ ] `AC-IA-01` Sidebar에서 Changes와 Reviews가 동급 1차 navigation이다.
- [ ] `AC-IA-02` Review Center에서 Personal과 Team & organization queue가 동급
  section이다.
- [ ] `AC-IA-03` management mutation은 Review Center와 Workspace 양쪽에서
  접근 가능하다.
- [ ] `AC-IA-04` existing PR review와 new PR creation preview가 다른 surface다.
- [ ] `AC-IA-05` Graph/Changes/native diff에서 같은 PR Review Workspace로
  이동한다.
- [ ] `AC-IA-06` GitHub.com/GHES host identity를 섞지 않는다.
- [ ] `AC-IA-07` 외부 backend 없이 gh/local VS Code state만 사용한다.

### 14.2 Review Center 개인 flow

- [ ] `AC-C-01` 사용자는 review requested/authored/mentioned queue를 볼 수 있다.
- [ ] `AC-C-02` queue row에서 repo/number/title/state/review/check/age를
  구분할 수 있다.
- [ ] `AC-C-03` partial hydration이 row/table 전체를 막지 않는다.
- [ ] `AC-C-04` filter/sort/column/scroll/focus가 refresh/reopen 후 정책대로
  복구된다.
- [ ] `AC-C-05` keyboard만으로 queue를 고르고 PR을 연다.
- [ ] `AC-C-06` empty/loading/error/offline/rate-limit 상태에 원인과 recovery가
  있다.
- [ ] `AC-C-07` multi-page 결과에서 duplicate row가 없다.
- [ ] `AC-C-08` 정확하지 않은 count는 정확한 숫자인 것처럼 표시하지 않는다.

### 14.3 Review Center 관리 flow

- [ ] `AC-M-01` repository/owner/multi-repository scope를 선택한다.
- [ ] `AC-M-02` visual filter로 saved queue를 preview/save/edit/delete/reorder한다.
- [ ] `AC-M-03` checks/review decision client filter의 scan cap을 표시한다.
- [ ] `AC-M-04` management table의 essential/optional column이 반응형으로
  동작한다.
- [ ] `AC-M-05` mouse와 keyboard로 단일/range/loaded-all selection을 한다.
- [ ] `AC-M-06` 전체 query가 아닌 loaded rows 선택임을 명확히 표시한다.
- [ ] `AC-M-07` reviewer user/team, assignee, label, milestone mutation을 preview한다.
- [ ] `AC-M-08` 일부 repository에만 가능한 target의 eligible/skipped 수와 이유를
  확인한다.
- [ ] `AC-M-09` final confirmation 전 API write가 발생하지 않는다.
- [ ] `AC-M-10` bulk progress/partial failure/skipped/cancel remaining/retry를
  처리한다.
- [ ] `AC-M-11` panel을 닫아도 시작한 bulk operation이 추적되고 다시 볼 수 있다.
- [ ] `AC-M-12` mutation success를 서버 post-read로 검증한다.
- [ ] `AC-M-13` silent ignore/mismatch를 success로 표시하지 않는다.
- [ ] `AC-M-14` 관리 action permission unknown/false/changed를 구분한다.
- [ ] `AC-M-15` required checks/policy를 추정하지 않고 source/unavailable을
  표시한다.
- [ ] `AC-M-16` bulk approve/request-changes/comment/merge는 제공하지 않는다.

### 14.4 Workspace read

- [ ] `AC-WR-01` header에 PR identity/state/head-base/review/check summary가 있다.
- [ ] `AC-WR-02` Overview/Files/Commits/Checks/Activity tab이 lazy load된다.
- [ ] `AC-WR-03` file navigator가 1,000 files에서도 keyboard/scroll 가능하다.
- [ ] `AC-WR-04` unified/split diff와 hunk context load가 동작한다.
- [ ] `AC-WR-05` binary/rename/delete/truncated/huge diff state를 처리한다.
- [ ] `AC-WR-06` active/resolved/outdated/pending/minimized thread를 구분한다.
- [ ] `AC-WR-07` Markdown이 sanitize되고 long text/code가 shell을 깨지 않는다.
- [ ] `AC-WR-08` native base↔head diff를 같은 path/line에서 연다.
- [ ] `AC-WR-09` working tree editable diff와 PR read-only diff가 명확히
  구분된다.

### 14.5 Review comment/draft

- [ ] `AC-D-01` LEFT/RIGHT single-line comment가 정확한 line에 생성된다.
- [ ] `AC-D-02` 같은 side의 multi-line comment가 정확한 start/end에 생성된다.
- [ ] `AC-D-03` binary/truncated/deleted file에도 file-level comment를 정확히
  생성한다.
- [ ] `AC-D-04` mixed-side/hunk-cross selection을 안전하게 막는다.
- [ ] `AC-D-05` first comment에서 pending review를 만들고 이후 재사용한다.
- [ ] `AC-D-06` local/server pending review가 reopen/activate 시 reconcile된다.
- [ ] `AC-D-07` comment 실패 시 body/anchor가 보존된다.
- [ ] `AC-D-08` immediate single comment와 pending review comment의 차이가
  확인된다.
- [ ] `AC-D-09` reply/edit/delete own comment가 권한에 맞게 동작한다.
- [ ] `AC-D-10` resolve/unresolve failure가 optimistic state를 rollback한다.
- [ ] `AC-D-11` native/webview mutation이 서로 refresh된다.

### 14.6 Viewed/submit/head change

- [ ] `AC-S-01` Viewed가 GitHub server state를 mark/unmark한다.
- [ ] `AC-S-02` Viewed 연속 toggle이 마지막 사용자 의도와 일치한다.
- [ ] `AC-S-03` Comment review를 pending comments/body 규칙대로 submit한다.
- [ ] `AC-S-04` Approve의 own/draft/permission 제약을 정확히 표시한다.
- [ ] `AC-S-05` Request changes summary body를 필수 검증한다.
- [ ] `AC-S-06` submit confirmation에 event/count/PR/head를 보여준다.
- [ ] `AC-S-07` duplicate submit이 발생하지 않는다.
- [ ] `AC-S-08` submit 실패/응답 유실 시 draft를 잃지 않는다.
- [ ] `AC-S-09` 새 head 감지 즉시 write가 잠긴다.
- [ ] `AC-S-10` head change가 anchor를 unchanged/shifted/modified/deleted/unknown으로
  분류한다.
- [ ] `AC-S-11` unsafe anchor를 자동으로 재배치하지 않는다.
- [ ] `AC-S-12` 사용자가 draft를 보존하고 최신 head로 reload할 수 있다.

### 14.7 suggestion/local safety

- [ ] `AC-G-01` valid RIGHT-side range를 suggestion comment로 만든다.
- [ ] `AC-G-02` deletion/invalid fence/100+ line validation이 동작한다.
- [ ] `AC-G-03` 다른 사용자의 single/multiple suggestion을 파싱한다.
- [ ] `AC-G-04` repository/branch/workspace trust/path/symlink/conflict를 preflight한다.
- [ ] `AC-G-05` exact 또는 유일 context만 apply preview한다.
- [ ] `AC-G-06` apply 직전 working buffer hash를 재검증한다.
- [ ] `AC-G-07` WorkspaceEdit을 사용해 editor undo stack을 보존한다.
- [ ] `AC-G-08` 자동 save/stage/commit/push를 하지 않는다.
- [ ] `AC-G-09` apply 후 변경이 없을 때 safe undo한다.
- [ ] `AC-G-10` apply 후 사용자 편집이 있으면 inverse overwrite를 막는다.
- [ ] `AC-G-11` local apply가 GitHub thread resolved/Viewed를 자동 변경하지 않는다.

### 14.8 단일 PR 관리

- [ ] `AC-PM-01` reviewer/team request add/remove.
- [ ] `AC-PM-02` assignee add/remove.
- [ ] `AC-PM-03` label add/remove와 arbitrary color contrast.
- [ ] `AC-PM-04` milestone set/clear.
- [ ] `AC-PM-05` title/body edit와 revision conflict.
- [ ] `AC-PM-06` base branch impact confirmation.
- [ ] `AC-PM-07` draft/ready conversion confirmation.
- [ ] `AC-PM-08` mutation이 열린 Center row/queue predicate와 일치한다.

### 14.9 접근성/시각

- [ ] `AC-A11Y-01` icon/button-like control에 hover/focus tooltip과 accessible name.
- [ ] `AC-A11Y-02` 모든 flow가 keyboard만으로 완료 가능.
- [ ] `AC-A11Y-03` focus가 refresh/virtualization/drawer 후 논리적으로 복구.
- [ ] `AC-A11Y-04` selected/hover/focus/disabled를 색만으로 구분하지 않음.
- [ ] `AC-A11Y-05` Dark/Light/각 High Contrast에서 내용/경계가 식별됨.
- [ ] `AC-A11Y-06` 200% zoom/320px에서 primary flow 가능.
- [ ] `AC-A11Y-07` axe serious/critical 0.
- [ ] `AC-A11Y-08` live region이 progress/error를 과도하게 반복하지 않음.
- [ ] `AC-V-01` 10.9 responsive layout대로 pane/table이 전환됨.
- [ ] `AC-V-02` long English/Korean/repo/branch/title/comment가 overflow를 깨지 않음.
- [ ] `AC-V-03` loading/empty/error/success/disabled/focus/hover/selected 상태가 실제로
  render됨.
- [ ] `AC-V-04` sticky header/footer와 drawer가 narrow/zoom에서 action을 가리지
  않음.
- [ ] `AC-V-05` actual Extension Development Host visual QA evidence가 있음.

### 14.10 성능/안전/관찰성

- [ ] `AC-Q-01` 11.7 performance budget을 측정하고 blocker regression 없음.
- [ ] `AC-Q-02` queue/file/diff/thread virtualization이 focus를 잃지 않음.
- [ ] `AC-Q-03` hidden/disposed panel request가 취소되고 mutation은 추적됨.
- [ ] `AC-Q-04` rate limit에서 background work가 중지됨.
- [ ] `AC-Q-05` offline/auth lost에서 cached read/write-disabled 정책.
- [ ] `AC-Q-06` gh arguments에 shell injection 경로 없음.
- [ ] `AC-Q-07` Markdown/XSS/CSP/path traversal/symlink test 통과.
- [ ] `AC-Q-08` token/body/source/private URL이 OUTPUT/persisted state에 없음.
- [ ] `AC-Q-09` 중요한 load/refresh/skip/error/mutation/head transition이 OUTPUT에
  기록됨.
- [ ] `AC-Q-10` UI error correlation ID가 OUTPUT과 연결됨.

### 14.11 아키텍처/회귀

- [ ] `AC-ARCH-01` 새/수정 소스 파일 300–600라인 목표, 600 초과 파일 분리.
- [ ] `AC-ARCH-02` git access는 `src/git/`, UI lifecycle은 `src/webview/`,
  native UI는 `src/providers|ui/`, 조립은 `src/commands/`.
- [ ] `AC-ARCH-03` webview에 GitHub business logic/gh args가 없음.
- [ ] `AC-ARCH-04` service/reducer/parser는 독립 test 가능.
- [ ] `AC-ARCH-05` 모든 함수에 지침에 맞는 한글 설명 주석.
- [ ] `AC-ARCH-06` protocol switch/type guard exhaustive.
- [ ] `AC-ARCH-07` 영어/한국어 key parity.
- [ ] `AC-ARCH-08` 기존 branch/file/current file compare와 editable working diff
  회귀 없음.
- [ ] `AC-ARCH-09` Graph/rebase/conflict/split/commit plan 기존 flow 회귀 없음.
- [ ] `AC-ARCH-10` compile/typecheck/test 통과.

### 14.12 출시 차단 기준

다음 하나라도 있으면 출시를 차단한다.

- comment/review/management mutation이 다른 PR/line/repository에 적용될 가능성
- head 변경 후 stale anchor로 write
- bulk preview와 실제 대상 불일치
- response 유실로 duplicate review/comment
- suggestion이 사용자 변경을 덮음
- permission false인데 write action 실행
- token/body/source log/persistence 노출
- keyboard로 submit/management completion 불가능
- tooltip/accessible name 없는 새 button-like control
- 개인 flow는 완료됐지만 관리 flow가 placeholder
- 관리 flow는 완료됐지만 full 개인 review submit이 불가능
- 기존 핵심 compare/edit 기능 회귀

## 15. 공식 API 참고

구현 시작 시 다음 공식 문서의 현재 schema/preview status를 다시 확인한다. 이
계획은 2026-07-26에 확인한 계약을 기준으로 한다.

### 15.1 GitHub Pull Request review

- [REST API endpoints for pull request reviews](https://docs.github.com/en/rest/pulls/reviews)
  - pending review 생성, review 조회/제출/삭제
  - `COMMENT`, `APPROVE`, `REQUEST_CHANGES`
- [REST API endpoints for review comments](https://docs.github.com/en/rest/pulls/comments)
  - line comment/reply/edit/delete
  - 새 구현은 deprecated `position` 대신 `line`, `side`, `start_line`,
    `start_side`
- [GraphQL PullRequest review objects and mutations](https://docs.github.com/en/graphql/reference/pulls)
  - `reviewThreads`, `viewerViewedState`
  - `addPullRequestReview`
  - `addPullRequestReviewThread`
  - `addPullRequestReviewThreadReply`
  - `submitPullRequestReview`
  - `markFileAsViewed`, `unmarkFileAsViewed`
  - `resolveReviewThread`, `unresolveReviewThread`
  - review comment update/delete

### 15.2 Queue/check/policy

- [`gh search prs` manual](https://cli.github.com/manual/gh_search_prs)
  - qualifiers, sort/order, JSON fields, pagination
- [`gh pr checks` manual](https://cli.github.com/manual/gh_pr_checks)
  - checks JSON과 `--required`
- [REST repository rules endpoints](https://docs.github.com/en/rest/repos/rules)
  - base branch에 적용되는 rules 조회

### 15.3 관리 mutation

- [REST requested reviewers endpoints](https://docs.github.com/en/rest/pulls/review-requests)
  - user/team review request add/remove
- [REST issue assignees endpoints](https://docs.github.com/en/rest/issues/assignees)
  - assignee add/remove
- [REST issue labels endpoints](https://docs.github.com/en/rest/issues/labels)
  - label list/add/remove
- [REST issue endpoints](https://docs.github.com/en/rest/issues/issues)
  - milestone/issue metadata
- [REST pull request endpoints](https://docs.github.com/en/rest/pulls/pulls)
  - PR title/body/base/state

### 15.4 구현 확인 규칙

- REST는 `X-GitHub-Api-Version: 2022-11-28` 또는 구현 시 공식 권장 version.
- fine-grained/classic token permission 차이는 endpoint 문서 기준.
- GHES에서는 server version/schema capability probe.
- preview/unstable field는 capability false/unknown UI.
- 문서에 없는 response field에 business decision을 의존하지 않는다.
- mutation은 endpoint success status에 더해 authoritative read로 검증한다.
- API/gh behavior가 계획과 다르면 service adapter에서 흡수하고 protocol/domain
  계약 변경은 별도 문서 update와 test를 동반한다.
