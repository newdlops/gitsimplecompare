// AI CLI provider별 command와 argv를 조립하는 순수 모듈.
// - VS Code와 child_process에 의존하지 않아 auto 순서, 전용 모델, 추론 강도 인자를 단위 테스트한다.
// - 실제 프로세스 실행과 오류 처리는 cliRunner가 담당하고 이 모듈은 실행 명세만 반환한다.
import {
  selectAiCliModel,
  selectAiCliReasoningEffort,
  type AiCliConcreteProvider,
  type AiCliModelPurpose,
  type AiCliModelSelection,
  type AiCliModelSettings,
  type AiCliReasoningEffortSettings,
  type AiCliSettingSource,
} from "./cliModelSelection";

/** 사용자가 설정할 수 있는 auto를 포함한 AI CLI provider 선택값. */
export type AiCliProviderSelection = "auto" | AiCliConcreteProvider;

/** provider command 조립에 필요한 설정만 추린 재사용 가능한 입력 타입. */
export interface AiCliProviderCommandConfig extends AiCliModelSettings,
  AiCliReasoningEffortSettings {
  claudeCommand: string;
  claudeSystemPrompt: string;
  codexCommand: string;
  codexProfile: string;
}

/** shell을 거치지 않고 실행할 provider command와 관찰성용 모델 선택 정보. */
export interface AiCliProviderCommand {
  provider: AiCliConcreteProvider;
  command: string;
  args: string[];
  model: string;
  modelSource: AiCliSettingSource;
  reasoningEffort: string;
  reasoningEffortSource: AiCliSettingSource;
}

/** provider별 command builder가 공유하는 모델과 추론 강도 선택 결과. */
interface ProviderModelArguments {
  model: string;
  modelSource: AiCliSettingSource;
  modelArgs: string[];
  reasoningEffort: string;
  reasoningEffortSource: AiCliSettingSource;
}

/**
 * provider 설정에서 실제 CLI 시도 순서를 만든다.
 * `auto`는 기존 호환성을 위해 Claude Code를 먼저 시도하고, 실행 파일을 찾지 못했을 때 Codex로
 * 넘어갈 수 있게 두 provider를 모두 반환한다. 실제 fallback 조건은 cliRunner가 판정한다.
 * @param provider 사용자가 고른 auto, Claude Code 또는 Codex 설정
 * @returns 중복 없이 실제 실행 가능한 provider만 담은 시도 순서
 */
export function aiCliProviderOrder(
  provider: AiCliProviderSelection
): AiCliConcreteProvider[] {
  return provider === "auto" ? ["claude", "codex"] : [provider];
}

/**
 * provider와 요청 목적에 맞는 command, argv 및 모델 선택 정보를 만든다.
 * provider별 전용 모델을 독립적으로 해석하므로 auto가 Codex로 넘어가도 Claude 모델명을 재사용하지
 * 않는다. 반환한 argv는 shell quoting 없이 child_process.spawn에 그대로 전달할 수 있다.
 * @param config command, 일반/플랜 모델, 추론 강도와 provider 부가 설정
 * @param provider auto 해석 뒤 이번 시도에서 실제 실행할 provider
 * @param cwd Codex `-C`에 전달할 현재 저장소 루트
 * @param modelPurpose 일반 AI 요청인지 커밋 플랜 요청인지 나타내는 모델 목적
 * @returns 프로세스 실행과 OUTPUT 로그에 필요한 provider command 명세
 */
export function buildAiCliProviderCommand(
  config: AiCliProviderCommandConfig,
  provider: AiCliConcreteProvider,
  cwd: string,
  modelPurpose: AiCliModelPurpose
): AiCliProviderCommand {
  const model = providerModelArguments(config, provider, modelPurpose);
  return provider === "claude"
    ? buildClaudeCommand(config, model)
    : buildCodexCommand(config, model, cwd);
}

/**
 * 선택된 모델을 Claude Code와 Codex가 공통으로 받는 `--model` argv로 바꾼다.
 * CLI 기본값을 뜻하는 빈 모델은 플래그 자체를 생략하고, 모델명은 shell 문자열이 아닌 한 개 argv
 * 원소로 유지해 공백이나 특수문자를 명령으로 재해석하지 않는다.
 * @param selection 우선순위와 공백 정규화를 마친 모델 선택 결과
 * @returns CLI 인자에 펼쳐 넣을 `--model`, 모델명 쌍 또는 빈 배열
 */
export function aiCliModelArguments(
  selection: AiCliModelSelection
): string[] {
  return selection.model ? ["--model", selection.model] : [];
}

/**
 * 일반/커밋 플랜 모델 및 추론 강도 우선순위를 한 번에 적용한다.
 * @param config provider별 일반 및 커밋 플랜 모델과 추론 강도 설정
 * @param provider 실제 command를 만들 Claude Code 또는 Codex provider
 * @param modelPurpose 일반 모델 또는 커밋 플랜 전용 모델을 고를 목적
 * @returns 모델명, `--model` argv, 설정 계층과 적용 가능한 추론 강도
 */
function providerModelArguments(
  config: AiCliProviderCommandConfig,
  provider: AiCliConcreteProvider,
  modelPurpose: AiCliModelPurpose
): ProviderModelArguments {
  const selection = selectAiCliModel(config, provider, modelPurpose);
  const reasoning = selectAiCliReasoningEffort(
    config,
    provider,
    modelPurpose
  );
  return {
    model: selection.model,
    modelSource: selection.source,
    modelArgs: aiCliModelArguments(selection),
    reasoningEffort: reasoning.effort,
    reasoningEffortSource: reasoning.source,
  };
}

/**
 * Claude Code의 비대화식 text 응답 command를 조립한다.
 * @param config Claude 실행 파일과 system prompt 설정
 * @param model 선택된 모델 argv와 호환 가능한 추론 강도
 * @returns `claude -p`에 전달할 command 명세
 */
function buildClaudeCommand(
  config: AiCliProviderCommandConfig,
  model: ProviderModelArguments
): AiCliProviderCommand {
  const args = [
    "-p",
    "--output-format",
    "text",
    "--no-session-persistence",
    "--tools",
    "",
    ...model.modelArgs,
  ];
  if (model.reasoningEffort) {
    args.push("--effort", model.reasoningEffort);
  }
  if (config.claudeSystemPrompt) {
    args.push("--append-system-prompt", config.claudeSystemPrompt);
  }
  return {
    provider: "claude",
    command: config.claudeCommand,
    args,
    model: model.model,
    modelSource: model.modelSource,
    reasoningEffort: model.reasoningEffort,
    reasoningEffortSource: model.reasoningEffortSource,
  };
}

/**
 * Codex의 read-only exec command를 조립한다.
 * @param config Codex 실행 파일, profile과 추론 강도 설정
 * @param model 선택된 모델 argv와 호환 가능한 추론 강도
 * @param cwd `codex exec -C`가 읽기 전용으로 분석할 저장소 루트
 * @returns stdin prompt를 받는 `codex exec` command 명세
 */
function buildCodexCommand(
  config: AiCliProviderCommandConfig,
  model: ProviderModelArguments,
  cwd: string
): AiCliProviderCommand {
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "-C",
    cwd,
  ];
  if (model.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${model.reasoningEffort}"`);
  }
  args.push(...model.modelArgs);
  if (config.codexProfile) {
    args.push("--profile", config.codexProfile);
  }
  args.push("-");
  return {
    provider: "codex",
    command: config.codexCommand,
    args,
    model: model.model,
    modelSource: model.modelSource,
    reasoningEffort: model.reasoningEffort,
    reasoningEffortSource: model.reasoningEffortSource,
  };
}
