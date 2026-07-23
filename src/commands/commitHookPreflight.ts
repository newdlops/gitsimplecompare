// staged commit hook 사전 실행을 Git 서비스, Changes 실패 카드, OUTPUT 로그와 조립한다.
// - snapshot 격리/실행은 git 계층에 맡기고 이 모듈은 사용자 흐름과 저장소 lease만 담당한다.
import * as vscode from "vscode";
import {
  buildCommitFailureReport,
  commitFailureOutput,
} from "../git/commitHookFailure";
import {
  CommitHookPreflightError,
  CommitHookPreflightService,
  type CommitHookPreflightResult,
} from "../git/commitHookPreflightService";
import {
  logError,
  logInfo,
  logOutputBlock,
  showErrorWithOutput,
  showOutputLog,
} from "../ui/outputLog";
import {
  activeRepoMutation,
  tryAcquireRepoMutation,
  type CommandDeps,
} from "./shared";

/** 웹뷰가 사전 실행 직전 textarea 값을 command에 전달하는 검증 전 인자다. */
export interface RunCommitHookPreflightArgs {
  message?: string;
}

/**
 * 활성 Changes 저장소의 staged snapshot에 대해 실제 커밋 전 차단 hook을 미리 실행한다.
 * - 같은 저장소의 stage/commit/AI 플랜과 겹치지 않도록 process-local mutation lease를 사용한다.
 * - 성공 후에는 OUTPUT 또는 staged commit으로 바로 이어지는 액션을 제공한다.
 * @param deps 활성 저장소, 커밋 메시지와 실패 카드 상태를 제공하는 공유 의존성
 * @param args 웹뷰가 마지막 key 입력까지 포함해 전달한 선택적 커밋 메시지
 */
export async function runCommitHookPreflight(
  deps: CommandDeps,
  args?: RunCommitHookPreflightArgs
): Promise<void> {
  const repoRoot = deps.changesView.getActiveRepo();
  if (!repoRoot) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("No git repository found.")
    );
    return;
  }
  const lease = tryAcquireRepoMutation(repoRoot, "commit-hook-preflight");
  if (!lease) {
    const activeOperation = activeRepoMutation(repoRoot);
    logInfo("commit hook preflight skipped", {
      root: repoRoot,
      reason: "repo-write-active",
      activeOperation,
    });
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Another Git write operation is already running for this repository."
      )
    );
    return;
  }

  const commitMessage =
    typeof args?.message === "string"
      ? args.message
      : deps.changesView.getCommitMessage();
  const startedAt = Date.now();
  let result: CommitHookPreflightResult | undefined;
  try {
    deps.changesView.setCommitFailure(undefined);
    logInfo("commit hook preflight started", {
      root: repoRoot,
      hasCommitMessage: commitMessage.trim().length > 0,
    });
    result = await new CommitHookPreflightService(repoRoot).run(commitMessage);
    logOutputBlock(
      "staged commit hook preflight output",
      result.transcript,
      {
        root: repoRoot,
        stagedFiles: result.stagedFileCount,
        hooks: result.executions.map(({ hook }) => hook),
        skippedHooks: result.skippedHooks,
      },
      "info"
    );
    logInfo("commit hook preflight passed", {
      root: repoRoot,
      stagedFiles: result.stagedFileCount,
      hooks: result.executions.map(({ hook }) => hook),
      skippedHooks: result.skippedHooks,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    await handlePreflightFailure(deps, repoRoot, error, startedAt);
  } finally {
    lease.release();
  }

  if (result) {
    presentPreflightSuccess(result);
  }
}

/**
 * hook 실패는 기존 파일/행 진단 카드로 변환하고, 실행 전제 오류는 짧은 경고로 구분한다.
 * @param deps 실패 카드를 갱신할 Changes 의존성
 * @param repoRoot 사전 실행 대상 저장소 루트
 * @param error 서비스가 던진 hook/상태/파일 오류
 * @param startedAt 전체 실행 시간 계산 기준
 */
async function handlePreflightFailure(
  deps: CommandDeps,
  repoRoot: string,
  error: unknown,
  startedAt: number
): Promise<void> {
  if (
    error instanceof CommitHookPreflightError &&
    error.code !== "hookFailed"
  ) {
    logError("commit hook preflight blocked", error, {
      root: repoRoot,
      code: error.code,
      operation: error.operation,
      durationMs: Date.now() - startedAt,
    });
    if (error.transcript) {
      logOutputBlock(
        "staged commit hook preflight output",
        error.transcript,
        { root: repoRoot, code: error.code }
      );
    }
    showPreflightBlock(error);
    return;
  }

  const knownHook =
    error instanceof CommitHookPreflightError
      ? error.hookName
      : undefined;
  const report = buildCommitFailureReport(error, repoRoot, {
    activeHooks: knownHook ? [knownHook] : [],
    knownHookName: knownHook,
    operation: "staged",
    origin: "hookPreflight",
  });
  deps.changesView.setCommitFailure(report);
  const output = commitFailureOutput(error);
  logOutputBlock("staged commit hook preflight output", output, {
    root: repoRoot,
    hook: knownHook,
  });
  logInfo("commit hook preflight diagnostics parsed", {
    root: repoRoot,
    hook: report.hookName,
    check: report.checkName,
    items: report.items.length,
    files: new Set(report.items.map((item) => item.path).filter(Boolean)).size,
    outputLines: report.outputLines,
    truncated: report.truncated,
    durationMs: Date.now() - startedAt,
  });
  showErrorWithOutput(
    "commit hook preflight failed",
    error,
    vscode.l10n.t("Staged commit hook failed: {0}", report.summary),
    { root: repoRoot, hook: knownHook }
  );
}

/**
 * 성공 결과를 요약하고 OUTPUT 보기 또는 staged commit으로 이어지는 비차단 알림을 띄운다.
 * - 알림 응답을 기다리지 않아 웹뷰의 busy 상태와 저장소 lease를 즉시 해제한다.
 * @param result 실행된/건너뛴 hook과 staged 파일 수
 */
function presentPreflightSuccess(
  result: CommitHookPreflightResult
): void {
  const commitAction = vscode.l10n.t("Commit Staged");
  const outputAction = vscode.l10n.t("Show Output");
  const message = successMessage(result);
  void vscode.window
    .showInformationMessage(message, commitAction, outputAction)
    .then((choice) => {
      if (choice === commitAction) {
        void vscode.commands.executeCommand(
          "gitSimpleCompare.commit",
          "staged"
        );
      } else if (choice === outputAction) {
        showOutputLog(false);
      }
    });
}

/**
 * 실제 실행 수와 빈 메시지로 건너뛴 hook을 반영해 성공 토스트 문구를 만든다.
 * @param result 사전 실행 성공 결과
 * @returns 사용자가 무엇이 검사됐는지 오해하지 않는 지역화 요약
 */
function successMessage(result: CommitHookPreflightResult): string {
  if (result.executions.length === 0 && result.skippedHooks.length === 0) {
    return vscode.l10n.t(
      "No runnable commit hooks were found for the staged changes."
    );
  }
  const passed = vscode.l10n.t(
    "Staged commit hooks passed for {0} file(s).",
    result.stagedFileCount
  );
  return result.skippedHooks.length > 0
    ? `${passed} ${vscode.l10n.t(
        "Commit message hooks were skipped because the message is empty."
      )}`
    : passed;
}

/**
 * 실행 전제 오류 코드를 사용자가 바로 조치할 수 있는 지역화 경고로 표시한다.
 * @param error 서비스가 분류한 no-stage/active-operation/conflict/concurrency 오류
 */
function showPreflightBlock(error: CommitHookPreflightError): void {
  switch (error.code) {
    case "noStagedChanges":
      vscode.window.showWarningMessage(
        vscode.l10n.t("There are no staged changes to check.")
      );
      return;
    case "operationInProgress":
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Finish or abort the active {0} operation before running staged commit hooks.",
          error.operation ?? "Git"
        )
      );
      return;
    case "unmergedIndex":
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Resolve merge conflicts before running staged commit hooks."
        )
      );
      return;
    case "stagedChangesChanged": {
      const showOutput = vscode.l10n.t("Show Output");
      void vscode.window
        .showWarningMessage(
          vscode.l10n.t(
            "Staged changes changed while commit hooks were running. Run the checks again."
          ),
          showOutput
        )
        .then((choice) => {
          if (choice === showOutput) {
            showOutputLog(false);
          }
        });
      return;
    }
    default:
      vscode.window.showWarningMessage(error.message);
  }
}
