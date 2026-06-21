// Changes 웹뷰로 보낼 렌더 payload 를 조립하는 모듈.
// - provider 상태 보관과 payload 변환을 분리해 렌더 최적화/중복 스킵을 쉽게 한다.
import type { BranchComparison } from "../git/gitTypes";
import type { StatusGroups } from "../git/gitService";
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
  draft: ComparisonDraft;
  staged: StatusGroups["staged"];
  unstaged: StatusGroups["unstaged"];
  stashes: StashView[];
  worktrees: WorktreeView[];
  fileHistory: FileHistoryView;
  commitMessage: string;
  commitMessageRevision: number;
  viewModes: ViewModes;
  sortKey: SortKey;
  visibleSections: VisibleSections;
}

/** Changes 웹뷰 JS 가 받는 render 메시지 payload. */
export type ChangesRenderPayload = ReturnType<typeof buildChangesRenderPayload>;

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
      from: state.comparison ? state.comparison.base : state.draft.from ?? "",
      to: state.comparison ? state.comparison.target : state.draft.to ?? "",
      viewMode: state.viewModes.compare,
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
    commit: {
      message: state.commitMessage,
      messageRevision: state.commitMessageRevision,
      branch: state.repositories.find((r) => r.root === state.activeRepo)
        ?.branch,
      hasRepo: !!state.activeRepo,
      hasStagedChanges: state.staged.length > 0,
    },
    stashes: state.stashes.map((s) => ({
      ref: s.ref,
      hash: s.hash,
      message: s.message,
      branch: s.branch,
      date: s.relativeDate,
      files: s.files,
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
 * payload 에 포함되는 모든 파일 경로를 모은다.
 * @param state provider 가 보관 중인 비교/변경/stash 상태
 */
function collectFilePaths(state: ChangesRenderState): string[] {
  return [
    ...(state.comparison?.changes.map((c) => c.path) ?? []),
    ...state.staged.map((c) => c.path),
    ...state.unstaged.map((c) => c.path),
    ...state.stashes.flatMap((s) => s.files.map((f) => f.path)),
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
