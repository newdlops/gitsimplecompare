// PR 임시 worktree 복구의 선택·Conflicts 표시·계속 실행을 네이티브 VS Code UI로 연결한다.
import * as path from "node:path";
import * as vscode from "vscode";
import { PullRequestWorktreeRecoveryService, type PullRequestWorktreeRecoveryError } from "../git/pullRequestWorktreeRecovery";
import {
  assertPullRequestRecoveryIdentity, listPullRequestWorktreeRecoveries, readPullRequestWorktreeRecovery,
  type PullRequestWorktreeRecovery,
} from "../git/pullRequestWorktreeRecoveryState";
import { PullRequestOperationService } from "../git/pullRequestOperationService";
import { logInfo, showErrorWithOutput, showOutputLog } from "../ui/outputLog";
import { resolveCompareService, type CommandDeps } from "./shared";
import { checkPullRequestDependencies, offerPullRequestDependencies } from "../ui/pullRequestDependencies";
import type { PullRequestInfo } from "../git/pullRequestInfo";

/** 알림의 고정 ID를 받는다. 경로만으로는 작업 출처나 실행 종류를 추측하지 않는다. */
export interface OpenPullRequestRecoveryArgs { originRoot: string; id: string }

/**
 * 오래 걸린 PR 작업의 stderr 대신 짧은 안내와 실제 복구 화면을 제공한다.
 * @param error 저장 ID와 원래 대상 브랜치를 가진 구조화된 중단 오류
 */
export async function offerPullRequestWorktreeRecovery(error: PullRequestWorktreeRecoveryError, knownPullRequests?: PullRequestInfo[]): Promise<void> {
  const record = error.recovery;
  await vscode.commands.executeCommand("gitSimpleCompare.resumePrOperation", { originRoot: record.originRoot, id: record.id });
  const output = vscode.l10n.t("Show Output");
  const message = record.phase === "conflicts"
    ? vscode.l10n.t("PR #{0} paused with conflicts in a temporary worktree. Resolve them in the Conflicts view, then Continue PR Operation. Your original local changes are preserved.", record.pr.number)
    : vscode.l10n.t("PR #{0} could not be applied. Its result is preserved in a temporary worktree. Check Output, then retry with Continue PR Operation.", record.pr.number);
  if (record.phase === "conflicts" && (record.command === "squash" || record.command === "rebase")) {
    await offerPullRequestDependencies(record.originRoot, { pr: record.pr, beforeHead: record.beforeHead,
      branch: record.branch, knownPullRequests }, message);
  } else if (await vscode.window.showWarningMessage(message, output) === output) showOutputLog(false);
}

/** 보존된 작업의 원래 HEAD로 선행 후보를 다시 확인한다. 해결 중인 파일과 index는 건드리지 않는다. */
export async function inspectSavedPullRequestDependencies(deps: CommandDeps): Promise<void> {
  const record = deps.conflicts.currentRecovery;
  if (!record) { vscode.window.showInformationMessage(vscode.l10n.t("No saved PR operation is available for this working tree.")); return; }
  if (record.command !== "squash" && record.command !== "rebase") {
    vscode.window.showInformationMessage(vscode.l10n.t("Prerequisite inspection is available for PR apply operations.")); return;
  }
  try {
    await assertPullRequestRecoveryIdentity(record);
    await checkPullRequestDependencies(record.originRoot, { pr: record.pr, beforeHead: record.beforeHead, branch: record.branch });
  } catch (error) { reportRecoveryError(error); }
}

/**
 * 알림의 작업 또는 재시작 후 선택한 저장된 PR 작업을 Conflicts 화면에 연다.
 * @param deps 저장소 탐지와 기존 충돌 UI @param args 알림이 이미 지정한 작업
 */
export async function openPullRequestWorktreeRecovery(deps: CommandDeps, args?: OpenPullRequestRecoveryArgs): Promise<void> {
  try {
    let record: PullRequestWorktreeRecovery | undefined;
    if (args) record = await readPullRequestWorktreeRecovery(args.originRoot, args.id);
    else {
      const root = deps.conflicts.currentRecovery?.originRoot ?? (await resolveCompareService(deps))?.repoRoot;
      if (!root) return;
      const records = await listPullRequestWorktreeRecoveries(root);
      if (!records.length) {
        vscode.window.showInformationMessage(vscode.l10n.t("No saved PR operation is available for this working tree."));
        return;
      }
      record = (await vscode.window.showQuickPick(records.map(item => ({
        label: `$(git-pull-request) #${item.pr.number} ${item.pr.title}`,
        description: `${item.command} → ${item.branch}`,
        detail: `${new Date(item.createdAt).toLocaleString()} · ${item.worktreePath}`,
        record: item,
      })), { title: vscode.l10n.t("Resume PR Operation"), matchOnDescription: true, matchOnDetail: true }))?.record;
    }
    if (!record) return;
    await assertPullRequestRecoveryIdentity(record);
    await deps.conflicts.setPullRequestRecovery(record);
    await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
    logInfo("PR recovery opened", { id: record.id, number: record.pr.number, worktreePath: record.worktreePath });
  } catch (error) { reportRecoveryError(error); }
}

/**
 * 선택한 복구 작업의 해결 결과를 저장한 뒤 원래 브랜치에 반영한다.
 * @param deps 작업 상태를 고정한 Conflicts 컨트롤러와 새로고침 명령
 */
export async function continuePullRequestWorktreeRecovery(deps: CommandDeps): Promise<void> {
  const selected = deps.conflicts.currentRecovery;
  if (!selected) { await openPullRequestWorktreeRecovery(deps); return; }
  try {
    // 메모리에서만 편집된 문서를 놓친 채 index의 이전 내용을 적용하지 않는다.
    const dirty = vscode.workspace.textDocuments.some(document => document.isDirty &&
      ((document.uri.scheme === "file" && isWithin(selected.worktreePath, document.uri.fsPath)) ||
       deps.conflictOverlay.sessionForUri(document.uri, true)?.service.repoRoot === selected.worktreePath));
    if (dirty) throw new Error(vscode.l10n.t("Save your conflict resolution files before continuing the PR operation."));
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Continuing PR #{0} operation", selected.pr.number), cancellable: false,
    }, () => new PullRequestWorktreeRecoveryService(selected.originRoot).continue(selected.id));
    if (result.status === "conflicts") {
      await deps.conflicts.setPullRequestRecovery(await readPullRequestWorktreeRecovery(selected.originRoot, selected.id));
      vscode.window.showWarningMessage(vscode.l10n.t("PR #{0} reached another conflict. Resolve the remaining files, then Continue PR Operation.", selected.pr.number));
      return;
    }
    await deps.conflicts.setPullRequestRecovery();
    await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges");
    const undo = vscode.l10n.t("Undo PR Operation");
    if (await vscode.window.showInformationMessage(vscode.l10n.t("PR #{0} operation completed on '{1}'.", selected.pr.number, result.branch), undo) === undo) {
      await new PullRequestOperationService(selected.originRoot).undoLastOperation(result.branch);
      await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges");
    }
  } catch (error) {
    // 반영 전 HEAD가 바뀐 경우에도 완성된 결과와 같은 ID를 다시 열 수 있게 유지한다.
    const latest = await readPullRequestWorktreeRecovery(selected.originRoot, selected.id).catch(() => undefined);
    if (latest) await deps.conflicts.setPullRequestRecovery(latest);
    reportRecoveryError(error);
  }
}

/** 복구 파일은 모두 보존하고 Conflicts 명령 대상을 원래 작업트리로 돌린다. */
export async function leavePullRequestWorktreeRecovery(deps: CommandDeps): Promise<void> {
  await deps.conflicts.setPullRequestRecovery();
}

/** 경로 접두사 문자열 대신 디렉터리 경계를 비교해 같은 worktree의 편집 문서만 검사한다. */
function isWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 자세한 원인은 Output에 남기고 복구 자료가 유지됨을 짧게 안내한다. */
function reportRecoveryError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  showErrorWithOutput("PR recovery stopped", error, vscode.l10n.t("Could not continue PR operation: {0}", message));
}
