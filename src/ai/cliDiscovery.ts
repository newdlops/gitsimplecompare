// AI CLI 의 로그인 상태와 모델 후보를 탐색하는 모듈.
// - 실제 생성 실행(cliRunner)과 설정 UI(aiSettings)가 공유할 수 있게 순수 CLI 조회만 담당한다.
import { spawn } from "child_process";
import * as vscode from "vscode";
import {
  AiCliProvider,
  readAiCliConfig,
  type AiClaudeLoginMode,
  type AiCliConfig,
  type AiCodexLoginMode,
  type AiReasoningEffort,
} from "./cliConfig";

/** 로그인 상태 조회 결과. */
export interface AiCliLoginStatus {
  provider: AiCliProvider;
  state: "signed-in" | "signed-out" | "unknown";
  detail: string;
}

/** 모델 후보 조회 결과. */
export interface AiCliModelDiscovery {
  provider: AiCliProvider;
  models: AiCliModelOption[];
  reasoningEfforts: AiCliReasoningOption[];
  detail: string;
}

/** CLI 에서 읽은 모델 후보. */
export interface AiCliModelOption {
  id: string;
  label: string;
  detail: string;
  defaultReasoningEffort: AiReasoningEffort;
  reasoningEfforts: AiCliReasoningOption[];
}

/** CLI 에서 읽은 추론 강도 후보. */
export interface AiCliReasoningOption {
  value: AiReasoningEffort;
  label: string;
  detail: string;
  isDefault?: boolean;
}

interface CommandSpec {
  command: string;
  args: string[];
}

interface LoginCommandOverride {
  claudeLoginMode?: AiClaudeLoginMode;
  codexLoginMode?: AiCodexLoginMode;
}

const LOGIN_TIMEOUT_MS = 20000;

/**
 * provider 별 로그인 상태를 조회한다.
 * @param provider 상태를 확인할 CLI provider
 */
export async function checkAiCliLoginStatus(
  provider: Exclude<AiCliProvider, "auto">
): Promise<AiCliLoginStatus> {
  const config = readAiCliConfig();
  const spec = statusCommand(config, provider);
  try {
    const result = await runCapture(spec, LOGIN_TIMEOUT_MS);
    const detail = cleanOutput(`${result.stdout}\n${result.stderr}`);
    return {
      provider,
      state: result.code === 0 ? "signed-in" : authStateFromText(detail),
      detail: detail || vscode.l10n.t("No status output."),
    };
  } catch (error) {
    return {
      provider,
      state: "unknown",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * provider 별 로그인 명령을 터미널용 command string 으로 만든다.
 * @param provider 로그인할 CLI provider
 * @param override 이번 로그인 실행에만 적용할 provider 별 로그인 방식
 */
export function loginCommandText(
  provider: Exclude<AiCliProvider, "auto">,
  override: LoginCommandOverride = {}
): string {
  const config = { ...readAiCliConfig(), ...override };
  const spec = loginCommand(config, provider);
  return [shellQuote(spec.command), ...spec.args.map(shellQuote)].join(" ");
}

/**
 * CLI help 에서 모델 후보를 추출한다.
 * @param provider 모델 후보를 읽을 CLI provider
 */
export async function discoverAiCliModels(
  provider: Exclude<AiCliProvider, "auto">
): Promise<AiCliModelDiscovery> {
  const config = readAiCliConfig();
  if (provider === "codex") {
    return discoverCodexModels(config);
  }
  return discoverClaudeModels(config);
}

/**
 * Claude Code help 에서 모델 alias 와 effort 후보를 읽는다.
 * @param config 현재 CLI 설정
 */
async function discoverClaudeModels(config: AiCliConfig): Promise<AiCliModelDiscovery> {
  const result = await runCapture(
    { command: config.claudeCommand, args: ["--help"] },
    LOGIN_TIMEOUT_MS
  );
  const text = cleanOutput(`${result.stdout}\n${result.stderr}`);
  const reasoningEfforts = extractClaudeReasoningOptions(text);
  const models = extractClaudeModels(text).map((model) => ({
    id: model,
    label: model,
    detail: vscode.l10n.t("Loaded from Claude Code CLI help."),
    defaultReasoningEffort: "" as AiReasoningEffort,
    reasoningEfforts,
  }));
  return {
    provider: "claude",
    models,
    reasoningEfforts,
    detail: models.length
      ? vscode.l10n.t("Loaded model names from Claude Code CLI help.")
      : vscode.l10n.t("This CLI did not expose model names."),
  };
}

/**
 * Codex model catalog JSON 에서 모델과 reasoning 후보를 읽는다.
 * @param config 현재 CLI 설정
 */
async function discoverCodexModels(config: AiCliConfig): Promise<AiCliModelDiscovery> {
  const attempts: CommandSpec[] = [
    { command: config.codexCommand, args: ["debug", "models"] },
    { command: config.codexCommand, args: ["debug", "models", "--bundled"] },
  ];
  const errors: string[] = [];
  for (const spec of attempts) {
    try {
      const result = await runCapture(spec, LOGIN_TIMEOUT_MS);
      const catalog = parseCodexModelCatalog(`${result.stdout}\n${result.stderr}`);
      if (catalog.models.length) {
        return catalog;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const fallback = await discoverCodexModelsFromHelp(config, errors.join("\n"));
  return fallback;
}

/**
 * Codex catalog 조회가 실패했을 때 help 출력에서 모델명만 보수적으로 추출한다.
 * @param config 현재 CLI 설정
 * @param errorDetail catalog 조회 오류 요약
 */
async function discoverCodexModelsFromHelp(
  config: AiCliConfig,
  errorDetail: string
): Promise<AiCliModelDiscovery> {
  const outputs: string[] = [errorDetail];
  for (const spec of [
    { command: config.codexCommand, args: ["--help"] },
    { command: config.codexCommand, args: ["exec", "--help"] },
  ]) {
    try {
      const result = await runCapture(spec, LOGIN_TIMEOUT_MS);
      outputs.push(cleanOutput(`${result.stdout}\n${result.stderr}`));
    } catch (error) {
      outputs.push(error instanceof Error ? error.message : String(error));
    }
  }
  const models = extractCodexModels(outputs.join("\n")).map((model) => ({
    id: model,
    label: model,
    detail: vscode.l10n.t("Loaded from Codex CLI help."),
    defaultReasoningEffort: "" as AiReasoningEffort,
    reasoningEfforts: [],
  }));
  return {
    provider: "codex",
    models,
    reasoningEfforts: [],
    detail: models.length
      ? vscode.l10n.t("Loaded model names from Codex CLI help.")
      : vscode.l10n.t("This CLI did not expose model names."),
  };
}

/**
 * 인증 오류로 보이는 CLI 출력인지 판단한다.
 * @param text CLI stdout/stderr 또는 오류 메시지
 */
export function looksLikeAuthError(text: string): boolean {
  return /not\s+(logged|signed)\s+in|login required|authentication|unauthorized|api key|oauth|auth\b/i.test(text);
}

/**
 * provider 별 status 명령을 구성한다.
 * @param config 현재 CLI 설정
 * @param provider 대상 provider
 */
function statusCommand(
  config: AiCliConfig,
  provider: Exclude<AiCliProvider, "auto">
): CommandSpec {
  return provider === "claude"
    ? { command: config.claudeCommand, args: ["auth", "status"] }
    : { command: config.codexCommand, args: ["login", "status"] };
}

/**
 * provider 별 login 명령을 구성한다.
 * @param config 현재 CLI 설정
 * @param provider 대상 provider
 */
function loginCommand(
  config: AiCliConfig,
  provider: Exclude<AiCliProvider, "auto">
): CommandSpec {
  if (provider === "claude") {
    if (config.claudeLoginMode === "setup-token") {
      return { command: config.claudeCommand, args: ["setup-token"] };
    }
    const args = ["auth", "login"];
    if (config.claudeLoginMode === "console") {
      args.push("--console");
    } else if (config.claudeLoginMode === "sso") {
      args.push("--sso");
    } else {
      args.push("--claudeai");
    }
    return { command: config.claudeCommand, args };
  }

  if (config.codexLoginMode === "device") {
    return { command: config.codexCommand, args: ["login", "--device-auth"] };
  }
  if (config.codexLoginMode === "api-key") {
    return {
      command: "sh",
      args: [
        "-lc",
        codexTokenLoginScript(
          "OPENAI_API_KEY",
          config.codexCommand,
          "--with-api-key"
        ),
      ],
    };
  }
  if (config.codexLoginMode === "access-token") {
    return {
      command: "sh",
      args: [
        "-lc",
        codexTokenLoginScript(
          "CODEX_ACCESS_TOKEN",
          config.codexCommand,
          "--with-access-token"
        ),
      ],
    };
  }
  return { command: config.codexCommand, args: ["login"] };
}

/**
 * Codex token 기반 로그인을 위한 shell script 를 만든다.
 * @param envName token 을 읽을 환경변수 이름
 * @param codexCommand Codex 실행 파일 이름 또는 경로
 * @param flag Codex login 에 전달할 token login flag
 */
function codexTokenLoginScript(
  envName: "OPENAI_API_KEY" | "CODEX_ACCESS_TOKEN",
  codexCommand: string,
  flag: "--with-api-key" | "--with-access-token"
): string {
  return [
    `if [ -z "$${envName}" ]; then`,
    `echo "Set ${envName} in this terminal first.";`,
    "exit 1;",
    "fi;",
    `printf %s "$${envName}" | ${shellQuote(codexCommand)} login ${flag}`,
  ].join(" ");
}

interface CodexCatalogModel {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  visibility?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: Array<{
    effort?: unknown;
    description?: unknown;
  }>;
}

/**
 * Codex model catalog JSON 을 설정 UI 에 맞는 후보 목록으로 변환한다.
 * @param raw Codex CLI stdout/stderr
 */
function parseCodexModelCatalog(raw: string): AiCliModelDiscovery {
  const parsed = JSON.parse(extractJsonObject(raw)) as { models?: CodexCatalogModel[] };
  const models = Array.isArray(parsed.models) ? parsed.models : [];
  const options = models
    .filter((model) => typeof model.slug === "string" && model.visibility !== "hide")
    .map((model) => codexModelOption(model));
  return {
    provider: "codex",
    models: options,
    reasoningEfforts: mergeReasoningOptions(options),
    detail: options.length
      ? vscode.l10n.t("Loaded model names from Codex model catalog.")
      : vscode.l10n.t("This CLI did not expose model names."),
  };
}

/**
 * Codex catalog model 하나를 QuickPick 에 표시할 옵션으로 변환한다.
 * @param model Codex model catalog entry
 */
function codexModelOption(model: CodexCatalogModel): AiCliModelOption {
  const defaultReasoningEffort = normalizeEffort(model.default_reasoning_level);
  const reasoningEfforts = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
        .map((level) => ({
          value: normalizeEffort(level.effort),
          label: String(level.effort ?? ""),
          detail: typeof level.description === "string" ? level.description : "",
          isDefault: normalizeEffort(level.effort) === defaultReasoningEffort,
        }))
        .filter((level) => level.value !== "")
    : [];
  return {
    id: String(model.slug),
    label: typeof model.display_name === "string"
      ? model.display_name
      : String(model.slug),
    detail: typeof model.description === "string" ? model.description : "",
    defaultReasoningEffort,
    reasoningEfforts,
  };
}

/**
 * CLI 출력 앞뒤에 경고가 섞여도 첫 JSON 객체만 파싱할 수 있게 잘라낸다.
 * @param raw CLI 출력
 */
function extractJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(vscode.l10n.t("AI CLI did not return JSON model metadata."));
  }
  return raw.slice(start, end + 1);
}

/**
 * 여러 모델의 reasoning 후보를 중복 제거해 합친다.
 * @param models 모델 후보 목록
 */
function mergeReasoningOptions(models: AiCliModelOption[]): AiCliReasoningOption[] {
  const byValue = new Map<AiReasoningEffort, AiCliReasoningOption>();
  for (const model of models) {
    for (const option of model.reasoningEfforts) {
      if (!byValue.has(option.value)) {
        byValue.set(option.value, option);
      }
    }
  }
  return [...byValue.values()];
}

/**
 * Claude help 출력에서 모델 alias/full name 후보를 뽑는다.
 * @param text help 출력
 */
function extractClaudeModels(text: string): string[] {
  return uniqueMatches(text, [
    /\b(fable|opus|sonnet)\b/g,
    /\bclaude-[a-z0-9][a-z0-9.-]*\b/g,
  ]);
}

/**
 * Claude help 출력에서 --effort 후보를 뽑는다.
 * @param text help 출력
 */
function extractClaudeReasoningOptions(text: string): AiCliReasoningOption[] {
  const match = text.match(/--effort\s+<level>[\s\S]*?\(([^)]+)\)/);
  const values = match
    ? match[1].split(",").map((value) => value.trim())
    : [];
  return values
    .map((value) => normalizeEffort(value))
    .filter((value) => value !== "")
    .map((value) => ({
      value,
      label: value,
      detail: vscode.l10n.t("Loaded from Claude Code CLI help."),
    }));
}

/**
 * Codex help 출력에서 모델명 후보를 뽑는다.
 * @param text help 출력
 */
function extractCodexModels(text: string): string[] {
  return uniqueMatches(text, [
    /\b(gpt-[a-z0-9][a-z0-9.-]*|o[0-9][a-z0-9.-]*|codex-[a-z0-9][a-z0-9.-]*)\b/g,
  ]);
}

/**
 * 여러 정규식의 match 를 중복 제거해 반환한다.
 * @param text 검색할 텍스트
 * @param patterns 모델명 후보 정규식
 */
function uniqueMatches(text: string, patterns: RegExp[]): string[] {
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      seen.add(match[0]);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * CLI 에서 받은 effort 문자열을 지원 범위 안으로 보정한다.
 * @param value CLI 원본 값
 */
function normalizeEffort(value: unknown): AiReasoningEffort {
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }
  return "";
}

/**
 * 상태 출력 문구를 느슨하게 해석한다.
 * @param text CLI status 출력
 */
function authStateFromText(text: string): AiCliLoginStatus["state"] {
  if (/logged in|signed in|authenticated/i.test(text)) {
    return "signed-in";
  }
  if (looksLikeAuthError(text) || /not configured|no credentials/i.test(text)) {
    return "signed-out";
  }
  return "unknown";
}

/**
 * 명령을 실행해 stdout/stderr 와 종료 코드를 얻는다.
 * @param spec 실행 명령
 * @param timeoutMs timeout(ms)
 */
function runCapture(
  spec: CommandSpec,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(vscode.l10n.t("AI CLI status command timed out.")));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 터미널에 안전하게 보낼 수 있도록 shell token 을 quote 한다.
 * @param value 원본 token
 */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * ANSI 제어 문자와 양끝 공백을 제거한다.
 * @param value CLI 출력
 */
function cleanOutput(value: string): string {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .trim();
}
