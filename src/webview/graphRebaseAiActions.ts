// graph interactive rebase 의 AI 계획 생성 흐름을 담당한다.
// - graphPanel.ts 는 메시지 라우팅만 유지하고, 경고/진행/AI 오류 처리는 이 모듈에 둔다.
import * as vscode from "vscode";
import {
  aiRebaseUsageWarning,
  AiRebasePlanRequest,
  AiRebasePlanResult,
  generateAiRebasePlan,
} from "../ai/rebasePlanner";
import {
  isAiCliAuthenticationError,
  isAiCliConfigurationError,
} from "../ai/cliRunner";
import { GitLogService } from "../git/gitLogService";
import { logError } from "../ui/outputLog";

/** AI rebase 실행에 필요한 그래프 의존성 */
export interface GraphRebaseAiDeps {
  logService: GitLogService;
}

/**
 * 현재 graph rebase 계획을 AI 로 보강한다.
 * @param request 웹뷰가 보낸 현재 rebase 계획 스냅샷
 * @param deps 그래프 패널 의존성
 * @returns 적용 가능한 AI rebase 제안. 사용자가 취소하면 undefined
 */
export async function generateGraphRebaseAiPlan(
  request: AiRebasePlanRequest,
  deps: GraphRebaseAiDeps
): Promise<AiRebasePlanResult | undefined> {
  const warning = aiRebaseUsageWarning(request);
  if (warning && !await confirmLargeAiRebase(warning)) {
    return undefined;
  }
  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Generating AI rebase plan..."),
        cancellable: true,
      },
      (_progress, token) => generateAiRebasePlan(
        request,
        deps.logService.repoRoot,
        token
      )
    );
  } catch (error) {
    logError("AI rebase plan generation failed", error, {
      repoRoot: deps.logService.repoRoot,
      commits: request.commits.length,
    });
    await showAiRebaseError(error);
    return undefined;
  }
}

/**
 * 큰 AI rebase 요청 전에 토큰 사용량 경고를 보여준다.
 * @param message aiRebaseUsageWarning 이 만든 상세 메시지
 */
async function confirmLargeAiRebase(message: string): Promise<boolean> {
  const proceed = vscode.l10n.t("Continue");
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    proceed
  );
  return choice === proceed;
}

/**
 * AI CLI 오류를 사용자에게 보여주고 필요하면 설정/로그인 액션을 제공한다.
 * @param error 원본 오류
 */
async function showAiRebaseError(error: unknown): Promise<void> {
  const configure = vscode.l10n.t("Configure AI CLI");
  const login = vscode.l10n.t("Login to AI CLI");
  const message = vscode.l10n.t("AI rebase plan failed: {0}", errorText(error));
  const choice = isAiCliAuthenticationError(error)
    ? await vscode.window.showErrorMessage(message, login, configure)
    : isAiCliConfigurationError(error)
      ? await vscode.window.showErrorMessage(message, configure)
      : await vscode.window.showErrorMessage(message);
  if (choice === login && isAiCliAuthenticationError(error)) {
    await vscode.commands.executeCommand(
      "gitSimpleCompare.loginAiCli",
      error.provider
    );
    return;
  }
  if (choice === configure) {
    await vscode.commands.executeCommand("gitSimpleCompare.configureAiCli");
  }
}

/** 알 수 없는 오류 값을 사용자 표시 문자열로 바꾼다. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
