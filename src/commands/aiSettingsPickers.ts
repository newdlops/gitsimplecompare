// AI CLI 설정 중 모델/추론 강도 선택 UI.
// - provider 별 CLI metadata discovery 결과를 QuickPick 으로 보여주고 선택값만 반환한다.
import * as vscode from "vscode";
import {
  type AiCliProvider,
  type AiReasoningEffort,
} from "../ai/cliConfig";
import {
  discoverAiCliModels,
  type AiCliModelDiscovery,
  type AiCliModelOption,
  type AiCliReasoningOption,
} from "../ai/cliDiscovery";

type ConcreteProvider = Exclude<AiCliProvider, "auto">;

/** 모델과 추론 강도 선택 결과. */
export interface AiModelAndReasoningChoice {
  model: string;
  reasoningEffort: AiReasoningEffort;
}

/**
 * provider CLI 에서 모델 metadata 를 읽고 모델과 추론 강도를 선택한다.
 * @param provider 대상 provider
 * @param currentModel 현재 저장된 모델명
 * @param currentReasoningEffort 현재 저장된 추론 강도
 */
export async function pickModelAndReasoning(
  provider: ConcreteProvider,
  currentModel: string,
  currentReasoningEffort: AiReasoningEffort
): Promise<AiModelAndReasoningChoice> {
  const discovery = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Loading AI model metadata..."),
      cancellable: false,
    },
    () => discoverAiCliModels(provider)
  );
  const model = await pickModel(provider, discovery, currentModel);
  const modelOption = discovery.models.find((option) => option.id === model);
  const reasoningEffort = await pickReasoningEffort(
    modelOption,
    discovery,
    currentReasoningEffort
  );
  return { model, reasoningEffort };
}

/**
 * 설정 메뉴에 표시할 추론 강도 라벨을 만든다.
 * @param value 저장된 추론 강도
 */
export function formatReasoningEffort(value: AiReasoningEffort): string {
  return value || vscode.l10n.t("CLI default effort");
}

/**
 * CLI discovery 결과에서 모델을 선택한다.
 * @param provider 대상 provider
 * @param discovery CLI metadata discovery 결과
 * @param current 현재 모델명
 */
async function pickModel(
  provider: ConcreteProvider,
  discovery: AiCliModelDiscovery,
  current: string
): Promise<string> {
  const clear = vscode.l10n.t("Use CLI default model");
  const items: Array<vscode.QuickPickItem & { value: string }> = [
    ...currentModelItem(current, discovery.models),
    ...discovery.models.map((model) => ({
      label: model.label,
      description: model.id === current ? vscode.l10n.t("Current") : model.id,
      detail: model.detail || discovery.detail,
      value: model.id,
    })),
    { label: clear, detail: discovery.detail, value: "" },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: provider === "claude"
      ? vscode.l10n.t("Claude Code model")
      : vscode.l10n.t("Codex model"),
    placeHolder: discovery.detail,
  });
  return picked?.value ?? current;
}

/**
 * 현재 모델이 CLI 목록에 없을 때 기존 설정을 잃지 않도록 별도 항목을 만든다.
 * @param current 현재 모델명
 * @param models CLI 에서 읽은 모델 후보
 */
function currentModelItem(
  current: string,
  models: AiCliModelOption[]
): Array<vscode.QuickPickItem & { value: string }> {
  if (!current || models.some((model) => model.id === current)) {
    return [];
  }
  return [
    {
      label: current,
      description: vscode.l10n.t("Current"),
      detail: vscode.l10n.t("Current model is not in the CLI model list."),
      value: current,
    },
  ];
}

/**
 * 선택한 모델 또는 provider 가 노출한 추론 강도 후보를 선택한다.
 * @param model 선택한 모델 후보
 * @param discovery CLI metadata discovery 결과
 * @param current 현재 추론 강도
 */
async function pickReasoningEffort(
  model: AiCliModelOption | undefined,
  discovery: AiCliModelDiscovery,
  current: AiReasoningEffort
): Promise<AiReasoningEffort> {
  const options = model?.reasoningEfforts.length
    ? model.reasoningEfforts
    : discovery.reasoningEfforts;
  if (!options.length) {
    return current;
  }
  const picked = await vscode.window.showQuickPick(
    reasoningItems(options, model, current),
    {
      title: vscode.l10n.t("Reasoning effort"),
      placeHolder: vscode.l10n.t(
        "Choose the reasoning effort supported by the selected model."
      ),
    }
  );
  return picked?.value ?? current;
}

/**
 * 추론 강도 QuickPick 항목을 구성한다.
 * @param options CLI 에서 읽은 추론 강도 후보
 * @param model 선택한 모델 후보
 * @param current 현재 추론 강도
 */
function reasoningItems(
  options: AiCliReasoningOption[],
  model: AiCliModelOption | undefined,
  current: AiReasoningEffort
): Array<vscode.QuickPickItem & { value: AiReasoningEffort }> {
  const defaultDetail = model?.defaultReasoningEffort
    ? vscode.l10n.t("Default for selected model: {0}", model.defaultReasoningEffort)
    : vscode.l10n.t("Use the provider CLI default.");
  return [
    {
      label: vscode.l10n.t("Use CLI default reasoning"),
      description: current === "" ? vscode.l10n.t("Current") : undefined,
      detail: defaultDetail,
      value: "",
    },
    ...currentReasoningItem(current, options),
    ...options.map((option) => ({
      label: option.label,
      description: optionDescription(option, current),
      detail: option.detail || vscode.l10n.t("Supported by selected model."),
      value: option.value,
    })),
  ];
}

/**
 * 현재 reasoning 값이 CLI 목록에 없을 때 기존 설정을 보존하는 항목을 만든다.
 * @param current 현재 추론 강도
 * @param options CLI 에서 읽은 추론 강도 후보
 */
function currentReasoningItem(
  current: AiReasoningEffort,
  options: AiCliReasoningOption[]
): Array<vscode.QuickPickItem & { value: AiReasoningEffort }> {
  if (!current || options.some((option) => option.value === current)) {
    return [];
  }
  return [
    {
      label: current,
      description: vscode.l10n.t("Current"),
      detail: vscode.l10n.t("Current reasoning effort is not in the CLI list."),
      value: current,
    },
  ];
}

/**
 * 추론 강도 항목의 description 을 현재/기본 여부로 표시한다.
 * @param option 추론 강도 후보
 * @param current 현재 추론 강도
 */
function optionDescription(
  option: AiCliReasoningOption,
  current: AiReasoningEffort
): string | undefined {
  if (option.value === current) {
    return vscode.l10n.t("Current");
  }
  return option.isDefault ? vscode.l10n.t("Model default") : undefined;
}
