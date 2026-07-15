// AI CLI 설정 중 모델/추론 강도 선택 UI.
// - provider 별 CLI metadata discovery 결과를 QuickPick 으로 보여주고 선택값만 반환한다.
import * as vscode from "vscode";
import {
  type AiCliProvider,
  type AiReasoningEffort,
} from "../ai/cliConfig";
import { isKnownUnsupportedAiReasoningEffort } from "../ai/cliModelSelection";
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

/** 기능 전용 모델을 고르는 화면의 제목과 상속 항목 문구. */
export interface AiModelOnlyPickerOptions {
  title: string;
  emptyLabel: string;
  emptyDetail: string;
}

/** 기능 전용 추론 강도 picker의 제목과 상속 항목 문구. */
export interface AiReasoningPickerOptions {
  title: string;
  emptyLabel: string;
  emptyDetail: string;
}

/** 기능 전용 모델과 추론 강도를 함께 고를 때 필요한 상속 정보와 UI 문구. */
export interface AiFeatureModelAndReasoningPickerOptions {
  inheritedModel: string;
  inheritedReasoningEffort: AiReasoningEffort;
  model: AiModelOnlyPickerOptions;
  reasoning: AiReasoningPickerOptions;
}

/**
 * provider CLI 에서 모델 metadata 를 읽고 모델과 추론 강도를 선택한다.
 * @param provider 대상 provider
 * @param currentModel 현재 저장된 모델명
 * @param currentReasoningEffort 현재 저장된 추론 강도
 * @returns 취소한 단계는 기존 값을 유지한 최종 모델과 추론 강도
 */
export async function pickModelAndReasoning(
  provider: ConcreteProvider,
  currentModel: string,
  currentReasoningEffort: AiReasoningEffort
): Promise<AiModelAndReasoningChoice> {
  const discovery = await loadModelDiscovery(provider);
  const model = await pickModel(provider, discovery, currentModel) ??
    currentModel;
  const modelOption = discovery.models.find((option) => option.id === model);
  const reasoningEffort = await pickReasoningEffort(
    modelOption,
    discovery,
    currentReasoningEffort
  );
  return { model, reasoningEffort };
}

/**
 * provider CLI metadata를 한 번 불러와 기능 전용 모델과 추론 강도를 연속으로 선택한다.
 * 커밋 플랜처럼 빈 값이 CLI 기본값이 아닌 일반 설정 상속을 뜻할 수 있으므로 모델/effort별
 * 제목과 상속 설명을 호출자가 제공하고, 최종 유효 조합의 metadata 호환성도 확인한다.
 * @param provider 모델 후보를 읽을 Claude Code 또는 Codex provider
 * @param currentModel 현재 저장된 모델명. 빈 문자열은 호출자가 정의한 기본 동작을 뜻한다.
 * @param currentReasoningEffort 현재 저장된 기능 전용 추론 강도
 * @param options 일반 설정 상속값과 두 picker에 표시할 사용자 안내 문구
 * @returns 선택한 모델/추론 강도. 모델 picker를 취소하거나 호환성 확인을 거부하면 undefined
 */
export async function pickFeatureModelAndReasoning(
  provider: ConcreteProvider,
  currentModel: string,
  currentReasoningEffort: AiReasoningEffort,
  options: AiFeatureModelAndReasoningPickerOptions
): Promise<AiModelAndReasoningChoice | undefined> {
  const discovery = await loadModelDiscovery(provider);
  const model = await pickModel(
    provider,
    discovery,
    currentModel,
    options.model
  );
  if (model === undefined) {
    return undefined;
  }
  const effectiveModel = model || options.inheritedModel;
  const selected = discovery.models.find(
    (candidate) => candidate.id === effectiveModel
  );
  const reasoningEffort = await pickReasoningEffort(
    selected,
    discovery,
    currentReasoningEffort,
    options.reasoning
  );
  const effectiveReasoningEffort = reasoningEffort ||
    options.inheritedReasoningEffort;
  const unsupported = isKnownUnsupportedAiReasoningEffort(
    effectiveReasoningEffort,
    selected?.reasoningEfforts.map((effort) => effort.value) ?? []
  );
  if (!unsupported) {
    return { model, reasoningEffort };
  }
  return await confirmUnsupportedReasoning(
    effectiveModel,
    effectiveReasoningEffort
  )
    ? { model, reasoningEffort }
    : undefined;
}

/**
 * 선택 모델의 metadata가 현재 provider 추론 강도를 지원하지 않을 때 저장 전 확인을 받는다.
 * metadata에 없는 custom 모델이나 지원 목록을 노출하지 않는 CLI는 이 함수까지 오지 않으며,
 * 사용자가 명시적으로 계속하기를 골라야만 전용 모델 설정을 변경한다.
 * @param model 사용자가 선택한 커밋 플랜 전용 모델명
 * @param reasoningEffort 현재 provider 설정에서 플랜에도 전달될 추론 강도
 * @returns 비호환 가능성을 이해하고 모델을 그대로 사용할 때 true
 */
async function confirmUnsupportedReasoning(
  model: string,
  reasoningEffort: AiReasoningEffort
): Promise<boolean> {
  const useAnyway = vscode.l10n.t("Use Model Anyway");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Model '{0}' does not list support for reasoning effort '{1}'.",
      model,
      reasoningEffort
    ),
    {
      modal: true,
      detail: vscode.l10n.t(
        "Choose a compatible model or change the commit plan reasoning effort."
      ),
    },
    useAnyway
  );
  return choice === useAnyway;
}

/**
 * 설치된 provider CLI의 모델 metadata를 진행 알림과 함께 읽는다.
 * 일반 모델과 기능 전용 모델 picker가 동일한 discovery 및 오류 처리를 공유하게 한다.
 * @param provider metadata를 조회할 Claude Code 또는 Codex provider
 * @returns 모델과 추론 강도 후보가 담긴 discovery 결과
 */
async function loadModelDiscovery(
  provider: ConcreteProvider
): Promise<AiCliModelDiscovery> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Loading AI model metadata..."),
      cancellable: false,
    },
    () => discoverAiCliModels(provider)
  );
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
 * @param options 기능 전용 picker에서 덮어쓸 제목과 빈 값 안내. 생략하면 일반 모델 문구 사용
 * @returns 선택한 모델명, 사용자가 취소하면 undefined
 */
async function pickModel(
  provider: ConcreteProvider,
  discovery: AiCliModelDiscovery,
  current: string,
  options?: AiModelOnlyPickerOptions
): Promise<string | undefined> {
  const clear = options?.emptyLabel ?? vscode.l10n.t("Use CLI default model");
  const items: Array<vscode.QuickPickItem & { value: string }> = [
    ...currentModelItem(current, discovery.models),
    ...discovery.models.map((model) => ({
      label: model.label,
      description: model.id === current ? vscode.l10n.t("Current") : model.id,
      detail: model.detail || discovery.detail,
      value: model.id,
    })),
    {
      label: clear,
      description: current === "" ? vscode.l10n.t("Current") : undefined,
      detail: options?.emptyDetail ?? discovery.detail,
      value: "",
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: options?.title ?? (provider === "claude"
      ? vscode.l10n.t("Claude Code model")
      : vscode.l10n.t("Codex model")),
    placeHolder: discovery.detail,
  });
  return picked?.value;
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
 * @param pickerOptions 기능 전용 설정일 때 덮어쓸 제목과 빈 값의 상속 안내
 * @returns 선택한 추론 강도. picker를 취소하면 현재 값을 유지한다.
 */
async function pickReasoningEffort(
  model: AiCliModelOption | undefined,
  discovery: AiCliModelDiscovery,
  current: AiReasoningEffort,
  pickerOptions?: AiReasoningPickerOptions
): Promise<AiReasoningEffort> {
  const discovered = model?.reasoningEfforts.length
    ? model.reasoningEfforts
    : discovery.reasoningEfforts;
  if (!discovered.length && !pickerOptions) {
    return current;
  }
  const options = discovered.length
    ? discovered
    : fallbackReasoningOptions();
  const picked = await vscode.window.showQuickPick(
    reasoningItems(options, model, current, pickerOptions),
    {
      title: pickerOptions?.title ?? vscode.l10n.t("Reasoning effort"),
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
 * @param pickerOptions 기능 전용 설정일 때 사용할 상속 항목 문구
 * @returns CLI 기본값 또는 상속값과 선택 가능한 effort를 담은 QuickPick 항목
 */
function reasoningItems(
  options: AiCliReasoningOption[],
  model: AiCliModelOption | undefined,
  current: AiReasoningEffort,
  pickerOptions?: AiReasoningPickerOptions
): Array<vscode.QuickPickItem & { value: AiReasoningEffort }> {
  const defaultDetail = pickerOptions?.emptyDetail ?? (model?.defaultReasoningEffort
    ? vscode.l10n.t("Default for selected model: {0}", model.defaultReasoningEffort)
    : vscode.l10n.t("Use the provider CLI default."));
  return [
    {
      label: pickerOptions?.emptyLabel ??
        vscode.l10n.t("Use CLI default reasoning"),
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
 * 기능 전용 picker에서 CLI metadata가 추론 강도 목록을 제공하지 않을 때 schema 후보를 제공한다.
 * 실제 지원 범위는 모델마다 다를 수 있으므로 detail에서 metadata 미확인 상태임을 분명히 한다.
 * @returns 확장에서 저장할 수 있는 전체 추론 강도 후보
 */
function fallbackReasoningOptions(): AiCliReasoningOption[] {
  return (["low", "medium", "high", "xhigh", "max"] as const).map(
    (value) => ({
      value,
      label: value,
      detail: vscode.l10n.t(
        "Provider metadata did not list supported reasoning efforts."
      ),
    })
  );
}

/**
 * Claude Code/Codex 중 실제 설정을 편집할 provider 하나를 선택한다.
 * auto는 실행 순서 설정이므로 기능별 모델과 effort는 각 concrete provider에 따로 저장한다.
 * @param current 현재 대표 provider. 있으면 QuickPick의 Current 표시로 사용한다.
 * @returns 선택한 concrete provider, 취소하면 undefined
 */
export async function pickAiConcreteProvider(
  current?: ConcreteProvider
): Promise<ConcreteProvider | undefined> {
  const items: Array<vscode.QuickPickItem & { value: ConcreteProvider }> = [
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
