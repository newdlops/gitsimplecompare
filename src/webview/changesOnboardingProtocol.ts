// 온보딩의 표시 상태와 실행 가능한 액션을 웹뷰·명령 레이어가 공유하는 계약.
export type RepositorySetupAction = "clone" | "github" | "open" | "init";
export interface RepositorySetupState {
  phase: "scanning" | "idle" | "running" | "error" | "complete";
  action?: RepositorySetupAction;
  message?: string;
  repositoryRoot?: string;
}
/** 웹뷰가 임의 명령을 실행하지 않고 온보딩의 네 가지 동작만 요청할 수 있게 고정한다. */
export const REPOSITORY_SETUP_COMMANDS: Record<RepositorySetupAction, string> = {
  clone: "gitSimpleCompare.cloneRepository",
  github: "gitSimpleCompare.cloneFromGitHub",
  open: "gitSimpleCompare.openRepository",
  init: "gitSimpleCompare.initializeRepository",
};

/**
 * 외부 웹뷰의 문자열을 온보딩에서 허용한 액션으로 좁힌다.
 * @param action postMessage에서 받은 미검증 액션 문자열
 * @returns 허용된 네 액션이면 true, 다른 명령이나 prototype 이름이면 false
 */
export function isRepositorySetupAction(action: unknown): action is RepositorySetupAction {
  return typeof action === "string" && Object.prototype.hasOwnProperty.call(REPOSITORY_SETUP_COMMANDS, action);
}
