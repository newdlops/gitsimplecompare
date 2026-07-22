// Changes 웹뷰로 보낼 렌더 payload 를 조립하는 모듈.
// - provider 상태 보관과 payload 변환을 분리해 렌더 최적화/중복 스킵을 쉽게 한다.
import type { BranchComparison } from "../git/gitTypes";
import type { StatusGroups } from "../git/gitService";
import type { CommitFailureReport } from "../git/commitHookFailure";
import type { CommitHooksSnapshot } from "../git/commitHookService";
import {
  SortKey,
  buildNodes,
} from "../providers/changesTreeModel";
import type { RepoInfo } from "../commands/shared";
import type { StashView } from "../commands/stash";
import type { FileIconThemeResolver } from "./fileIconTheme";
import type {
  ComparisonDraft,
  FileHistoryView,
  ViewModes,
  VisibleSections,
  WorktreeView,
} from "./changesViewTypes";

/** ChangesViewProvider 의 현재 렌더 관련 상태 묶음. */
export interface ChangesRenderState {
  repositories: RepoInfo[];
  activeRepo?: string;
  comparison?: BranchComparison;
  comparisonEnabled: boolean;
  gutterSettingEnabled: boolean;
  draft: ComparisonDraft;
  staged: StatusGroups["staged"];
  unstaged: StatusGroups["unstaged"];
  stashes: StashView[];
  worktrees: WorktreeView[];
  fileHistory: FileHistoryView;
  commitMessage: string;
  commitMessageRevision: number;
  aiCommitGenerating: boolean;
  commitHooks?: CommitHooksSnapshot;
  commitFailure?: CommitFailureReport;
  viewModes: ViewModes;
  sortKey: SortKey;
  visibleSections: VisibleSections;
}

/** Changes 웹뷰 JS 가 받는 render 메시지 payload. */
export type ChangesRenderPayload = ReturnType<typeof buildChangesRenderPayload>;
export type WorkingChangesRenderPayload = ReturnType<
  typeof buildWorkingChangesRenderPayload
>;

/**
 * provider 상태를 웹뷰 렌더 payload 로 변환한다.
 * @param state provider 가 보관 중인 비교/변경/stash/UI 상태
 * @param fileIcons 현재 파일 아이콘 테마 해석기
 */
export function buildChangesRenderPayload(
  state: ChangesRenderState,
  fileIcons: FileIconThemeResolver
) {
  return {
    repos: state.repositories.map((r) => ({
      root: r.root,
      name: baseName(r.root),
      branch: r.branch,
      active: r.root === state.activeRepo,
    })),
    compare: {
      mode: state.comparison ? ("comparison" as const) : ("draft" as const),
      from: state.comparison
        ? state.comparison.baseLabel ?? state.comparison.base
        : state.draft.from ?? "",
      to: state.comparison
        ? state.comparison.targetLabel ?? state.comparison.target
        : state.draft.to ?? "",
      viewMode: state.viewModes.compare,
      gutter: state.comparison
        ? comparisonGutterStatus(
            state.comparison,
            state.comparisonEnabled,
            state.gutterSettingEnabled
          )
        : undefined,
      nodes: state.comparison
        ? buildNodes(
            state.comparison.changes,
            state.viewModes.compare,
            state.sortKey
          )
        : [],
    },
    changes: {
      viewMode: state.viewModes.changes,
      staged: buildNodes(state.staged, state.viewModes.changes, state.sortKey),
      unstaged: buildNodes(
        state.unstaged,
        state.viewModes.changes,
        state.sortKey
      ),
    },
    commit: buildCommitPayload(state),
    stashes: state.stashes.map((s) => ({
      ref: s.ref,
      hash: s.hash,
      message: s.message,
      branch: s.branch,
      date: s.relativeDate,
    })),
    worktrees: state.worktrees.map((w) => ({
      ...w,
      activeRepo: w.repoRoot === state.activeRepo,
    })),
    history: {
      repoRoot: state.fileHistory.repoRoot,
      path: state.fileHistory.path,
      commits: state.fileHistory.commits,
      message: state.fileHistory.message,
    },
    visibleSections: { ...state.visibleSections },
    fileIcons: fileIcons.payloadFor(collectFilePaths(state)),
  };
}

/**
 * staged/unstaged 변경만 바뀐 빠른 경로에서 Changes 섹션에 필요한 최소 payload를 만든다.
 * - 비교, History, stash, worktree를 다시 buildNodes/직렬화하지 않고 로컬 DOM만 교체할 수 있게 한다.
 * @param state provider가 보관 중인 현재 상태
 * @param fileIcons 현재 파일 아이콘 테마 해석기
 * @returns Changes 노드, staged 존재 여부, 해당 경로 아이콘만 포함한 delta
 */
export function buildWorkingChangesRenderPayload(
  state: ChangesRenderState,
  fileIcons: FileIconThemeResolver
) {
  const paths = [
    ...state.staged.map((change) => change.path),
    ...state.unstaged.map((change) => change.path),
  ];
  return {
    changes: {
      viewMode: state.viewModes.changes,
      staged: buildNodes(state.staged, state.viewModes.changes, state.sortKey),
      unstaged: buildNodes(
        state.unstaged,
        state.viewModes.changes,
        state.sortKey
      ),
    },
    // Changes 본문에는 커밋 입력창도 포함되므로 사용자가 입력한 최신 메시지와 hook/진행 상태를 함께 보낸다.
    commit: buildCommitPayload(state),
    fileIcons: fileIcons.payloadFor(paths),
  };
}

/**
 * 전체 렌더와 로컬 부분 렌더가 공유할 커밋 박스 payload를 만든다.
 * - 부분 렌더가 Changes 본문을 교체할 때 포커스를 잃은 입력값도 과거 full payload로 되돌아가지 않게 한다.
 * @param state provider가 보관하는 최신 커밋 메시지, hook, staged 상태
 * @returns 웹뷰 커밋 박스가 즉시 복원할 전체 상태
 */
function buildCommitPayload(state: ChangesRenderState) {
  return {
    message: state.commitMessage,
    messageRevision: state.commitMessageRevision,
    repoRoot: state.activeRepo,
    branch: state.repositories.find((repo) => repo.root === state.activeRepo)
      ?.branch,
    hasRepo: !!state.activeRepo,
    hasStagedChanges: state.staged.length > 0,
    // AI 커밋 메시지 생성 진행 여부. 매 렌더마다 버튼 상태를 확정 동기화해 stuck-disabled 를 방지한다.
    aiGenerating: state.aiCommitGenerating,
    hooks: state.commitHooks,
    failure: state.commitFailure,
  };
}

/**
 * Changes 웹뷰가 표시할 편집기 gutter 상태와 가능한 해결 액션을 계산한다.
 * @param comparison 현재 비교의 ref/HEAD 가용성
 * @param comparisonEnabled Explorer/SCM 비교 표시 토글이 켜져 있는지 여부
 * @param gutterSettingEnabled VS Code 설정이 gutter 표시를 허용하는지 여부
 * @returns ready 또는 첫 차단 원인과 현재 비교 재선택 가능 여부
 */
function comparisonGutterStatus(
  comparison: BranchComparison,
  comparisonEnabled: boolean,
  gutterSettingEnabled: boolean
) {
  let state:
    | "active"
    | "comparisonHidden"
    | "refsUnavailable"
    | "targetNotCurrent"
    | "settingHidden" = "active";
  if (!comparisonEnabled) {
    state = "comparisonHidden";
  } else if (comparison.diffAvailable === false) {
    state = "refsUnavailable";
  } else if (!comparison.targetMatchesHead) {
    state = "targetNotCurrent";
  } else if (!gutterSettingEnabled) {
    state = "settingHidden";
  }
  return {
    state,
    diffAvailable: comparison.diffAvailable !== false,
    canShowComparison: state === "comparisonHidden",
    canCompareCurrent:
      comparison.kind === "branches" && state === "targetNotCurrent",
    canOpenSettings: state === "settingHidden",
  };
}

/**
 * payload 에 포함되는 모든 파일 경로를 모은다.
 * @param state provider 가 보관 중인 비교/변경/stash 상태
 */
function collectFilePaths(state: ChangesRenderState): string[] {
  return [
    ...(state.comparison?.changes.map((c) => c.path) ?? []),
    ...state.staged.map((c) => c.path),
    ...state.unstaged.map((c) => c.path),
    // 대형 stash 를 펼쳐도 수천 경로의 테마 아이콘 해석이 extension host 를 다시 막지 않게 제외한다.
    ...(state.fileHistory.path ? [state.fileHistory.path] : []),
    ...state.fileHistory.commits.flatMap((c) =>
      c.oldPath ? [c.path, c.oldPath] : [c.path]
    ),
  ];
}

/**
 * 경로에서 마지막 세그먼트(저장소 폴더명)를 뽑는다.
 * @param p 파일 시스템 경로
 */
function baseName(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}
