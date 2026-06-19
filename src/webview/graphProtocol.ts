// 그래프 웹뷰와 확장 사이에 오가는 메시지 타입 정의.
// - 확장(Node)과 웹뷰(브라우저 컨텍스트)가 동일한 타입을 공유해 프로토콜 불일치를 막는다.
// - 새 그래프 상호작용을 추가할 때 이 합집합 타입에 한 줄만 더하면 된다(확장성).
import { CommitDetail, GraphData, LocalBranchStatus } from "../graph/graphTypes";
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
import type { GraphRepositorySearchResult } from "../git/graphSearchService";

/** 그래프 페이지 로딩 상태(웹뷰의 무한 스크롤/상태 표시용) */
export interface GraphLoadState {
  loadedCount: number;
  hasMore: boolean;
  loading: boolean;
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
  role: "current" | "remaining";
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
  active: boolean;
}

/** 확장 → 웹뷰 메시지 */
export type ToWebviewMessage =
  | { type: "graph"; data: GraphData; state: GraphLoadState }
  | { type: "graphLoadState"; state: GraphLoadState }
  | { type: "branchStatus"; branches: LocalBranchStatus[] }
  | { type: "branchFilterOptions"; filter: GraphBranchFilterSnapshot }
  | { type: "pullRequestOverview"; overview: PullRequestOverview }
  | { type: "pullRequestSearchResult"; requestId: string; result: PullRequestSearchResult }
  | { type: "pullRequestSearchError"; requestId: string; query: string; message: string }
  | { type: "pullRequestDetail"; number: number; detail: PullRequestDetailInfo }
  | { type: "pullRequestDetailError"; number: number; message: string }
  | { type: "graphRepositorySearchResult"; requestId: string; result: GraphRepositorySearchResult }
  | { type: "graphRepositorySearchError"; requestId: string; query: string; message: string }
  | { type: "commitVisibility"; requestId: string; hash?: string; found: boolean }
  | { type: "commitDetail"; detail: CommitDetail }
  | { type: "graphRebasePlan"; plan: RebasePlanInfo }
  | { type: "graphRebaseAiPlan"; result: AiRebasePlanResult }
  | { type: "graphRebaseProgress"; progress: GraphRebaseProgress }
  | { type: "graphRebasePaused"; paused: RebasePausedState }
  | { type: "graphRebaseOperation"; active: boolean }
  | { type: "graphRebaseClear" }
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
  | { type: "openRemoteBranch" }
  | { type: "refreshPullRequests" }
  | { type: "searchPullRequests"; requestId: string; query: string; cursor?: string }
  | { type: "loadMorePullRequests" }
  | { type: "refreshPullRequestDetail"; number: number }
  | { type: "ensureCommitVisible"; requestId: string; hashes: string[] }
  | { type: "ensureHeadVisible"; requestId: string }
  | { type: "graphRepositorySearch"; requestId: string; query: string }
  | { type: "fetchGraphSearchRefs"; requestId: string; query: string }
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
  | { type: "loadMore" }
  | { type: "selectCommit"; hash: string }
  | { type: "checkoutBranch"; branch: string }
  | { type: "checkoutRemoteBranch"; branch: string }
  | { type: "checkoutCommit"; hash: string }
  | { type: "createBranch"; hash: string }
  | { type: "cloneBranch"; branch: string; checkout: boolean }
  | { type: "renameBranch"; branch: string }
  | { type: "deleteBranch"; branch?: string; kind?: "local" | "remote" }
  | { type: "branchAction"; branch: string; kind: "local" | "remote" }
  | { type: "branchMergeAction"; branch: string; action: "squash" | "rebase" | "undo"; kind?: "local" | "remote" }
  | { type: "commitAction"; hash: string }
  | { type: "undoCommit"; hash: string }
  | { type: "revertCommit"; hash: string; parents?: string[] }
  | { type: "createTag"; hash: string }
  | { type: "deleteTag"; tag?: string }
  | { type: "pushTag"; tag?: string }
  | { type: "tagAction"; tag: string }
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
