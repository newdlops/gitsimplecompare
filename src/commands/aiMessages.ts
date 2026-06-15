// AI 기반 커밋 메시지 생성 명령 핸들러.
// - UI 이벤트는 여기로 모으고, git 컨텍스트 수집과 모델 호출은 하위 모듈에 위임한다.
import * as vscode from "vscode";
import {
  isAiCliAuthenticationError,
  isAiCliConfigurationError,
} from "../ai/cliRunner";
import { generateAiCommitMessage } from "../ai/messageGenerator";
import { readCommitMessageContext } from "../git/aiMessageContext";
import { logError, logInfo } from "../ui/outputLog";
import { CommandDeps, resolveCompareService } from "./shared";

/**
 * 현재 staged 변경을 바탕으로 AI 커밋 메시지를 생성해 입력창에 넣는다.
 * @param deps 명령 공유 의존성
 */
export async function generateCommitMessage(
  deps: CommandDeps
): Promise<void> {
  const service = await resolveCompareService(deps);
  if (!service) {
    return;
  }
  try {
    const message = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Generating AI commit message..."),
        cancellable: true,
      },
      async (_progress, token) => {
        const context = await readCommitMessageContext(service.repoRoot);
        return generateAiCommitMessage(context, token);
      }
    );
    deps.changesView.setCommitMessage(message);
    logInfo("AI commit message inserted", {
      repoRoot: service.repoRoot,
      length: message.length,
    });
  } catch (error) {
    logError("AI commit message generation failed", error, {
      repoRoot: service.repoRoot,
    });
    await showAiError("AI commit message generation failed: {0}", error);
  }
}

/**
 * AI 오류를 보여주고 설정 오류라면 설정 UI 버튼을 제공한다.
 * @param template 지역화 메시지 템플릿
 * @param error 원본 오류
 */
async function showAiError(template: string, error: unknown): Promise<void> {
  const configure = vscode.l10n.t("Configure AI CLI");
  const login = vscode.l10n.t("Login to AI CLI");
  const message = vscode.l10n.t(template, errText(error));
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

/**
 * 알 수 없는 오류 값을 사용자에게 보여줄 짧은 문자열로 변환한다.
 * @param error catch 로 받은 오류 값
 */
function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
