// AI 커밋 플랜 명령을 Git 컨텍스트, AI 생성기, 검토 패널, 실행 서비스와 조립한다.
// - 웹뷰에는 콜백만 주입하고, 저장소 선택/새로고침/오류 알림은 명령 레이어에서 일관되게 처리한다.
import * as vscode from "vscode";
import { generateAiCommitPlan } from "../ai/commitPlanner";
import type { CommitPlanContext } from "../ai/commitPlanModel";
import {
  readAiCommitPlanContext,
  type AiCommitPlanOperation,
} from "../git/aiCommitPlanContext";
import {
  AiCommitPlanError,
  AiCommitPlanService,
  type CommitPlanExecutionResult,
} from "../git/aiCommitPlanService";
import {
  buildCommitFailureReport,
  commitFailureOutput,
} from "../git/commitHookFailure";
import {
  CommitHookService,
  type CommitHookName,
} from "../git/commitHookService";
import { makeRefUri } from "../utils/uri";
import {
  openHeadVsIndexDiff,
  openRefVsWorkingDiff,
} from "../ui/diffPresenter";
import {
  logError,
  logInfo,
  logOutputBlock,
  showErrorWithOutput,
} from "../ui/outputLog";
import { presentCommitPlanExecutionFailure } from "../webview/commitPlanExecutionPresentation";
import { CommitPlanPanel } from "../webview/commitPlanPanel";
import type {
  CommitPlanOperation,
  CommitPlanPanelActions,
} from "../webview/commitPlanProtocol";
import { GitGraphPanel } from "../webview/graphPanel";
import { showAiCommandError } from "./aiMessages";
import {
  activeRepoMutation,
  CommandDeps,
  resolveCompareService,
  tryAcquireRepoMutation,
} from "./shared";

/** Changes 커밋 박스 또는 Command Palette가 AI 플랜을 열 때 전달하는 선택 인자다. */
export interface OpenAiCommitPlanArgs {
  operation?: string;
  commitIntent?: string;
  extraPrompt?: string;
  autoGenerate?: boolean;
}

let planOpenActive = false;

/**
 * 현재 커밋 정책에 맞는 변경 컨텍스트를 읽고 AI 커밋 플랜 검토 패널을 연다.
 * - Changes의 기본 Commit은 staged가 있으면 staged만, 없으면 전체라는 기존 정책을 그대로 따른다.
 * - 커밋 박스의 플랜 모드에서 호출되면 추가 프롬프트를 전달한 뒤 패널 준비 즉시 AI 생성을 시작한다.
 * @param deps 명령 공유 의존성
 * @param args 커밋 범위, 전체 변경 의도, 요청별 추가 프롬프트와 자동 생성 여부
 */
export async function openAiCommitPlan(
  deps: CommandDeps,
  args: OpenAiCommitPlanArgs = {}
): Promise<void> {
  if (planOpenActive) {
    logInfo("AI commit plan open skipped", { reason: "already-opening" });
    return;
  }
  planOpenActive = true;
  try {
    const git = await resolveCompareService(deps);
    if (!git) {
      return;
    }
    const operation = normalizeOperation(args.operation);
    logInfo("AI commit plan context requested", {
      repoRoot: git.repoRoot,
      operation,
      autoGenerate: args.autoGenerate === true,
      hasExtraPrompt: hasText(args.extraPrompt),
      hasCommitIntent: hasText(args.commitIntent),
    });
    const context = await readAiCommitPlanContext(git.repoRoot, operation);
    assertPlanWorthSplitting(context);
    CommitPlanPanel.createOrShow(
      deps.extensionUri,
      context,
      createPanelActions(deps, context.repoRoot, operation),
      {
        autoGenerate: args.autoGenerate === true,
        prompt: args.extraPrompt,
        intent: args.commitIntent,
      }
    );
    logInfo("AI commit plan panel opened", {
      repoRoot: git.repoRoot,
      branch: context.branch,
      scope: context.scope,
      files: context.files.length,
    });
  } catch (error) {
    logError("AI commit plan open failed", error, {
      repoRoot: deps.changesView.getActiveRepo(),
    });
    vscode.window.showErrorMessage(
      vscode.l10n.t("Could not open AI commit plan: {0}", errorText(error))
    );
  } finally {
    planOpenActive = false;
  }
}

/**
 * 패널이 AI/git/UI 세부 구현을 직접 알지 않도록 현재 저장소 정책에 결합된 액션을 만든다.
 * @param deps 명령 공유 의존성
 * @param repoRoot 이 패널 세션이 계속 다룰 저장소 루트
 * @param operation 패널 새로고침에서도 유지할 commit/staged/all 범위 정책
 * @returns 생성, 컨텍스트 갱신, 실행, 파일 열기, 설정, 오류 보고 콜백
 */
function createPanelActions(
  deps: CommandDeps,
  repoRoot: string,
  operation: AiCommitPlanOperation
): CommitPlanPanelActions {
  let activeExecutionHooks: CommitHookName[] = [];
  return {
    generate: (context, prompt, intent, token) =>
      generateAiCommitPlan(
        context,
        { extraPrompt: prompt, commitIntent: intent },
        token
      ),
    refreshContext: async () => {
      const context = await readAiCommitPlanContext(repoRoot, operation);
      assertPlanWorthSplitting(context);
      logInfo("AI commit plan context refreshed", {
        repoRoot,
        scope: context.scope,
        files: context.files.length,
      });
      return context;
    },
    execute: async (context, result, onProgress) => {
      activeExecutionHooks = [];
      const lease = tryAcquireRepoMutation(context.repoRoot, "AI commit plan");
      if (!lease) {
        logInfo("AI commit plan execution skipped", {
          repoRoot: context.repoRoot,
          reason: "repo-write-active",
          activeOperation: activeRepoMutation(context.repoRoot),
        });
        throw new Error(
          vscode.l10n.t(
            "Another Git write operation is already running for this repository."
          )
        );
      }
      const started = Date.now();
      let execution: CommitPlanExecutionResult;
      try {
        activeExecutionHooks = await enabledCommitHooks(context.repoRoot);
        logInfo("AI commit plan execution started", {
          repoRoot: context.repoRoot,
          scope: context.scope,
          groups: result.groups.length,
          files: context.files.length,
          activeHooks: activeExecutionHooks.length,
        });
        execution = await new AiCommitPlanService(context.repoRoot).execute(
          context,
          result,
          (progress) => {
            logInfo("AI commit plan execution progress", {
              repoRoot: context.repoRoot,
              phase: progress.phase,
              step: progress.step,
              current: progress.current,
              total: progress.total,
              files: progress.paths?.length ?? 0,
            });
            return onProgress(progress);
          }
        );
      } finally {
        lease.release();
      }
      logInfo("AI commit plan execution completed", {
        repoRoot: context.repoRoot,
        groups: execution.commits.length,
        hookAdjustedFiles: execution.commits.reduce(
          (count, commit) => count + (commit.hookAdjustedPaths?.length ?? 0),
          0
        ),
        head: execution.head,
        elapsed: Date.now() - started,
      });
      await refreshAfterAiCommitPlan(deps, context.repoRoot);
      return {
        message: vscode.l10n.t(
          "Created {0} planned commit(s).",
          execution.commits.length
        ),
      };
    },
    openFile: (filePath, context) => openPlanFile(context, filePath),
    configure: async () => {
      await vscode.commands.executeCommand("gitSimpleCompare.configureAiCli");
    },
    reportError: (error, failedOperation) =>
      reportPanelError(error, failedOperation, deps.changesView.getActiveRepo()),
    formatError: errorText,
    formatExecutionFailure: (error) =>
      formatAiCommitPlanExecutionFailure(error, repoRoot, activeExecutionHooks),
  };
}

/**
 * AI 플랜 실행 오류의 hook 출력을 공용 파서로 구조화하고 웹뷰에는 제한된 진단만 전달한다.
 * - stdout/stderr 원문은 OUTPUT에 별도 블록으로 남겨 웹뷰 데이터 크기와 민감 정보 노출을 줄인다.
 * @param error private git commit 또는 안전 검증에서 발생한 원본 오류
 * @param repoRoot hook 경로와 진단 파일 위치를 검증할 저장소 루트
 * @param activeHooks 실행 직전에 고정해 둔 활성 commit hook 이름
 * @returns 패널 실패 카드에 직렬화할 크기 제한 presentation
 */
function formatAiCommitPlanExecutionFailure(
  error: unknown,
  repoRoot: string,
  activeHooks: readonly CommitHookName[]
) {
  const report = buildCommitFailureReport(error, repoRoot, {
    activeHooks,
    commitCommandFailed: isGitCommitFailure(error),
  });
  const output = commitFailureOutput(error);
  logInfo("AI commit plan failure diagnostics parsed", {
    repoRoot,
    likelyHook: report.likelyHook,
    hook: report.hookName,
    check: report.checkName,
    items: report.items.length,
    outputLines: report.outputLines,
    truncated: report.truncated,
  });
  logOutputBlock("AI commit plan process output", output, {
    repoRoot,
    likelyHook: report.likelyHook,
  });
  return presentCommitPlanExecutionFailure(report);
}

/**
 * 실행 직전 활성 commit hook을 고정해 실패 hook이 자신을 변경해도 원래 실행 후보를 보존한다.
 * @param repoRoot 곧 private commit을 실행할 저장소 루트
 * @returns 조회 실패 시 빈 목록, 성공하면 활성 표준 commit hook 이름 목록
 */
async function enabledCommitHooks(repoRoot: string): Promise<CommitHookName[]> {
  return new CommitHookService(repoRoot)
    .inspect()
    .then((snapshot) =>
      snapshot.hooks.filter((hook) => hook.enabled).map((hook) => hook.name)
    )
    .catch(() => []);
}

/**
 * 저수준 GitError 메시지에서 실패한 하위 명령이 `git commit`인지 보수적으로 확인한다.
 * @param error AI 플랜 실행 중 throw 된 원본 값
 * @returns hook 추론에 사용할 수 있는 직접 commit 실패이면 true
 */
function isGitCommitFailure(error: unknown): boolean {
  return error instanceof Error && /^git commit(?:\s|$)/i.test(error.message);
}

/**
 * Git 트랜잭션 성공 뒤 Changes/Graph 캐시를 best-effort로 갱신한다.
 * - 후속 UI 새로고침 실패를 커밋 실패로 오인하지 않도록 각각 기록하고 삼킨다.
 * @param deps 활성 Changes 뷰와 GitService 레지스트리를 가진 명령 의존성
 * @param repoRoot 방금 AI 플랜 커밋을 적용한 저장소
 */
async function refreshAfterAiCommitPlan(
  deps: CommandDeps,
  repoRoot: string
): Promise<void> {
  try {
    deps.registry.get(repoRoot).invalidateStatusCache();
    if (deps.changesView.getActiveRepo() === repoRoot) {
      deps.changesView.setCommitMessage("");
      await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
        reason: "commit",
      });
    }
  } catch (error) {
    logError("AI commit plan post-commit Changes refresh failed", error, {
      repoRoot,
    });
  }
  try {
    GitGraphPanel.refreshOpen(repoRoot, "aiCommitPlan");
  } catch (error) {
    logError("AI commit plan post-commit graph refresh failed", error, {
      repoRoot,
    });
  }
}

/**
 * 계획 파일을 범위에 맞는 diff로 연다. staged는 HEAD↔index를, 전체 변경은 HEAD↔작업파일을 사용한다.
 * 삭제 파일은 작업파일 URI가 없으므로 HEAD의 읽기 전용 원본을 대신 연다.
 * @param context 파일이 속한 계획 컨텍스트
 * @param filePath 저장소 상대 현재 경로
 */
async function openPlanFile(
  context: CommitPlanContext,
  filePath: string
): Promise<void> {
  const file = context.files.find((item) => item.path === filePath);
  if (!file) {
    throw new Error(`Unknown AI commit plan path: ${filePath}`);
  }
  if (context.scope === "staged") {
    await openHeadVsIndexDiff(context.repoRoot, filePath, file.oldPath);
    return;
  }
  if (file.status === "D") {
    await vscode.commands.executeCommand(
      "vscode.open",
      makeRefUri("HEAD", file.oldPath ?? filePath, context.repoRoot)
    );
    return;
  }
  const workingUri = vscode.Uri.file(`${context.repoRoot}/${filePath}`);
  if (!context.head) {
    await vscode.commands.executeCommand("vscode.open", workingUri);
    return;
  }
  await openRefVsWorkingDiff(
    context.repoRoot,
    "HEAD",
    workingUri,
    filePath,
    { leftRelPath: file.oldPath }
  );
}

/**
 * 패널 작업 오류를 OUTPUT에 기록하고 AI 설정/인증 또는 Git 실행에 맞는 알림 액션을 제공한다.
 * @param error 원본 오류
 * @param operation 실패한 패널 작업
 * @param repoRoot 현재 Changes 저장소(로그 보조 정보)
 */
async function reportPanelError(
  error: unknown,
  operation: CommitPlanOperation,
  repoRoot: string | undefined
): Promise<void> {
  if (operation === "generate") {
    await showAiCommandError("AI commit plan generation failed: {0}", error);
    return;
  }
  if (operation === "execute") {
    showErrorWithOutput(
      "AI commit plan execution failed",
      error,
      vscode.l10n.t("AI commit plan execution failed: {0}", errorText(error)),
      { repoRoot }
    );
    return;
  }
  logError("AI commit plan panel action failed", error, {
    repoRoot,
    operation,
  });
}

/** 사용자가 선택한 범위에 파일이 둘 이상인지 확인해 실제 분할 가치가 없는 호출을 막는다. */
function assertPlanWorthSplitting(context: CommitPlanContext): void {
  if (context.files.length < 2) {
    throw new Error(
      "AI commit planning needs at least two changed files in the selected commit scope."
    );
  }
}

/** 웹뷰/Command Palette 문자열을 지원하는 commit/staged/all 값으로 제한한다. */
function normalizeOperation(value: string | undefined): AiCommitPlanOperation {
  return value === "staged" || value === "all" ? value : "commit";
}

/** 선택 문자열에 공백 외 내용이 있는지 확인해 원문을 기록하지 않고 로그 크기 정보만 남긴다. */
function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** catch로 받은 값을 사용자 알림에 넣을 한 줄 오류 문자열로 변환한다. */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.trim()) {
    return vscode.l10n.t("Unknown commit plan error.");
  }
  if (error instanceof AiCommitPlanError) {
    switch (error.code) {
      case "repository-mismatch":
        return vscode.l10n.t(
          "This AI commit plan belongs to a different repository."
        );
      case "stale-snapshot":
        return vscode.l10n.t(
          "Changes have moved since this AI commit plan was generated. Refresh and regenerate the plan."
        );
      case "invalid-plan":
        return vscode.l10n.t(
          "The commit plan is invalid. Review every commit message and file assignment."
        );
      case "active-operation":
        return vscode.l10n.t(
          "Finish or abort the active Git operation before using an AI commit plan."
        );
      case "unsupported-head":
        return vscode.l10n.t(
          "AI commit plans require an existing commit on a checked-out local branch."
        );
      case "concurrent-change":
        return vscode.l10n.t(
          "HEAD or the Git index changed while the plan was running. External changes were preserved; refresh and regenerate the plan."
        );
      case "commit-tree-mismatch":
        return vscode.l10n.t(
          "The prepared commits did not match the approved plan. The real branch and Git index were preserved."
        );
      case "rollback-failed":
        return vscode.l10n.t(
          "The plan could not restore its earlier Git state. Review the repository before continuing."
        );
    }
    return vscode.l10n.t(
      "The AI commit plan could not be completed safely. Refresh the repository state and review the plan before trying again."
    );
  }
  const localized = PLAN_ERROR_TRANSLATIONS.get(message);
  if (localized) {
    return vscode.l10n.t(localized);
  }
  const unknownPath = /^Unknown (?:AI )?commit plan path: (.*)$/s.exec(message);
  if (unknownPath) {
    return vscode.l10n.t("Unknown commit plan path: {0}", unknownPath[1]);
  }
  if (
    /^(?:Commit plan|Commit group|The AI commit plan|Path is assigned|Plan does not assign|A commit group)/.test(
      message
    )
  ) {
    return vscode.l10n.t(
      "The commit plan is invalid. Review every commit message and file assignment."
    );
  }
  return message;
}

/** Git/순수 모델 경계를 VS Code 비의존으로 유지하면서 대표 오류만 UI에서 지역화하는 대응표다. */
const PLAN_ERROR_TRANSLATIONS = new Map<string, string>([
  ["There are no staged changes to plan.", "There are no staged changes to plan."],
  ["There are no changes to plan.", "There are no changes to plan."],
  [
    "Resolve merge conflicts before creating an AI commit plan.",
    "Resolve merge conflicts before creating an AI commit plan.",
  ],
  [
    "AI commit planning needs at least two changed files in the selected commit scope.",
    "AI commit planning needs at least two changed files in the selected commit scope.",
  ],
  [
    "Changes were modified after the AI commit plan was created. Generate the plan again.",
    "Changes were modified after the AI commit plan was created. Generate the plan again.",
  ],
]);
