// AI CLI 설정을 읽고 정규화하는 모듈.
// - 명령 레이어와 생성 로직이 VS Code configuration key 를 직접 알지 않도록 분리한다.
import * as vscode from "vscode";

/** 확장에서 지원하는 AI CLI provider. */
export type AiCliProvider = "auto" | "claude" | "codex";

/** Claude Code 로그인 방식. */
export type AiClaudeLoginMode = "claudeai" | "console" | "sso" | "setup-token";

/** Codex 로그인 방식. */
export type AiCodexLoginMode = "browser" | "device" | "api-key" | "access-token";

/** AI CLI 가 지원하는 추론 강도. 빈 값은 CLI 기본값을 의미한다. */
export type AiReasoningEffort = "" | "low" | "medium" | "high" | "xhigh" | "max";

/** AI CLI 실행에 필요한 설정 묶음. */
export interface AiCliConfig {
  provider: AiCliProvider;
  claudeCommand: string;
  claudeModel: string;
  claudeEffort: AiReasoningEffort;
  claudeSystemPrompt: string;
  claudeLoginMode: AiClaudeLoginMode;
  codexCommand: string;
  codexModel: string;
  codexReasoningEffort: AiReasoningEffort;
  codexProfile: string;
  codexLoginMode: AiCodexLoginMode;
  responseLanguage: string;
  commonInstructions: string;
  commitInstructions: string;
  pullRequestInstructions: string;
  timeoutMs: number;
}

/** provider 별 실행 결과 표시 이름. */
export const AI_CLI_PROVIDER_LABELS: Record<AiCliProvider, string> = {
  auto: "Auto",
  claude: "Claude Code",
  codex: "Codex",
};

const DEFAULT_TIMEOUT_MS = 120000;

/**
 * VS Code 설정에서 AI CLI 설정을 읽어 안전한 기본값으로 정규화한다.
 * @returns CLI provider, command, model, timeout 설정
 */
export function readAiCliConfig(): AiCliConfig {
  const config = vscode.workspace.getConfiguration("gitSimpleCompare");
  return {
    provider: normalizeProvider(config.get("aiCliProvider", "auto")),
    claudeCommand: config.get("aiClaudeCommand", "claude").trim() || "claude",
    claudeModel: config.get("aiClaudeModel", "").trim(),
    claudeEffort: normalizeReasoningEffort(config.get("aiClaudeEffort", "")),
    claudeSystemPrompt: config.get("aiClaudeSystemPrompt", "").trim(),
    claudeLoginMode: normalizeClaudeLoginMode(
      config.get("aiClaudeLoginMode", "claudeai")
    ),
    codexCommand: config.get("aiCodexCommand", "codex").trim() || "codex",
    codexModel: config.get("aiCodexModel", "").trim(),
    codexReasoningEffort: normalizeReasoningEffort(
      config.get("aiCodexReasoningEffort", "")
    ),
    codexProfile: config.get("aiCodexProfile", "").trim(),
    codexLoginMode: normalizeCodexLoginMode(
      config.get("aiCodexLoginMode", "device")
    ),
    responseLanguage: config.get("aiResponseLanguage", "English").trim() || "English",
    commonInstructions: config.get("aiCommonInstructions", "").trim(),
    commitInstructions: config.get("aiCommitInstructions", "").trim(),
    pullRequestInstructions: config.get("aiPullRequestInstructions", "").trim(),
    timeoutMs: normalizeTimeout(config.get("aiCliTimeoutMs", DEFAULT_TIMEOUT_MS)),
  };
}

/**
 * Claude 로그인 방식을 지원 범위 안으로 보정한다.
 * @param value 설정 원본 값
 */
function normalizeClaudeLoginMode(value: string): AiClaudeLoginMode {
  if (value === "console" || value === "sso" || value === "setup-token") {
    return value;
  }
  return "claudeai";
}

/**
 * Codex 로그인 방식을 지원 범위 안으로 보정한다.
 * @param value 설정 원본 값
 */
function normalizeCodexLoginMode(value: string): AiCodexLoginMode {
  if (value === "browser" || value === "api-key" || value === "access-token") {
    return value;
  }
  return "device";
}

/**
 * 추론 강도 설정을 지원 범위 안으로 보정한다.
 * @param value 설정 원본 값
 */
function normalizeReasoningEffort(value: string): AiReasoningEffort {
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
 * 사용자가 입력한 provider 문자열을 지원 범위 안으로 보정한다.
 * @param value 설정 원본 값
 * @returns 지원되는 provider 값
 */
export function normalizeProvider(value: string): AiCliProvider {
  if (value === "claude" || value === "codex") {
    return value;
  }
  return "auto";
}

/**
 * timeout 설정을 합리적인 범위로 보정한다.
 * @param value 설정 원본 값
 * @returns 10초~10분 사이의 timeout(ms)
 */
function normalizeTimeout(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(600000, Math.max(10000, Math.floor(value)));
}
