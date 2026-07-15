// AI 커밋 플랜 전용 모델과 추론 강도 설정 흐름.
// - 일반 provider 설정 UI와 분리해 기능 전용 값의 상속 의미를 한곳에서 관리한다.
// - 실제 설정 저장과 로그는 상위 aiSettings 모듈의 updater에 위임한다.
import * as vscode from "vscode";
import {
  AI_CLI_PROVIDER_LABELS,
  type AiCliConfig,
} from "../ai/cliConfig";
import {
  formatReasoningEffort,
  pickAiConcreteProvider,
  pickFeatureModelAndReasoning,
} from "./aiSettingsPickers";

/** 커밋 플랜 설정 흐름이 변경할 수 있는 VS Code configuration key. */
export type AiCommitPlanSettingKey =
  | "aiClaudeCommitPlanModel"
  | "aiClaudeCommitPlanEffort"
  | "aiCodexCommitPlanModel"
  | "aiCodexCommitPlanReasoningEffort";

/** 상위 설정 명령이 제공하는 저장 함수 형태. */
export type AiCommitPlanSettingUpdater = (
  key: AiCommitPlanSettingKey,
  value: string
) => Promise<void>;

/**
 * 설정 메뉴에 표시할 provider별 커밋 플랜 모델/추론 강도 요약을 만든다.
 * 빈 기능 전용 값은 CLI 기본값이 아니라 일반 설정 상속임을 짧은 라벨로 표시한다.
 * @param config 현재 정규화된 AI CLI 설정
 * @returns Claude와 Codex 설정을 한 줄로 비교할 수 있는 요약
 */
export function commitPlanSettingsSummary(config: AiCliConfig): string {
  const generalModel = vscode.l10n.t("General model");
  const generalEffort = vscode.l10n.t("General effort");
  const claude = `${config.claudeCommitPlanModel || generalModel} · ${
    config.claudeCommitPlanEffort || generalEffort
  }`;
  const codex = `${config.codexCommitPlanModel || generalModel} · ${
    config.codexCommitPlanReasoningEffort || generalEffort
  }`;
  return `Claude: ${claude} / Codex: ${codex}`;
}

/**
 * provider를 고른 뒤 AI 커밋 플랜 전용 모델과 추론 강도를 연속으로 설정한다.
 * - 빈 전용 값은 해당 provider의 일반 값을 상속해 기존 설정과 실행 동작을 보존한다.
 * - 선택한 모델 metadata가 있으면 최종 유효 effort와의 호환성을 저장 전에 확인한다.
 * @param config 현재 일반/커밋 플랜 모델과 추론 강도가 담긴 AI CLI 설정
 * @param updateSetting 선택을 사용자 전역 설정에 저장하고 로그를 남길 상위 updater
 */
export async function configureAiCommitPlanSettings(
  config: AiCliConfig,
  updateSetting: AiCommitPlanSettingUpdater
): Promise<void> {
  const provider = await pickAiConcreteProvider(
    config.provider === "auto" ? undefined : config.provider
  );
  if (!provider) {
    return;
  }
  const claude = provider === "claude";
  const providerLabel = AI_CLI_PROVIDER_LABELS[provider];
  const generalModel = claude ? config.claudeModel : config.codexModel;
  const generalEffort = claude
    ? config.claudeEffort
    : config.codexReasoningEffort;
  const choice = await pickFeatureModelAndReasoning(
    provider,
    claude ? config.claudeCommitPlanModel : config.codexCommitPlanModel,
    claude
      ? config.claudeCommitPlanEffort
      : config.codexCommitPlanReasoningEffort,
    {
      inheritedModel: generalModel,
      inheritedReasoningEffort: generalEffort,
      model: {
        title: claude
          ? vscode.l10n.t("Claude Code commit plan model")
          : vscode.l10n.t("Codex commit plan model"),
        emptyLabel: vscode.l10n.t("Use general AI model"),
        emptyDetail: vscode.l10n.t(
          "Inherit the general {0} model ({1}).",
          providerLabel,
          generalModel || vscode.l10n.t("CLI default model")
        ),
      },
      reasoning: {
        title: claude
          ? vscode.l10n.t("Claude Code commit plan reasoning effort")
          : vscode.l10n.t("Codex commit plan reasoning effort"),
        emptyLabel: vscode.l10n.t("Use general AI reasoning effort"),
        emptyDetail: vscode.l10n.t(
          "Inherit the general {0} reasoning effort ({1}).",
          providerLabel,
          formatReasoningEffort(generalEffort)
        ),
      },
    }
  );
  if (!choice) {
    return;
  }
  await updateSetting(
    claude ? "aiClaudeCommitPlanModel" : "aiCodexCommitPlanModel",
    choice.model
  );
  await updateSetting(
    claude
      ? "aiClaudeCommitPlanEffort"
      : "aiCodexCommitPlanReasoningEffort",
    choice.reasoningEffort
  );
}
