// Changes 웹뷰에서 시작한 장시간 명령과 즉시 진행 상태 메시지를 조립한다.
// - provider 의 상태/렌더 책임과 command 실행 중 busy 표시 책임을 분리한다.
import * as vscode from "vscode";
import { logInfo } from "../ui/outputLog";

let commitOperationActive = false;

/** stage/unstage 진행 상태를 웹뷰에 전달할 수 있는 provider 최소 계약. */
export interface WorkingTreeOperationHost {
  /**
   * @param active 작업이 진행 중인지 여부
   * @param action stage 또는 unstage
   * @param paths 선택 경로. 없으면 해당 그룹 전체
   * @param phase git 실행 또는 후속 refresh 단계
   */
  setWorkingOperation(
    active: boolean,
    action: "stage" | "unstage",
    paths?: string[],
    phase?: "git" | "refresh"
  ): void;
}

/**
 * 웹뷰에서 요청한 commit 명령을 실행하고 버튼 busy 상태를 항상 정리한다.
 * @param webview 진행 상태를 받을 현재 Changes 웹뷰. 닫혔으면 undefined
 * @param operation commit/staged/all/amend 계열 명령 인자
 */
export async function runCommitOperation(
  webview: vscode.Webview | undefined,
  operation?: string
): Promise<void> {
  if (commitOperationActive) {
    logInfo("commit request skipped", {
      operation,
      reason: "commit-already-running",
    });
    postCommitOperation(webview, true);
    return;
  }
  commitOperationActive = true;
  postCommitOperation(webview, true);
  try {
    await vscode.commands.executeCommand(
      "gitSimpleCompare.commit",
      operation
    );
  } finally {
    commitOperationActive = false;
    postCommitOperation(webview, false);
  }
}

/**
 * 웹뷰에서 요청한 stage/unstage 명령과 행 busy 표시 생명주기를 묶는다.
 * @param host 진행 상태를 웹뷰에 전달하는 provider
 * @param action stage 또는 unstage
 * @param paths 선택 경로. 없으면 그룹 전체
 */
export async function runWorkingTreeOperation(
  host: WorkingTreeOperationHost,
  action: "stage" | "unstage",
  paths?: string[]
): Promise<void> {
  host.setWorkingOperation(true, action, paths, "git");
  try {
    await vscode.commands.executeCommand(
      action === "stage"
        ? "gitSimpleCompare.stage"
        : "gitSimpleCompare.unstage",
      paths
    );
  } finally {
    host.setWorkingOperation(false, action, paths);
  }
}

/**
 * 현재 웹뷰의 commit 버튼에 진행 시작/종료 메시지를 보낸다.
 * @param webview 대상 웹뷰. 뷰가 dispose 된 경우 undefined
 * @param active commit 작업 진행 여부
 */
function postCommitOperation(
  webview: vscode.Webview | undefined,
  active: boolean
): void {
  void webview?.postMessage({ type: "commitOperation", active });
}
