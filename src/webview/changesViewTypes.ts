import type { ViewMode } from "../providers/changesTreeModel";

/** 트리/리스트 보기를 가지는 섹션(Repositories 는 제외). */
export type TreeSection = "compare" | "changes";

/** 최상위 아코디언 섹션 식별자 목록. */
export const VISIBLE_SECTIONS = [
  "repos",
  "changes",
  "compare",
  "stashes",
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

/** 트리 섹션 식별자 목록(순회·기본값 생성용). */
export const TREE_SECTIONS: TreeSection[] = ["compare", "changes"];
