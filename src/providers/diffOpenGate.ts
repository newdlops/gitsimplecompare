// editable diff 가 처음 열리는 동안 무거운 후속 작업을 늦추는 작은 게이트.
// - diff editor 자체를 먼저 사용자에게 보여주고, checkbox/refresh 는 약간 뒤에 붙인다.
import * as vscode from "vscode";
import { pauseOutputLog } from "../ui/outputLog";

const CHECKBOX_ATTACH_DELAY_MS = 1800;

const endEmitter = new vscode.EventEmitter<void>();
const openFiles = new Map<string, number>();

export const onDidEndDiffOpen = endEmitter.event;

/**
 * diff open 고부하 구간을 시작하고, 종료 시 호출할 finisher 를 반환한다.
 * @param fileUri 오른쪽 작업트리 파일 URI
 * @returns executeCommand 이후 반드시 호출할 종료 함수
 */
export function beginDiffOpen(fileUri: vscode.Uri): () => void {
  const key = fileUri.toString();
  openFiles.set(key, (openFiles.get(key) ?? 0) + 1);
  const resumeOutputLog = pauseOutputLog("diffOpen");
  let finished = false;
  return () => {
    if (finished) {
      return;
    }
    finished = true;
    resumeOutputLog();
    setTimeout(() => {
      const next = (openFiles.get(key) ?? 1) - 1;
      if (next > 0) {
        openFiles.set(key, next);
      } else {
        openFiles.delete(key);
      }
      endEmitter.fire();
    }, CHECKBOX_ATTACH_DELAY_MS);
  };
}

/**
 * 아직 diff open 후속 지연 구간이 남아 있는지 확인한다.
 * @returns 하나 이상의 diff open gate 가 활성 상태이면 true
 */
export function isAnyDiffOpenInProgress(): boolean {
  return openFiles.size > 0;
}
