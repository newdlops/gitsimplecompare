// AI CLI 작업 목적과 provider에 맞는 모델 설정을 선택하는 순수 모듈.
// - VS Code 설정 API와 CLI 실행에 의존하지 않아 설정 호환성 규칙을 독립적으로 검증할 수 있다.

/** AI CLI 모델을 선택할 때 구분하는 요청 목적이다. */
export type AiCliModelPurpose = "general" | "commitPlan";

/** auto 선택을 해석한 뒤 실제 명령을 실행할 AI CLI provider다. */
export type AiCliConcreteProvider = "claude" | "codex";

/** provider별 일반 모델과 커밋 플랜 전용 모델의 원본 설정이다. */
export interface AiCliModelSettings {
  claudeModel: string;
  claudeCommitPlanModel: string;
  codexModel: string;
  codexCommitPlanModel: string;
}

/** 최종 모델이 선택된 설정 계층이다. */
export type AiCliModelSource = "commitPlan" | "general" | "cliDefault";

/** CLI 인자에 전달할 모델과 그 값을 결정한 설정 계층이다. */
export interface AiCliModelSelection {
  model: string;
  source: AiCliModelSource;
}

/** provider 한 곳의 일반/커밋 플랜 모델 후보를 묶은 내부 구조다. */
interface ProviderModelSettings {
  general: string;
  commitPlan: string;
}

/**
 * provider와 요청 목적에 맞는 AI CLI 모델을 우선순위대로 선택한다.
 * - 일반 요청은 provider의 일반 모델만 사용하고, 비어 있으면 CLI 기본값에 맡긴다.
 * - 커밋 플랜은 전용 모델을 먼저 사용하고, 공백이면 일반 모델을 동적으로 상속한다.
 * - 모든 후보의 앞뒤 공백을 제거해 빈 `--model` 인자나 공백이 포함된 모델명을 만들지 않는다.
 * @param settings provider별 일반/커밋 플랜 모델 원본 설정
 * @param provider auto 해석 뒤 실제 실행할 Claude 또는 Codex provider
 * @param purpose 일반 AI 요청인지 커밋 플랜 요청인지 나타내는 목적
 * @returns 정규화한 모델명과 값을 선택한 설정 계층
 */
export function selectAiCliModel(
  settings: AiCliModelSettings,
  provider: AiCliConcreteProvider,
  purpose: AiCliModelPurpose
): AiCliModelSelection {
  const models = providerModels(settings, provider);
  if (purpose === "commitPlan" && models.commitPlan) {
    return { model: models.commitPlan, source: "commitPlan" };
  }
  if (models.general) {
    return { model: models.general, source: "general" };
  }
  return { model: "", source: "cliDefault" };
}

/**
 * provider metadata가 현재 추론 강도를 명시적으로 지원하지 않는지 판정한다.
 * - 설정이 비었거나 모델이 지원 목록을 노출하지 않으면 호환성을 알 수 있으므로 경고하지 않는다.
 * - 지원 목록이 있는 경우에만 불일치를 확정해, 오래된 CLI metadata로 유효한 사용자 모델을 막지 않는다.
 * @param configuredEffort 일반 provider 설정에서 플랜에도 적용할 추론 강도
 * @param supportedEfforts 선택 모델이 CLI metadata로 노출한 지원 추론 강도 목록
 * @returns 지원 목록이 있고 현재 값이 그 목록에 없을 때만 true
 */
export function isKnownUnsupportedAiReasoningEffort(
  configuredEffort: string,
  supportedEfforts: readonly string[]
): boolean {
  const effort = configuredEffort.trim();
  return Boolean(effort) && supportedEfforts.length > 0 &&
    !supportedEfforts.some((supported) => supported === effort);
}

/**
 * 전체 설정에서 지정 provider의 모델 후보만 읽어 정규화한다.
 * @param settings provider별 모델 원본 설정
 * @param provider 후보를 읽을 실제 AI CLI provider
 * @returns 앞뒤 공백을 제거한 일반/커밋 플랜 모델 후보
 */
function providerModels(
  settings: AiCliModelSettings,
  provider: AiCliConcreteProvider
): ProviderModelSettings {
  if (provider === "claude") {
    return {
      general: normalizeModel(settings.claudeModel),
      commitPlan: normalizeModel(settings.claudeCommitPlanModel),
    };
  }
  return {
    general: normalizeModel(settings.codexModel),
    commitPlan: normalizeModel(settings.codexCommitPlanModel),
  };
}

/**
 * 사용자 모델 설정의 유효한 이름은 보존하고 앞뒤 공백만 제거한다.
 * @param value VS Code 설정에서 읽은 모델 문자열
 * @returns 정규화한 모델명. 공백뿐이면 빈 문자열
 */
function normalizeModel(value: string): string {
  return value.trim();
}
