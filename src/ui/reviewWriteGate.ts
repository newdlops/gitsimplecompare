// 검증 전 GitHub 리뷰 쓰기 동작을 release 기본값에서 막는 정책.
// - webview가 임의 메시지를 보내도 host가 다시 확인해 실수로 원격 상태가 바뀌지 않게 한다.
import * as vscode from "vscode";
export { isReviewCenterWriteMessage, isReviewQueueWriteMessage } from "./reviewWritePolicy";

/** 실험적 리뷰 쓰기 동작을 명시적으로 켜는 설정 키의 configuration section 내부 이름. */
export const experimentalReviewWritesSetting = "experimentalReviewWrites";

/** 현재 workspace에서 명시적으로 실험적 리뷰 쓰기를 허용했는지 반환한다. */
export function experimentalReviewWritesEnabled(): boolean {
  return vscode.workspace.getConfiguration("gitSimpleCompare").get<boolean>(experimentalReviewWritesSetting, false);
}
