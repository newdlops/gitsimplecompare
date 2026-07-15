// Changes 커밋 요청을 stage 정책, GitService, hook 실패 진단 UI 로 조립하는 command 모듈.
// - git 실행과 hook 파일 조회는 git/ 서비스에 위임하고 사용자 알림/새로고침만 담당한다.
import * as vscode from "vscode";
import {
  buildCommitFailureReport,
  commitFailureOutput,
  type CommitOperation,
} from "../git/commitHookFailure";
import { CommitHookService } from "../git/commitHookService";
import type { GitService } from "../git/gitService";
import { hasStagedChanges } from "../git/stagedChangesProbe";
import { GitGraphPanel } from "../webview/graphPanel";
import {
  logError,
  logInfo,
  logOutputBlock,
  showErrorWithOutput,
} from "../ui/outputLog";
import {
  activeRepoMutation,
  type CommandDeps,
  tryAcquireRepoMutation,
} from "./shared";

const COMMIT_OPERATIONS: readonly CommitOperation[] = [
  "commit",
  "staged",
  "all",
  "amend",
  "amendStaged",
  "amendAll",
];
let commitCommandActive = false;

/**
 * 동시에 들어온 웹뷰/외부 command 요청을 하나로 제한해 Git index와 busy 상태 경합을 막는다.
 * @param deps 공유 의존성
 * @param requestedOperation 웹뷰/명령이 요청한 commit, staged, all, amend 계열 값
 */
export async function commitChanges(
  deps: CommandDeps,
  requestedOperation: CommitOperation | string = "commit"
): Promise<void> {
  if (commitCommandActive) {
    logInfo("commit command skipped", {
      requestedOperation,
      reason: "commit-already-running",
    });
    return;
  }
  commitCommandActive = true;
  try {
    await commitChangesOnce(deps, requestedOperation);
  } finally {
    commitCommandActive = false;
  }
}

/**
 * 커밋한다. 스마트 커밋은 staged 변경이 없을 때 추적/미추적 변경 전체를 먼저 stage 한다.
 * - 실패하면 hook/검사 출력에서 파일·행 진단을 만들어 Changes 커밋 박스 아래에 유지한다.
 * @param deps 공유 의존성
 * @param requestedOperation 정규화 전 commit 종류
 */
async function commitChangesOnce(
  deps: CommandDeps,
  requestedOperation: CommitOperation | string
): Promise<void> {
  const service = activeService(deps);
  if (!service) {
    return;
  }
  const operation = normalizeCommitOperation(requestedOperation);
  const amend = operation.startsWith("amend");
  const message = deps.changesView.getCommitMessage().trim();
  if (!message && !amend) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Please enter a commit message first.")
    );
    return;
  }

  const lease = tryAcquireRepoMutation(service.repoRoot, "commit");
  if (!lease) {
    logInfo("commit command skipped", {
      root: service.repoRoot,
      operation,
      reason: "repo-write-active",
      activeOperation: activeRepoMutation(service.repoRoot),
    });
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Another Git write operation is already running for this repository."
      )
    );
    return;
  }

  try {
    await runCommitWithLease(deps, service, operation, amend, message);
  } finally {
    lease.release();
  }
}

/**
 * 저장소 쓰기 lease가 확보된 상태에서 stage 정책, commit, 실패 진단과 새로고침을 실행한다.
 * @param deps Changes 상태와 서비스 레지스트리를 제공하는 공유 의존성
 * @param service 현재 활성 저장소의 Git 서비스
 * @param operation 검증된 commit/staged/all/amend 계열 정책
 * @param amend 기존 HEAD를 수정하는 커밋인지 여부
 * @param message 사용자가 입력한 커밋 메시지
 */
async function runCommitWithLease(
  deps: CommandDeps,
  service: GitService,
  operation: CommitOperation,
  amend: boolean,
  message: string
): Promise<void> {
  let committed = false;
  let commitAttempted = false;
  const commandStartedAt = Date.now();
  try {
    // 커밋 정책에는 staged 존재 여부만 필요하므로 전체 status/untracked 탐색을 피한다.
    const preflightStartedAt = Date.now();
    const probeStaged = operation !== "all" && operation !== "amendAll";
    const hasStaged = probeStaged
      ? await hasStagedChanges(service.repoRoot)
      : false;
    logInfo("commit preflight finished", {
      root: service.repoRoot,
      operation,
      hasStaged,
      probeSkipped: !probeStaged,
      durationMs: Date.now() - preflightStartedAt,
    });
    if (requiresExistingStage(operation) && !hasStaged) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("There are no staged changes to commit.")
      );
      return;
    }
    deps.changesView.setCommitFailure(undefined);
    if (shouldStageAll(operation, hasStaged)) {
      await service.stageAll();
    }
    commitAttempted = true;
    const gitCommitStartedAt = Date.now();
    await service.commit(message, { amend });
    logInfo("git commit finished", {
      root: service.repoRoot,
      operation,
      durationMs: Date.now() - gitCommitStartedAt,
    });
    committed = true;
    if (deps.changesView.getActiveRepo() === service.repoRoot) {
      deps.changesView.setCommitMessage("");
    }
    GitGraphPanel.refreshOpen(service.repoRoot, "commit");
  } catch (error) {
    const activeHooks = commitAttempted
      ? await enabledCommitHooks(service.repoRoot)
      : [];
    const report = buildCommitFailureReport(error, service.repoRoot, {
      operation,
      activeHooks,
    });
    if (
      commitAttempted &&
      deps.changesView.getActiveRepo() === service.repoRoot
    ) {
      deps.changesView.setCommitFailure(report);
    }
    logInfo("commit failure diagnostics parsed", {
      root: service.repoRoot,
      operation,
      likelyHook: report.likelyHook,
      hook: report.hookName,
      check: report.checkName,
      items: report.items.length,
      files: new Set(report.items.map((item) => item.path).filter(Boolean)).size,
      outputLines: report.outputLines,
      truncated: report.truncated,
      phase: commitAttempted ? "commit" : "prepare",
    });
    logOutputBlock("commit process output", commitFailureOutput(error), {
      root: service.repoRoot,
      operation,
      phase: commitAttempted ? "commit" : "prepare",
    });
    showErrorWithOutput(
      "commit failed",
      error,
      vscode.l10n.t("Commit failed: {0}", report.summary),
      { operation, likelyHook: report.likelyHook }
    );
  }

  // 실제 commit이 끝났으면 버튼 busy를 먼저 풀고, working/HEAD 의존 화면은 백그라운드에서 맞춘다.
  const refreshReason = committed ? "commitResult" : "commitAttempt";
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: refreshReason,
  }).then(
    () => logInfo("commit follow-up refresh finished", {
      root: service.repoRoot,
      operation,
      reason: refreshReason,
      totalDurationMs: Date.now() - commandStartedAt,
    }),
    (error) => logError("commit follow-up refresh failed", error, {
      root: service.repoRoot,
      operation,
      reason: refreshReason,
    })
  );
}

/**
 * 현재 Changes 뷰가 선택한 저장소의 GitService 를 반환한다.
 * @param deps 공유 의존성
 * @returns 활성 저장소가 있으면 캐시된 서비스, 없으면 undefined
 */
function activeService(deps: CommandDeps): GitService | undefined {
  const root = deps.changesView.getActiveRepo();
  return root ? deps.registry.get(root) : undefined;
}

/**
 * 웹뷰 문자열을 허용된 commit 종류로 제한해 임의 인자가 stage 정책에 들어오지 않게 한다.
 * @param operation 런타임에서 전달된 commit 종류 후보
 * @returns 허용된 값이면 그대로, 아니면 기본 smart commit
 */
function normalizeCommitOperation(operation: string): CommitOperation {
  return COMMIT_OPERATIONS.includes(operation as CommitOperation)
    ? (operation as CommitOperation)
    : "commit";
}

/**
 * staged 전용 커밋이라 기존 stage 항목이 반드시 필요한지 판단한다.
 * @param operation 정규화된 commit 종류
 * @returns staged/amendStaged 면 true
 */
function requiresExistingStage(operation: CommitOperation): boolean {
  return operation === "staged" || operation === "amendStaged";
}

/**
 * 선택한 commit 정책과 현재 staged 개수로 `git add -A` 선행 여부를 계산한다.
 * @param operation 정규화된 commit 종류
 * @param hasStaged 현재 staged 변경 존재 여부
 * @returns 전체 stage 가 필요하면 true
 */
function shouldStageAll(
  operation: CommitOperation,
  hasStaged: boolean
): boolean {
  return (
    operation === "all" ||
    operation === "amendAll" ||
    ((operation === "commit" || operation === "amend") && !hasStaged)
  );
}

/**
 * 실패 시점에 활성 hook 이름을 다시 읽어 출력에 이름이 없을 때의 제한적 추론에 사용한다.
 * @param repoRoot commit 을 실행한 저장소 루트
 * @returns 조회 실패 시 빈 목록, 성공하면 enabled hook 이름 목록
 */
async function enabledCommitHooks(repoRoot: string) {
  return new CommitHookService(repoRoot)
    .inspect()
    .then((snapshot) =>
      snapshot.hooks.filter((hook) => hook.enabled).map((hook) => hook.name)
    )
    .catch(() => []);
}
