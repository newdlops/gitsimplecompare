// 명령 팔레트와 Changes 메뉴에서 stale 브랜치 정리 흐름을 조립한다.
// - 저장소를 한 번만 선택해 고정하고, 중복 실행과 확장 내부 Git 쓰기 경합을 막는다.
import * as vscode from "vscode";
import {
  StaleBranchCleanupCancelledError, StaleBranchRemoteError, StaleBranchService,
  type StaleBranchCleanupResult, type StaleBranchInspection,
} from "../git/staleBranchService";
import { logInfo, logWarn, showErrorWithOutput } from "../ui/outputLog";
import { confirmStaleBranchCleanup, showStaleBranchCleanupResult } from "../ui/staleBranchCleanup";
import { StaleBranchPanel } from "../webview/staleBranchPanel";
import { resolveCompareService, tryAcquireRepoMutation, type CommandDeps, type RepoMutationLease } from "./shared";

/** 선택창을 포함한 같은 저장소의 정리 흐름이 중복 실행되지 않게 한다. */
const activeCleanups = new Set<string>();

/**
 * 원격 조회 → 다중 선택 → 확인 → 삭제 → 결과 갱신을 실행한다.
 * @param deps 현재 저장소 선택과 Changes 갱신을 제공하는 명령 의존성
 * @returns 취소나 결과 표시까지 모두 마치면 resolve된다.
 */
export async function cleanupStaleBranches(deps: CommandDeps): Promise<void> {
  const git = await resolveCompareService(deps);
  if (!git) return;
  const repoRoot = git.repoRoot;
  if (activeCleanups.has(repoRoot)) {
    logInfo("stale branch cleanup skipped", { repoRoot, reason: "already-running" });
    await vscode.window.showInformationMessage(vscode.l10n.t("Stale branch cleanup is already running for this repository."));
    return;
  }
  activeCleanups.add(repoRoot);
  let lease: RepoMutationLease | undefined;
  let result: StaleBranchCleanupResult | undefined;
  try {
    const service = new StaleBranchService(repoRoot);
    logInfo("stale branch inspection started", { repoRoot });
    const inspection = await inspectWithProgress(service);
    logInfo("stale branch inspection completed", {
      repoRoot, remotes: inspection.remotes, local: inspection.localBranches.length, candidates: inspection.branches.length,
      protected: inspection.branches.filter(branch => branch.inUse).length,
    });
    const selected = await StaleBranchPanel.pick(deps.extensionUri, inspection);
    if (!selected) {
      logInfo("stale branch cleanup skipped", { repoRoot, reason: "empty-or-cancelled" });
      return;
    }
    if (!await confirmStaleBranchCleanup(repoRoot, selected)) {
      logInfo("stale branch cleanup cancelled", { repoRoot, stage: "confirmation" });
      return;
    }
    lease = tryAcquireRepoMutation(repoRoot, "stale-branch-cleanup");
    if (!lease) {
      logInfo("stale branch cleanup skipped", { repoRoot, reason: "repository-busy" });
      await vscode.window.showWarningMessage(vscode.l10n.t("Another Git operation is running for this repository. Try stale branch cleanup again when it finishes."));
      return;
    }
    result = await cleanupWithProgress(service, inspection, selected.map(branch => branch.name));
    logResult(repoRoot, result, false);
    if (result.unmerged.length && await confirmStaleBranchCleanup(repoRoot, result.unmerged, true)) {
      const forced = await cleanupWithProgress(service, inspection, result.unmerged.map(branch => branch.name), true);
      logResult(repoRoot, forced, true);
      result = {
        deleted: [...result.deleted, ...forced.deleted],
        unmerged: forced.unmerged,
        skipped: [...result.skipped, ...forced.skipped],
      };
    }
  } catch (error) {
    if (error instanceof StaleBranchCleanupCancelledError) {
      logInfo("stale branch inspection cancelled", { repoRoot });
    } else {
      showErrorWithOutput("stale branch cleanup failed", error, error instanceof StaleBranchRemoteError
        ? vscode.l10n.t("Could not check remote '{0}'. Branch deletion was stopped. Check the connection and try again.", error.remote)
        : vscode.l10n.t("Could not clean up stale branches: {0}", error instanceof Error ? error.message : String(error)), { repoRoot });
    }
  } finally {
    lease?.release();
    activeCleanups.delete(repoRoot);
    if (result?.deleted.length) {
      // 삭제 뒤 갱신이 실패해도 이미 완료한 삭제 결과를 오류로 덮어쓰지 않는다.
      try { await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges"); }
      catch (error) { logWarn("stale branch cleanup refresh failed", { repoRoot, error: String(error) }); }
    }
  }
  if (result) await showStaleBranchCleanupResult(result);
}

/**
 * 네이티브 진행 알림의 Cancel을 Git 프로세스 취소까지 전달한다.
 * @param service 선택된 저장소에 고정된 서비스
 * @returns 모든 원격을 읽은 후보 스냅샷
 */
function inspectWithProgress(service: StaleBranchService): Thenable<StaleBranchInspection> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: vscode.l10n.t("Checking local branch status…"), cancellable: true,
  }, async (_progress, token) => {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try { return await service.inspect(controller.signal); }
    catch (error) {
      if (controller.signal.aborted) throw new StaleBranchCleanupCancelledError();
      throw error;
    } finally { subscription.dispose(); }
  });
}

/**
 * 확인된 선택을 재검증하는 동안 진행 상태를 표시하고 중간 취소 없는 삭제 배치를 실행한다.
 * @param service 고정 저장소 서비스 @param inspection 승인한 후보 @param names 선택 이름
 * @param force 미병합 삭제 확인 여부 @returns 브랜치별 처리 결과
 */
function cleanupWithProgress(service: StaleBranchService, inspection: StaleBranchInspection, names: string[], force = false): Thenable<StaleBranchCleanupResult> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: vscode.l10n.t("Rechecking remotes and deleting selected local branches…"), cancellable: false,
  }, () => service.cleanup(inspection, names, force));
}

/**
 * 삭제한 tip과 건너뛴 이유를 OUTPUT에 남겨 부분 성공과 복구 대상 커밋을 확인할 수 있게 한다.
 * @param repoRoot 정리 저장소 @param result 배치 결과 @param force 강제 삭제 여부
 */
function logResult(repoRoot: string, result: StaleBranchCleanupResult, force: boolean): void {
  for (const branch of result.deleted) logInfo("stale branch deleted", { repoRoot, branch: branch.name, hash: branch.hash, force });
  for (const branch of result.unmerged) logInfo("stale branch kept", { repoRoot, branch: branch.name, reason: "not-merged" });
  for (const { branch, reason, message } of result.skipped) logWarn("stale branch kept", { repoRoot, branch: branch.name, reason, message });
  logInfo("stale branch cleanup completed", { repoRoot, deleted: result.deleted.length, unmerged: result.unmerged.length, skipped: result.skipped.length, force });
}
