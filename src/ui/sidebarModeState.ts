// Git Simple Compare 사이드바에서 보이는 1차 surface 상태를 정규화한다.
// - VS Code Memento에는 신뢰할 수 없는 이전 버전/손상 값이 남을 수 있으므로, 순수 함수로
//   읽기와 migration 판단을 분리해 host controller가 안전하게 영속화할 수 있게 한다.

/** Changes와 Reviews 중 Activity Bar 컨테이너에 표시할 최상위 surface. */
export type SidebarMode = "changes" | "reviews";

/** workspaceState에 저장하는 사이드바 mode의 안정적인 키. */
export const SIDEBAR_MODE_STATE_KEY = "gitSimpleCompare.sidebarMode";

/** 현재 영속 상태의 schema 버전. */
export const SIDEBAR_MODE_STATE_VERSION = 1;

/** workspaceState에 저장할 versioned sidebar mode 레코드. */
export interface SidebarModeStateV1 {
  version: typeof SIDEBAR_MODE_STATE_VERSION;
  mode: SidebarMode;
}

/** 상태를 읽은 결과와 정상 형태로 다시 저장해야 하는지 함께 전달한다. */
export interface SidebarModeStateRead {
  mode: SidebarMode;
  needsMigration: boolean;
}

/**
 * 외부 Memento 값을 안전한 sidebar mode로 변환한다.
 * @param value workspaceState에서 읽은 미검증 값
 * @returns 사용할 mode와 versioned 상태로 다시 저장할 필요 여부
 */
export function readSidebarModeState(value: unknown): SidebarModeStateRead {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === SIDEBAR_MODE_STATE_VERSION &&
    ((value as { mode?: unknown }).mode === "changes" ||
      (value as { mode?: unknown }).mode === "reviews")
  ) {
    return { mode: (value as SidebarModeStateV1).mode, needsMigration: false };
  }
  return { mode: "changes", needsMigration: true };
}

/**
 * 선택한 mode를 현재 schema의 Memento 레코드로 만든다.
 * @param mode 사용자가 마지막으로 선택한 surface
 * @returns workspaceState에 안전하게 저장할 레코드
 */
export function createSidebarModeState(mode: SidebarMode): SidebarModeStateV1 {
  return { version: SIDEBAR_MODE_STATE_VERSION, mode };
}
