// Claude Code / Codex CLI 에 프롬프트를 보내고 응답을 받는 실행 모듈.
// - shell 을 거치지 않고 spawn 인자 배열을 사용해 프롬프트 quoting 문제를 피한다.
import { spawn } from "child_process";
import * as vscode from "vscode";
import {
  AI_CLI_PROVIDER_LABELS,
  AiCliConfig,
  AiCliProvider,
  readAiCliConfig,
} from "./cliConfig";
import { looksLikeAuthError } from "./cliDiscovery";
import { prepareAiCliLaunch } from "./cliProcess";
import { logError, logInfo, logWarn } from "../ui/outputLog";

/** CLI 실행 결과. */
export interface AiCliResponse {
  provider: AiCliProvider;
  text: string;
}

/** AI CLI 실행별 옵션. timeoutMs 가 null 이면 시간 제한 없이 취소 토큰만 따른다. */
export interface AiCliPromptOptions {
  timeoutMs?: number | null;
}

/** AI CLI 설정/설치 문제를 UI 에서 구분하기 위한 오류 타입. */
export class AiCliConfigurationError extends Error {}

/** AI CLI 로그인/인증 문제를 UI 에서 구분하기 위한 오류 타입. */
export class AiCliAuthenticationError extends Error {
  constructor(
    message: string,
    readonly provider: Exclude<AiCliProvider, "auto">
  ) {
    super(message);
  }
}

interface ProviderCommand {
  provider: AiCliProvider;
  command: string;
  args: string[];
}

const MAX_OUTPUT_CHARS = 200000;

/**
 * 현재 설정에 맞는 AI CLI 로 프롬프트를 보내고 응답 텍스트를 반환한다.
 * @param prompt CLI 로 전달할 사용자 프롬프트
 * @param cwd CLI 를 실행할 저장소 루트
 * @param token VS Code 취소 토큰
 */
export async function runAiCliPrompt(
  prompt: string,
  cwd: string,
  token: vscode.CancellationToken,
  options: AiCliPromptOptions = {}
): Promise<AiCliResponse> {
  const config = readAiCliConfig();
  const providers = providerOrder(config.provider);
  const notFound: string[] = [];
  const timeoutMs = options.timeoutMs === null
    ? undefined
    : options.timeoutMs ?? config.timeoutMs;
  for (const provider of providers) {
    const command = providerCommand(config, provider, cwd);
    try {
      logInfo("AI CLI prompt requested", {
        provider,
        command: command.command,
        cwd,
        timeoutMs: timeoutMs ?? "none",
      });
      const text = await runProviderCommand(command, prompt, cwd, timeoutMs, token);
      return { provider, text };
    } catch (error) {
      if (isCommandNotFound(error) && config.provider === "auto") {
        notFound.push(AI_CLI_PROVIDER_LABELS[provider]);
        logWarn("AI CLI command not found, trying next provider", {
          provider,
          command: command.command,
        });
        continue;
      }
      throw enrichProviderError(error, provider, command.command);
    }
  }
  throw new AiCliConfigurationError(
    vscode.l10n.t(
      "No AI CLI command was found. Configure Claude Code or Codex CLI in Git Simple Compare AI settings."
    ) + (notFound.length ? ` (${notFound.join(", ")})` : "")
  );
}

/**
 * 오류가 AI CLI 설정/설치 문제인지 확인한다.
 * @param error catch 로 받은 오류 값
 */
export function isAiCliConfigurationError(error: unknown): boolean {
  return error instanceof AiCliConfigurationError;
}

/**
 * 오류가 AI CLI 로그인 문제인지 확인한다.
 * @param error catch 로 받은 오류 값
 */
export function isAiCliAuthenticationError(
  error: unknown
): error is AiCliAuthenticationError {
  return error instanceof AiCliAuthenticationError;
}

/**
 * provider 설정에서 실제 시도 순서를 만든다.
 * @param provider 설정된 provider
 */
function providerOrder(provider: AiCliProvider): AiCliProvider[] {
  if (provider === "claude" || provider === "codex") {
    return [provider];
  }
  return ["claude", "codex"];
}

/**
 * provider 별 CLI 인자를 구성한다.
 * @param config 정규화된 AI CLI 설정
 * @param provider 실행할 provider
 * @param cwd 현재 저장소 루트
 */
function providerCommand(
  config: AiCliConfig,
  provider: AiCliProvider,
  cwd: string
): ProviderCommand {
  if (provider === "claude") {
    const args = [
      "-p",
      "--output-format",
      "text",
      "--no-session-persistence",
      "--tools",
      "",
    ];
    if (config.claudeModel) {
      args.push("--model", config.claudeModel);
    }
    if (config.claudeEffort) {
      args.push("--effort", config.claudeEffort);
    }
    if (config.claudeSystemPrompt) {
      args.push("--append-system-prompt", config.claudeSystemPrompt);
    }
    return { provider, command: config.claudeCommand, args };
  }

  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "-C",
    cwd,
  ];
  if (config.codexReasoningEffort) {
    args.push(
      "-c",
      `model_reasoning_effort="${config.codexReasoningEffort}"`
    );
  }
  if (config.codexModel) {
    args.push("--model", config.codexModel);
  }
  if (config.codexProfile) {
    args.push("--profile", config.codexProfile);
  }
  args.push("-");
  return { provider: "codex", command: config.codexCommand, args };
}

/**
 * child_process.spawn 으로 CLI 를 실행하고 stdout 을 모은다.
 * @param providerCommand 실행할 command/args 정보
 * @param prompt stdin 으로 전달할 프롬프트
 * @param cwd 프로세스 working directory
 * @param timeoutMs 실행 timeout. undefined 면 timeout 없이 취소 토큰만 사용한다.
 * @param token VS Code 취소 토큰
 */
async function runProviderCommand(
  providerCommand: ProviderCommand,
  prompt: string,
  cwd: string,
  timeoutMs: number | undefined,
  token: vscode.CancellationToken
): Promise<string> {
  const launch = await prepareAiCliLaunch(providerCommand.command);
  if (launch.resolvedCommand && launch.resolvedCommand !== providerCommand.command) {
    logInfo("AI CLI command resolved", {
      provider: providerCommand.provider,
      command: providerCommand.command,
      resolvedCommand: launch.resolvedCommand,
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, providerCommand.args, {
      cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timeout = timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          finish(
            new Error(
              vscode.l10n.t("AI CLI timed out after {0}ms.", String(timeoutMs))
            )
          );
        }, timeoutMs);
    const cancelSub = token.onCancellationRequested(() => {
      finish(new Error(vscode.l10n.t("AI CLI request cancelled.")));
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => finish(error));
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => {
      if (code === 0) {
        finish(undefined, cleanProcessOutput(stdout));
        return;
      }
      const detail = cleanProcessOutput(stderr || stdout);
      finish(
        new Error(
          detail
            ? vscode.l10n.t("AI CLI exited with code {0}: {1}", String(code), detail)
            : vscode.l10n.t("AI CLI exited with code {0}.", String(code))
        )
      );
    });

    child.stdin.end(prompt);

    function finish(error?: unknown, text?: string): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      cancelSub.dispose();
      if (!child.killed) {
        child.kill();
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(text ?? "");
    }
  });
}

/**
 * provider 정보를 붙여 사용자에게 더 명확한 오류로 변환한다.
 * @param error 원본 오류
 * @param provider 실행 provider
 * @param command 실행 command
 */
function enrichProviderError(
  error: unknown,
  provider: AiCliProvider,
  command: string
): Error {
  if (isCommandNotFound(error)) {
    return new AiCliConfigurationError(
      vscode.l10n.t(
        "{0} CLI command was not found: {1}",
        AI_CLI_PROVIDER_LABELS[provider],
        command
      )
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  if (looksLikeAuthError(message) && provider !== "auto") {
    return new AiCliAuthenticationError(
      vscode.l10n.t(
        "{0} is not logged in. Sign in to continue.",
        AI_CLI_PROVIDER_LABELS[provider]
      ),
      provider
    );
  }
  logError("AI CLI prompt failed", error, { provider, command });
  return error instanceof Error ? error : new Error(message);
}

/**
 * spawn 실패가 command not found 인지 판별한다.
 * @param error 원본 오류
 */
function isCommandNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * ANSI 제어 문자와 양끝 공백을 제거한다.
 * @param value CLI 출력
 */
function cleanProcessOutput(value: string): string {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .trim();
}

/**
 * 긴 stdout/stderr 가 extension host 메모리를 과도하게 쓰지 않도록 자른다.
 * @param current 지금까지 모은 문자열
 * @param next 새 chunk 문자열
 */
function appendBounded(current: string, next: string): string {
  const value = current + next;
  if (value.length <= MAX_OUTPUT_CHARS) {
    return value;
  }
  return value.slice(value.length - MAX_OUTPUT_CHARS);
}
