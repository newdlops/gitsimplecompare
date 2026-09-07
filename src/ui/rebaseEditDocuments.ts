// 일반/그래프 Continue가 동일한 저장 성공 기준을 사용하도록 VS Code 문서 저장을 모은다.
import * as vscode from "vscode";
import { listRebaseEditTempPaths } from "../git/rebaseEditSession";
import type { RebasePausedState } from "../git/rebaseService";
import { logInfo } from "./outputLog";

/**
 * 현재 edit의 dirty 임시 문서를 모두 저장하고 하나라도 실패·취소되면 Git 실행 전에 중단한다.
 * @param repoRoot 편집 세션을 소유한 작업트리
 * @param paused 저장할 임시 문서가 속한 정지 커밋
 * @returns 성공적으로 저장한 문서 수. 저장 도중 다시 dirty가 되어도 성공으로 세지 않는다.
 */
export async function saveRebaseEditTempDocuments(repoRoot: string, paused: RebasePausedState): Promise<number> {
  const paths = new Set(listRebaseEditTempPaths(repoRoot, paused));
  const docs = vscode.workspace.textDocuments.filter(doc => doc.isDirty && doc.uri.scheme === "file" && paths.has(doc.uri.fsPath));
  const results = await Promise.allSettled(docs.map(doc => doc.save()));
  const failed = docs.filter((doc, index) => results[index].status !== "fulfilled" ||
    (results[index] as PromiseFulfilledResult<boolean>).value !== true || doc.isDirty);
  if (failed.length) {
    logInfo("rebase edit document save stopped", { repoRoot, files: failed.map(doc => doc.uri.fsPath) });
    throw new Error(vscode.l10n.t("Rebase was left paused because some edit files could not be saved. Save them successfully before continuing."));
  }
  return docs.length;
}
