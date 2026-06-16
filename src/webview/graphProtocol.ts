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

/** 그래프 페이지 로딩 상태(웹뷰의 무한 스크롤/상태 표시용) */
export interface GraphLoadState {
  loadedCount: number;
  hasMore: boolean;
  loading: boolean;
  reset: boolean;
}

/** 확장 → 웹뷰 메시지 */
export type ToWebviewMessage =
  | { type: "graph"; data: GraphData; state: GraphLoadState }
  | { type: "graphLoadState"; state: GraphLoadState }
  | { type: "branchStatus"; branches: LocalBranchStatus[] }
  | { type: "branchFilterOptions"; filter: GraphBranchFilterSnapshot }
  | { type: "pullRequestOverview"; overview: PullRequestOverview }
  | { type: "pullRequestDetail"; number: number; detail: PullRequestDetailInfo }
  | { type: "pullRequestDetailError"; number: number; message: string }
  | { type: "commitVisibility"; requestId: string; hash?: string; found: boolean }
  | { type: "commitDetail"; detail: CommitDetail }
  | { type: "graphRebasePlan"; plan: RebasePlanInfo }
  | { type: "graphRebaseAiPlan"; result: AiRebasePlanResult }
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
  | { type: "loadMorePullRequests" }
  | { type: "refreshPullRequestDetail"; number: number }
  | { type: "ensureCommitVisible"; requestId: string; hashes: string[] }
  | { type: "ensureHeadVisible"; requestId: string }
  | { type: "openPullRequest"; number: number }
  | { type: "previewStagedPullRequest"; number?: number }
  | { type: "pullRequestAction"; number: number; action?: "squash" | "rebase" | "undo" }
  | { type: "loadMore" }
  | { type: "selectCommit"; hash: string }
  | { type: "checkoutBranch"; branch: string }
  | { type: "checkoutRemoteBranch"; branch: string }
  | { type: "checkoutCommit"; hash: string }
  | { type: "createBranch"; hash: string }
  | { type: "cloneBranch"; branch: string; checkout: boolean }
  | { type: "deleteBranch"; branch?: string; kind?: "local" | "remote" }
  | { type: "branchAction"; branch: string; kind: "local" | "remote" }
  | { type: "branchMergeAction"; branch: string; action: "squash" | "rebase" | "undo"; kind?: "local" | "remote" }
  | { type: "commitAction"; hash: string }
  | { type: "undoCommit"; hash: string }
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
  | { type: "abortGraphRebase" }
  | {
      type: "runGraphRebase";
      base: string;
      root?: boolean;
      onto?: string;
      editPath?: string;
      items: RebaseItem[];
    };
