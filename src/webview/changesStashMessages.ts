// Changes 웹뷰의 stash 메시지를 등록 명령으로 전달한다.
// - provider 생명주기와 stash 동작 라우팅을 분리해 메시지 추가 시 본체가 비대해지지 않게 한다.
import * as vscode from "vscode";
import type { StashCommandSelection, StashFilesLoadResult } from "../commands/stash";
import { logError } from "../ui/outputLog";
import type { ChangesWebviewMessage } from "./changesWebviewProtocol";

/**
 * stash 관련 웹뷰 메시지를 처리하고 소비 여부를 반환한다.
 * @param msg 웹뷰가 보낸 공용 Changes 메시지
 * @param webview 지연 파일 조회 결과를 돌려보낼 현재 웹뷰
 * @returns stash 메시지를 처리했으면 true, 다른 router가 처리해야 하면 false
 */
export function routeChangesStashMessage(
  msg: ChangesWebviewMessage,
  webview: vscode.Webview | undefined
): boolean {
  const target = { ref: msg.ref ?? "", hash: msg.hash ?? "", repoRoot: msg.repoRoot ?? "", message: msg.message };
  if (msg.type === "stashSelected") {
    void vscode.commands.executeCommand("gitSimpleCompare.stashSelected", msg.paths);
    return true;
  }
  if (msg.type === "loadStashFiles" && msg.ref) {
    loadStashFiles(target, msg.stashKey, webview);
    return true;
  }
  if (msg.type === "applyStash" && msg.ref) {
    void vscode.commands.executeCommand("gitSimpleCompare.applyStash", target);
    return true;
  }
  if (msg.type === "popStash" && msg.ref) {
    void vscode.commands.executeCommand("gitSimpleCompare.popStash", target);
    return true;
  }
  if (msg.type === "dropStash" && msg.ref) {
    void vscode.commands.executeCommand("gitSimpleCompare.dropStash", target);
    return true;
  }
  if (msg.type === "branchStash" && msg.ref) {
    void vscode.commands.executeCommand("gitSimpleCompare.branchStash", target);
    return true;
  }
  if (msg.type === "openStashFile" && msg.ref && msg.path) {
    void vscode.commands.executeCommand("gitSimpleCompare.openStashFile", {
      ...target,
      path: msg.path,
    });
    return true;
  }
  return false;
}

/**
 * 펼친 stash 하나의 파일 목록을 명령 레이어에서 읽고 같은 stash key로 결과를 반환한다.
 * @param target 사용자가 펼친 저장소와 stash identity
 * @param stashKey DOM/cache가 사용하는 hash 기반 안정 키
 * @param webview 완료 메시지를 받을 현재 웹뷰
 */
function loadStashFiles(
  target: Exclude<StashCommandSelection, string>,
  stashKey: string | undefined,
  webview: vscode.Webview | undefined
): void {
  const load = vscode.commands.executeCommand<StashFilesLoadResult | undefined>(
    "gitSimpleCompare.loadStashFiles",
    target
  );
  void Promise.resolve(load)
    .catch((error) => {
      logError("stash files command failed", error, target);
      return undefined;
    })
    .then((result) => void webview?.postMessage({
      type: "stashFilesLoadComplete",
      ref: target.ref,
      stashKey,
      result,
    }));
}
