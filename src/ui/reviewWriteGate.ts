// GitHub 리뷰 쓰기를 사용자가 끌 수 있게 하는 host 경계 정책.
// - webview가 임의 메시지를 보내도 workspace 설정을 다시 확인해 읽기 전용 선택을 보존한다.
import * as vscode from "vscode";
export { isReviewCenterWriteMessage, isReviewQueueWriteMessage } from "./reviewWritePolicy";

/** 리뷰 쓰기 동작의 configuration section 내부 설정 키. */
export const reviewWritesEnabledSetting = "reviewWritesEnabled";

/** 현재 workspace에서 리뷰 쓰기를 허용했는지 반환하며, 기본값은 사용 가능 상태다. */
export function reviewWritesEnabled(): boolean {
  return vscode.workspace.getConfiguration("gitSimpleCompare").get<boolean>(reviewWritesEnabledSetting, true);
}
