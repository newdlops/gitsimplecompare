// AI CLI 상세 설정 UI 명령.
// - 메시지 생성 명령과 분리해 provider/모델/프롬프트 설정 흐름을 독립적으로 관리한다.
import * as vscode from "vscode";
import {
  AI_CLI_PROVIDER_LABELS,
  readAiCliConfig,
  type AiCliConfig,
  type AiClaudeLoginMode,
  type AiCodexLoginMode,
  type AiCliProvider,
} from "../ai/cliConfig";
import {
  checkAiCliLoginStatus,
  loginCommandText,
} from "../ai/cliDiscovery";
import { runAiCliPrompt } from "../ai/cliRunner";
import { logError } from "../ui/outputLog";
import { CommandDeps, resolveCompareService } from "./shared";
import {
  formatReasoningEffort,
  pickModelAndReasoning,
} from "./aiSettingsPickers";

type SettingKey =
  | "aiCliProvider"
  | "aiClaudeCommand"
  | "aiClaudeModel"
  | "aiClaudeEffort"
  | "aiClaudeSystemPrompt"
  | "aiClaudeLoginMode"
  | "aiCodexCommand"
  | "aiCodexModel"
  | "aiCodexReasoningEffort"
  | "aiCodexProfile"
  | "aiCodexLoginMode"
  | "aiResponseLanguage"
  | "aiCommonInstructions"
  | "aiCommitInstructions"
  | "aiPullRequestInstructions"
  | "aiCliTimeoutMs";

/**
 * AI CLI 설정 메뉴를 연다.
 * @param deps 명령 공유 의존성
 */
export async function configureAiCli(deps: CommandDeps): Promise<void> {
  while (true) {
    const config = readAiCliConfig();
    const picked = await vscode.window.showQuickPick(menuItems(config), {
      title: vscode.l10n.t("AI CLI Settings"),
      placeHolder: vscode.l10n.t("Choose a setting group."),
    });
    if (!picked) {
      return;
    }
    if (picked.id === "provider") {
      await configureProvider(config.provider);
    } else if (picked.id === "login") {
      await configureLogin(config);
    } else if (picked.id === "claude") {
      await configureClaude(config);
    } else if (picked.id === "codex") {
      await configureCodex(config);
    } else if (picked.id === "prompt") {
      await configurePromptDefaults(config);
    } else if (picked.id === "timeout") {
      await configureTimeout(config.timeoutMs);
    } else if (picked.id === "test") {
      await testAiCli(deps);
    } else if (picked.id === "settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "gitSimpleCompare.ai"
      );
    }
  }
}

/**
 * 메뉴 항목을 현재 설정 요약과 함께 만든다.
 * @param config 현재 AI CLI 설정
 */
function menuItems(config: AiCliConfig): Array<vscode.QuickPickItem & { id: string }> {
  return [
    {
      id: "provider",
      label: "$(sparkle) " + vscode.l10n.t("Provider"),
      description: AI_CLI_PROVIDER_LABELS[config.provider],
      detail: vscode.l10n.t("Choose Auto, Claude Code, or Codex."),
    },
    {
      id: "login",
      label: "$(account) " + vscode.l10n.t("Login / Status"),
      detail: vscode.l10n.t("Check auth status or start CLI login."),
    },
    {
      id: "claude",
      label: "$(claude) " + vscode.l10n.t("Claude Code"),
      description: config.claudeModel || vscode.l10n.t("CLI default model"),
      detail: `${config.claudeCommand} / ${config.claudeLoginMode} / ${formatReasoningEffort(config.claudeEffort)}${config.claudeSystemPrompt ? " + prompt" : ""}`,
    },
    {
      id: "codex",
      label: "$(openai) " + vscode.l10n.t("Codex"),
      description: config.codexModel || vscode.l10n.t("CLI default model"),
      detail: config.codexProfile
        ? `${config.codexCommand} / ${config.codexLoginMode} / ${formatReasoningEffort(config.codexReasoningEffort)} / profile ${config.codexProfile}`
        : `${config.codexCommand} / ${config.codexLoginMode} / ${formatReasoningEffort(config.codexReasoningEffort)}`,
    },
    {
      id: "prompt",
      label: "$(comment-discussion-sparkle) " + vscode.l10n.t("Prompt Defaults"),
      description: config.responseLanguage,
      detail: vscode.l10n.t("Language and extra instructions for commit/PR prompts."),
    },
    {
      id: "timeout",
      label: "$(watch) " + vscode.l10n.t("Timeout"),
      description: `${config.timeoutMs}ms`,
    },
    {
      id: "test",
      label: "$(debug-start) " + vscode.l10n.t("Test AI CLI"),
      detail: vscode.l10n.t("Send a short prompt to the configured CLI."),
    },
    {
      id: "settings",
      label: "$(settings-gear) " + vscode.l10n.t("Open VS Code Settings"),
      detail: vscode.l10n.t("Edit all AI settings in the Settings UI."),
    },
  ];
}

/**
 * provider 선택 설정을 바꾼다.
 * @param current 현재 provider
 */
async function configureProvider(current: AiCliProvider): Promise<void> {
  const items: Array<vscode.QuickPickItem & { value: AiCliProvider }> = [
    {
      label: "$(sparkle) Auto",
      description: current === "auto" ? vscode.l10n.t("Current") : undefined,
      detail: vscode.l10n.t("Try Claude Code first, then Codex."),
      value: "auto",
    },
    {
      label: "$(claude) Claude Code",
      description: current === "claude" ? vscode.l10n.t("Current") : undefined,
      detail: vscode.l10n.t("Run claude -p and read the response."),
      value: "claude",
    },
    {
      label: "$(openai) Codex",
      description: current === "codex" ? vscode.l10n.t("Current") : undefined,
      detail: vscode.l10n.t("Run codex exec and read the response."),
      value: "codex",
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("AI CLI Provider"),
  });
  if (picked) {
    await updateConfig("aiCliProvider", picked.value);
  }
}

/**
 * Claude Code CLI 세부 설정을 순서대로 입력받는다.
 * @param config 현재 AI CLI 설정
 */
async function configureClaude(config: AiCliConfig): Promise<void> {
  await configureString(
    "aiClaudeCommand",
    vscode.l10n.t("Claude Code CLI command"),
    config.claudeCommand,
    vscode.l10n.t("Executable name or absolute path.")
  );
  await updateConfig(
    "aiClaudeLoginMode",
    await pickClaudeLoginMode(config.claudeLoginMode)
  );
  const modelChoice = await pickModelAndReasoning(
    "claude",
    config.claudeModel,
    config.claudeEffort
  );
  await updateConfig("aiClaudeModel", modelChoice.model);
  await updateConfig("aiClaudeEffort", modelChoice.reasoningEffort);
  await configureString(
    "aiClaudeSystemPrompt",
    vscode.l10n.t("Claude Code system prompt"),
    config.claudeSystemPrompt,
    vscode.l10n.t("Optional prompt appended with --append-system-prompt.")
  );
}

/**
 * Codex CLI 세부 설정을 순서대로 입력받는다.
 * @param config 현재 AI CLI 설정
 */
async function configureCodex(config: AiCliConfig): Promise<void> {
  await configureString(
    "aiCodexCommand",
    vscode.l10n.t("Codex CLI command"),
    config.codexCommand,
    vscode.l10n.t("Executable name or absolute path.")
  );
  await updateConfig(
    "aiCodexLoginMode",
    await pickCodexLoginMode(config.codexLoginMode)
  );
  const modelChoice = await pickModelAndReasoning(
    "codex",
    config.codexModel,
    config.codexReasoningEffort
  );
  await updateConfig("aiCodexModel", modelChoice.model);
  await updateConfig("aiCodexReasoningEffort", modelChoice.reasoningEffort);
  await configureString(
    "aiCodexProfile",
    vscode.l10n.t("Codex profile"),
    config.codexProfile,
    vscode.l10n.t("Optional Codex config profile passed with --profile.")
  );
}

/**
 * Claude Code 로그인 방식을 선택한다.
 * @param current 현재 로그인 방식
 */
async function pickClaudeLoginMode(
  current: AiClaudeLoginMode
): Promise<AiClaudeLoginMode> {
  const items: Array<vscode.QuickPickItem & { value: AiClaudeLoginMode }> = [
    {
      label: "Claude subscription",
      description: current === "claudeai" ? vscode.l10n.t("Current") : undefined,
      detail: vscode.l10n.t("Run claude auth login --claudeai."),
      value: "claudeai",
    },
    {
      label: "Anthropic Console",
      description: current === "console" ? vscode.l10n.t("Current") : undefined,
      detail: vscode.l10n.t("Run claude auth login --console."),
      value: "console",
    },
    {
      label: "SSO",
      description: current === "sso" ? vscode.l10n.t("Current") : undefined,
      detail: vscode.l10n.t("Run claude auth login --sso."),
      value: "sso",
    },
    {
      label: "Setup token",
      description: current === "setup-token" ? vscode.l10n.t("Current") : undefined,
      detail: vscode.l10n.t("Run claude setup-token when browser callback login fails."),
      value: "setup-token",
    },
  ];
  return (await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("Claude Code login method"),
  }))?.value ?? current;
}

/**
 * Codex 로그인 방식을 선택한다.
 * @param current 현재 로그인 방식
 */
async function pickCodexLoginMode(
  current: AiCodexLoginMode
): Promise<AiCodexLoginMode> {
  const items: Array<vscode.QuickPickItem & { value: AiCodexLoginMode }> = [
    {
      label: "Device auth",
      description: current === "device" ? vscode.l10n.t("Current") : undefined,
      detail: vscode.l10n.t(
        "Run codex login --device-auth when browser callback login fails."
      ),
      value: "device",
    },
    {
      label: "Browser login",
      description: current === "browser" ? vscode.l10n.t("Current") : undefined,
      detail: vscode.l10n.t("Run codex login."),
      value: "browser",
    },
    {
      label: "OPENAI_API_KEY",
      description: current === "api-key" ? vscode.l10n.t("Current") : undefined,
      detail: vscode.l10n.t("Pipe OPENAI_API_KEY into codex login --with-api-key."),
      value: "api-key",
    },
    {
      label: "CODEX_ACCESS_TOKEN",
      description: current === "access-token" ? vscode.l10n.t("Current") : undefined,
      detail: vscode.l10n.t("Pipe CODEX_ACCESS_TOKEN into codex login --with-access-token."),
      value: "access-token",
    },
  ];
  return (await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("Codex login method"),
  }))?.value ?? current;
}

/**
 * 로그인 상태 확인 및 로그인 명령 실행 UX 를 제공한다.
 * @param config 현재 AI CLI 설정
 */
async function configureLogin(config: AiCliConfig): Promise<void> {
  const provider = await pickConcreteProvider(
    config.provider === "auto" ? undefined : config.provider
  );
  if (!provider) {
    return;
  }
  const status = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Checking AI CLI login status..."),
      cancellable: false,
    },
    () => checkAiCliLoginStatus(provider)
  );
  const login = vscode.l10n.t("Run Login");
  const refresh = vscode.l10n.t("Refresh Status");
  const message = vscode.l10n.t(
    "{0} login status: {1}",
    AI_CLI_PROVIDER_LABELS[provider],
    status.state
  );
  const choice = await vscode.window.showInformationMessage(
    message,
    { modal: false, detail: status.detail },
    login,
    refresh
  );
  if (choice === login) {
    await loginAiCli(provider);
  } else if (choice === refresh) {
    await configureLogin({ ...config, provider });
  }
}

/**
 * 오류 처리나 설정 메뉴에서 AI CLI 로그인 터미널을 연다.
 * @param provider 로그인할 provider. 없으면 사용자가 선택한다.
 */
export async function loginAiCli(
  provider?: Exclude<AiCliProvider, "auto">
): Promise<void> {
  const target = provider ?? await pickConcreteProvider();
  if (!target) {
    return;
  }
  const terminal = vscode.window.createTerminal({
    name: `Git Simple Compare ${AI_CLI_PROVIDER_LABELS[target]} Login`,
  });
  const config = readAiCliConfig();
  const override = target === "claude"
    ? { claudeLoginMode: await pickClaudeLoginMode(config.claudeLoginMode) }
    : { codexLoginMode: await pickCodexLoginMode(config.codexLoginMode) };
  if (override.claudeLoginMode) {
    await updateConfig("aiClaudeLoginMode", override.claudeLoginMode);
  }
  if (override.codexLoginMode) {
    await updateConfig("aiCodexLoginMode", override.codexLoginMode);
  }
  terminal.show();
  terminal.sendText(loginCommandText(target, override));
}

/**
 * Claude/Codex 중 하나를 선택한다.
 * @param current 현재 선택값
 */
async function pickConcreteProvider(
  current?: Exclude<AiCliProvider, "auto">
): Promise<Exclude<AiCliProvider, "auto"> | undefined> {
  const items: Array<vscode.QuickPickItem & { value: Exclude<AiCliProvider, "auto"> }> = [
    {
      label: "$(claude) Claude Code",
      description: current === "claude" ? vscode.l10n.t("Current") : undefined,
      value: "claude",
    },
    {
      label: "$(openai) Codex",
      description: current === "codex" ? vscode.l10n.t("Current") : undefined,
      value: "codex",
    },
  ];
  return (await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("Choose AI CLI provider"),
  }))?.value;
}

/**
 * 프롬프트 기본값과 추가 지시문을 설정한다.
 * @param config 현재 AI CLI 설정
 */
async function configurePromptDefaults(config: AiCliConfig): Promise<void> {
  await configureString(
    "aiResponseLanguage",
    vscode.l10n.t("AI response language"),
    config.responseLanguage,
    vscode.l10n.t("Example: English, Korean, or Korean with English technical terms.")
  );
  await configureString(
    "aiCommonInstructions",
    vscode.l10n.t("Common prompt instructions"),
    config.commonInstructions,
    vscode.l10n.t("Applied to both commit and PR prompts.")
  );
  await configureString(
    "aiCommitInstructions",
    vscode.l10n.t("Commit prompt instructions"),
    config.commitInstructions,
    vscode.l10n.t("Applied only to commit message generation.")
  );
  await configureString(
    "aiPullRequestInstructions",
    vscode.l10n.t("Pull request prompt instructions"),
    config.pullRequestInstructions,
    vscode.l10n.t("Applied only to PR title/body generation.")
  );
}

/**
 * 문자열 설정 하나를 input box 로 편집한다.
 * @param key 설정 key
 * @param title 입력창 제목
 * @param current 현재 값
 * @param prompt 입력 안내 문구
 */
async function configureString(
  key: SettingKey,
  title: string,
  current: string,
  prompt: string
): Promise<void> {
  const value = await vscode.window.showInputBox({
    title,
    value: current,
    prompt,
  });
  if (value !== undefined) {
    await updateConfig(key, value.trim());
  }
}

/**
 * CLI timeout 을 입력받아 저장한다.
 * @param current 현재 timeout(ms)
 */
async function configureTimeout(current: number): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: vscode.l10n.t("AI CLI timeout in milliseconds"),
    value: String(current),
    prompt: vscode.l10n.t("Use at least 10000ms."),
    validateInput: (raw) => {
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed >= 10000
        ? undefined
        : vscode.l10n.t("Enter a number greater than or equal to 10000.");
    },
  });
  if (value !== undefined) {
    await updateConfig("aiCliTimeoutMs", Number(value));
  }
}

/**
 * 현재 설정으로 짧은 프롬프트를 보내 CLI 연결을 검증한다.
 * @param deps 명령 공유 의존성
 */
async function testAiCli(deps: CommandDeps): Promise<void> {
  const cwd = await aiWorkingDirectory(deps);
  try {
    const response = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Testing AI CLI..."),
        cancellable: true,
      },
      (_progress, token) =>
        runAiCliPrompt(
          "Reply with exactly: Git Simple Compare AI CLI OK",
          cwd,
          token
        )
    );
    vscode.window.showInformationMessage(
      vscode.l10n.t(
        "AI CLI test succeeded with {0}.",
        response.provider === "claude" ? "Claude Code" : "Codex"
      )
    );
  } catch (error) {
    logError("AI CLI test failed", error, { cwd });
    vscode.window.showErrorMessage(
      vscode.l10n.t("AI CLI test failed: {0}", errText(error))
    );
  }
}

/**
 * 설정 값을 사용자 전역 설정에 저장한다.
 * @param key 설정 key
 * @param value 저장할 값
 */
async function updateConfig(key: SettingKey, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration("gitSimpleCompare")
    .update(key, value, vscode.ConfigurationTarget.Global);
}

/**
 * AI CLI 를 실행할 working directory 를 고른다.
 * @param deps 명령 공유 의존성
 */
async function aiWorkingDirectory(deps: CommandDeps): Promise<string> {
  const service = await resolveCompareService(deps);
  return service?.repoRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

/** 오류 값을 사용자에게 보여줄 짧은 문자열로 바꾼다. */
function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
