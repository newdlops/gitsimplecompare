import type { ViewMode } from "../providers/changesTreeModel";
import type { FileHistoryEntry } from "../git/fileHistoryService";

/** 트리/리스트 보기를 가지는 섹션(Repositories 는 제외). */
export type TreeSection = "compare" | "changes";

/** 최상위 아코디언 섹션 식별자 목록. */
export const VISIBLE_SECTIONS = [
  "repos",
  "changes",
  "history",
  "compare",
  "stashes",
  "worktrees",
] as const;

/** 표시 여부를 토글할 수 있는 아코디언 섹션. */
export type VisibleSection = (typeof VISIBLE_SECTIONS)[number];

/** 섹션별 보기 모드 묶음. */
export type ViewModes = Record<TreeSection, ViewMode>;

/** 섹션별 표시 여부 묶음. */
export type VisibleSections = Record<VisibleSection, boolean>;

/** 비교 실행 전, 사용자가 설정 중인 from/to 초안. */
export interface ComparisonDraft {
  from?: string;
  to?: string;
}

/** 현재 활성 파일의 커밋 히스토리 섹션 상태. */
export interface FileHistoryView {
  repoRoot?: string;
  path?: string;
  commits: FileHistoryEntry[];
  message?: string;
}

/** Changes 웹뷰 Worktrees 섹션에 표시할 worktree 행 상태. */
export interface WorktreeView {
  /** worktree 가 속한 git 저장소 루트 */
  repoRoot: string;
  /** 저장소 표시 이름. 여러 저장소가 열렸을 때 행 구분에 사용한다. */
  repoName: string;
  /** worktree 루트 절대 경로 */
  path: string;
  /** 경로 마지막 세그먼트로 만든 표시 이름 */
  name: string;
  /** checkout 된 브랜치 이름. detached HEAD 면 undefined 다. */
  branch?: string;
  /** HEAD 커밋 해시. 아직 커밋이 없으면 빈 문자열일 수 있다. */
  head: string;
  /** main worktree 여부. main worktree 는 삭제/이동 대상에서 제외한다. */
  isMain: boolean;
  /** locked worktree 면 잠금 사유. 사유가 없으면 빈 문자열이다. */
  locked?: string;
  /** prunable worktree 면 prune 사유. 사유가 없으면 빈 문자열이다. */
  prunable?: string;
}

/** 트리 섹션 식별자 목록(순회·기본값 생성용). */
export const TREE_SECTIONS: TreeSection[] = ["compare", "changes"];
