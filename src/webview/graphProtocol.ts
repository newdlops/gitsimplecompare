// 그래프 웹뷰와 확장 사이에 오가는 메시지 타입 정의.
// - 확장(Node)과 웹뷰(브라우저 컨텍스트)가 동일한 타입을 공유해 프로토콜 불일치를 막는다.
// - 새 그래프 상호작용을 추가할 때 이 합집합 타입에 한 줄만 더하면 된다(확장성).
import {
  CommitDetail,
  GraphData,
  LocalBranchStatus,
  WorktreeBranchStatus,
} from "../graph/graphTypes";
import type {
  RebaseItem,
  RebasePausedState,
  RebasePlanInfo,
} from "../git/rebaseService";
import type {
  GraphBranchFilterMode,
  GraphBranchFilterSnapshot,
} from "./graphBranchFilter";
import type {
  AiRebasePlanRequest,
  AiRebasePlanResult,
} from "../ai/rebasePlanner";
import type { PullRequestDetailInfo, PullRequestOverview } from "../git/pullRequestService";
import type { PullRequestSearchResult } from "../git/pullRequestSearchService";
import type {
  GraphRepositorySearchResult,
  GraphRepositorySearchScope,
} from "../git/graphSearchService";
import type { GitTagStatus } from "../git/gitTagService";
import type { ReflogEntry } from "../git/reflogService";

/** graph 검색에서 명시적으로 최신화할 ref 종류 */
export type GraphSearchFetchTarget = "refs" | "tags";

/** graph 무한 스크롤에서 추가 로드할 방향 */
export type GraphLoadDirection = "newer" | "older";

/** 그래프 페이지 로딩 상태(웹뷰의 무한 스크롤/상태 표시용) */
export interface GraphLoadState {
  loadedCount: number;
  hasMore: boolean;
  hasMoreBefore?: boolean;
  loading: boolean;
  loadDirection?: GraphLoadDirection;
  reset: boolean;
}

/** 그래프 rebase 진행 상태 배너의 단계 */
export type GraphRebaseProgressPhase =
  | "running"
  | "paused"
  | "conflicts"
  | "failed"
  | "completed"
  | "aborted"
  | "cancelled"
  | "noop";

/** 그래프 rebase 진행 상태 배너에 표시할 todo 카드 정보 */
export interface GraphRebaseTodoCard {
  role: "done" | "current" | "remaining";
  index: number;
  action: string;
  hash?: string;
  subject?: string;
}

/** 그래프 rebase 진행 상태 배너와 row 강조에 필요한 정보 */
export interface GraphRebaseProgress {
  phase: GraphRebaseProgressPhase;
  action: "run" | "continue" | "skip" | "abort";
  title: string;
  detail?: string;
  hash?: string;
  originalHash?: string;
  step?: number;
  total?: number;
  todos?: GraphRebaseTodoCard[];
  omittedTodoCount?: number;
  guidance?: string[];
  active: boolean;
}

/** 확장 → 웹뷰 메시지 */
export type ToWebviewMessage =
  | { type: "graph"; data: GraphData; state: GraphLoadState }
  | { type: "graphLoadState"; state: GraphLoadState }
  | { type: "branchStatus"; branches: LocalBranchStatus[]; worktrees?: WorktreeBranchStatus[] }
  | { type: "branchFilterOptions"; filter: GraphBranchFilterSnapshot }
  | { type: "tagStatus"; tags: GitTagStatus[] }
  | { type: "pullRequestOverview"; overview: PullRequestOverview }
  | { type: "pullRequestSearchResult"; requestId: string; result: PullRequestSearchResult }
  | { type: "pullRequestSearchError"; requestId: string; query: string; message: string }
  | { type: "pullRequestDetail"; number: number; detail: PullRequestDetailInfo }
  | { type: "pullRequestDetailError"; number: number; message: string }
  | { type: "graphRepositorySearchResult"; requestId: string; result: GraphRepositorySearchResult }
  | { type: "graphRepositorySearchError"; requestId: string; query: string; message: string }
  | { type: "graphReflog"; entries: ReflogEntry[]; scannedObjects?: boolean }
  | { type: "commitVisibility"; requestId: string; hash?: string; found: boolean }
  | { type: "commitDetail"; detail: CommitDetail }
  | { type: "graphRebasePlan"; plan: RebasePlanInfo }
  | { type: "graphRebaseAiPlan"; result: AiRebasePlanResult }
  | { type: "graphRebaseProgress"; progress: GraphRebaseProgress }
  | { type: "graphRebasePaused"; paused: RebasePausedState }
  | { type: "graphRebaseOperation"; active: boolean }
  | { type: "graphRebaseClear" }
  | { type: "graphBusy"; key: string; busy: boolean }
  | { type: "error"; message: string };

/** 웹뷰 → 확장 메시지 */
export type FromWebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | {
      type: "setBranchFilter";
      mode: GraphBranchFilterMode;
      branches?: string[];
      compact?: boolean;
    }
  | { type: "fetch" }
  | { type: "fetchTags" }
  | { type: "pull" }
  | { type: "push" }
  | { type: "forcePush" }
  | { type: "openRemoteBranch" }
  | { type: "refreshPullRequests" }
  | { type: "refreshReflog"; includeUnreachable?: boolean }
  | { type: "searchPullRequests"; requestId: string; query: string; cursor?: string }
  | { type: "loadMorePullRequests" }
  | { type: "refreshPullRequestDetail"; number: number }
  | { type: "ensureCommitVisible"; requestId: string; hashes: string[] }
  | { type: "showReflogCommit"; requestId: string; hash: string }
  | { type: "ensureHeadVisible"; requestId: string }
  | { type: "graphRepositorySearch"; requestId: string; query: string; scope?: GraphRepositorySearchScope }
  | {
      type: "fetchGraphSearchRefs";
      requestId: string;
      query: string;
      scope?: GraphRepositorySearchScope;
      target?: GraphSearchFetchTarget;
    }
  | { type: "openPullRequest"; number: number }
  | { type: "previewStagedPullRequest"; number?: number }
  | {
      type: "pullRequestAction";
      number: number;
      action?:
        | "squash"
        | "rebase"
        | "squashRevert"
        | "rebaseRevert"
        | "squashWorktree"
        | "rebaseWorktree"
        | "squashRevertWorktree"
        | "rebaseRevertWorktree"
        | "undo";
    }
  | { type: "loadMore"; direction?: GraphLoadDirection }
  | { type: "selectCommit"; hash: string }
  | { type: "checkoutBranch"; branch: string }
  | { type: "checkoutRemoteBranch"; branch: string }
  | { type: "checkoutCommit"; hash: string }
  | { type: "createBranch"; hash: string }
  | { type: "restoreBranchFromReflog"; hash: string }
  | { type: "cloneBranch"; branch: string; checkout: boolean }
  | { type: "renameBranch"; branch: string }
  | { type: "deleteBranch"; branch?: string; kind?: "local" | "remote" }
  | { type: "branchAction"; branch: string; kind: "local" | "remote" }
  | { type: "branchMergeAction"; branch: string; action: "squash" | "rebase" | "undo"; kind?: "local" | "remote" }
  | { type: "commitAction"; hash: string }
  | { type: "undoCommit"; hash: string }
  | { type: "revertCommit"; hash: string; parents?: string[] }
  | { type: "createTag"; hash: string }
  | { type: "checkoutTag"; tag: string; target?: string }
  | { type: "createBranchFromTag"; tag: string; target?: string }
  | { type: "deleteTag"; tag?: string }
  | { type: "deleteRemoteTag"; tag: string; remote?: string }
  | { type: "pushTag"; tag?: string }
  | { type: "copyTagName"; tag: string }
  | { type: "renameTag"; tag: string }
  | { type: "tagAction"; tag: string; target?: string; remote?: string }
  | { type: "cherryPick"; hash: string }
  | { type: "copyCommitHash"; hash: string }
  | { type: "copyCommitMessage"; message: string }
  | { type: "openFileDiff"; hash: string; parent: string; path: string }
  | { type: "openRebaseEditFile"; path: string }
  | { type: "prepareGraphRebase"; hash?: string; onto?: string }
  | { type: "generateGraphRebaseAiPlan"; plan: AiRebasePlanRequest }
  | { type: "configureAiCli" }
  | { type: "continueGraphRebase"; items?: RebaseItem[]; changedHashes?: string[] }
  | { type: "skipGraphRebase"; items?: RebaseItem[] }
  | { type: "abortGraphRebase" }
  | {
      type: "runGraphRebase";
      base: string;
      root?: boolean;
      onto?: string;
      editPath?: string;
      items: RebaseItem[];
    };
