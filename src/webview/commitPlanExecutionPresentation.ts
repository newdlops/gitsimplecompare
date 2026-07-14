// AI 커밋 플랜 실행 진행률과 hook 실패 보고서를 웹뷰용 표시 모델로 제한하는 순수 모듈.
// - Git 원문/내부 메타데이터를 제외하고 문자열·목록·수치 상한을 한 경계에서 적용한다.
// - VS Code API와 DOM에 의존하지 않아 패널, 명령, 테스트가 같은 직렬화 규칙을 재사용한다.
import type { CommitFailureReport } from "../git/commitHookFailure";

/** AI 커밋 플랜 실행 실패 카드에 표시할 진단 한 건. */
export interface CommitPlanExecutionFailureItem {
  /** 사람이 읽을 수 있도록 정리하고 길이를 제한한 실패 메시지 */
  message: string;
  /** 저장소 루트 기준 파일 경로. 위치 정보가 없으면 생략한다. */
  path?: string;
  /** 1부터 시작하는 유효한 행 번호 */
  line?: number;
  /** 1부터 시작하는 유효한 열 번호 */
  column?: number;
  /** 실패 카드의 아이콘과 색상을 결정하는 제한된 심각도 */
  severity: "error" | "warning" | "info";
}

/** Git 계층의 commit 실패 보고서에서 웹뷰 표시 정보만 고른 안전한 구조. */
export interface CommitPlanExecutionFailure {
  /** commit hook 또는 검사 도구가 실패했을 가능성이 높은지 여부 */
  likelyHook: boolean;
  /** 출력에서 확인한 Git hook 이름 */
  hookName?: string;
  /** pre-commit 등의 개별 검사 이름 */
  checkName?: string;
  /** 실패 카드 첫 줄에 표시할 짧은 설명 */
  summary: string;
  /** 파일 위치를 포함할 수 있는 제한된 진단 목록 */
  items: CommitPlanExecutionFailureItem[];
  /** 원본 또는 웹뷰 변환 단계에서 일부 정보가 잘렸는지 여부 */
  truncated: boolean;
}

/** AI 커밋 플랜 실행 서비스가 UI에 전달하는 큰 실행 단계다. */
export type CommitPlanExecutionProgressPhase =
  | "validate"
  | "commit"
  | "rollback"
  | "complete";

/** 같은 commit 단계 안에서 그룹 시작과 private 준비 완료를 구분하는 상태다. */
export type CommitPlanExecutionProgressStep = "started" | "completed";

/**
 * 실제 브랜치 publish 전 private 커밋 준비 진행률을 웹뷰까지 전달하는 구조다.
 * `current`는 실제 브랜치에 생성된 수가 아니라 준비와 hook 검증을 통과한 그룹 수다.
 */
export interface CommitPlanExecutionProgress {
  phase: CommitPlanExecutionProgressPhase;
  current: number;
  total: number;
  step?: CommitPlanExecutionProgressStep;
  message?: string;
  paths?: string[];
}

interface ClippedText {
  /** 공백을 정리하고 상한을 적용한 문자열 */
  value: string;
  /** 상한 적용으로 원문 일부가 생략되었는지 여부 */
  truncated: boolean;
}

interface OptionalClippedText {
  /** 표시할 내용이 있을 때만 존재하는 정리된 문자열 */
  value?: string;
  /** 상한 적용으로 원문 일부가 생략되었는지 여부 */
  truncated: boolean;
}

interface PresentedFailureItem {
  /** 웹뷰로 전달해도 되는 진단 한 건 */
  item: CommitPlanExecutionFailureItem;
  /** 이 항목의 문자열 중 하나라도 상한에 걸렸는지 여부 */
  truncated: boolean;
}

const MAX_ITEMS = 20;
const MAX_SUMMARY_LENGTH = 1_000;
const MAX_ITEM_MESSAGE_LENGTH = 2_000;
const MAX_PATH_LENGTH = 4_096;
const MAX_LABEL_LENGTH = 128;
const MAX_PROGRESS_MESSAGE_LENGTH = 8_000;
const MAX_PROGRESS_PATHS = 500;

/** 웹뷰에서 허용하는 심각도 값과 런타임 입력을 비교할 때 사용하는 집합. */
const ALLOWED_SEVERITIES = new Set<CommitPlanExecutionFailureItem["severity"]>([
  "error",
  "warning",
  "info",
]);

/** 웹뷰가 알고 있는 실행 단계 외 런타임 값을 차단하기 위한 허용 집합. */
const ALLOWED_PROGRESS_PHASES = new Set<CommitPlanExecutionProgressPhase>([
  "validate",
  "commit",
  "rollback",
  "complete",
]);

/** 그룹 시작/완료 외 문자열을 카드 상태로 사용하지 않도록 제한하는 허용 집합. */
const ALLOWED_PROGRESS_STEPS = new Set<CommitPlanExecutionProgressStep>([
  "started",
  "completed",
]);

/**
 * Git commit 실패 보고서를 AI 커밋 플랜 웹뷰에 보낼 최소 표시 모델로 변환한다.
 * 원본 stdout/stderr, 재시도 operation, 발생 시각 같은 실행 메타데이터는 복사하지
 * 않고, 모든 문자열과 목록에 상한을 적용해 큰 hook 출력이 웹뷰 메시지를 막지 않게 한다.
 * @param report Git 계층에서 파싱한 commit 또는 hook 실패 보고서
 * @returns 웹뷰에 직렬화할 수 있는 크기 제한 표시 모델
 */
export function presentCommitPlanExecutionFailure(
  report: CommitFailureReport
): CommitPlanExecutionFailure {
  const summary = clipRequiredText(report.summary, MAX_SUMMARY_LENGTH);
  const hookName = clipOptionalText(report.hookName, MAX_LABEL_LENGTH);
  const checkName = clipOptionalText(report.checkName, MAX_LABEL_LENGTH);
  const sourceItems = Array.isArray(report.items) ? report.items : [];
  const presentedItems = sourceItems
    .slice(0, MAX_ITEMS)
    .map((item) => presentFailureItem(item));
  const itemTextWasTruncated = presentedItems.some(
    (presented) => presented.truncated
  );

  return {
    likelyHook: report.likelyHook === true,
    ...(hookName.value ? { hookName: hookName.value } : {}),
    ...(checkName.value ? { checkName: checkName.value } : {}),
    summary: summary.value,
    items: presentedItems.map((presented) => presented.item),
    truncated:
      report.truncated === true ||
      sourceItems.length > MAX_ITEMS ||
      summary.truncated ||
      hookName.truncated ||
      checkName.truncated ||
      itemTextWasTruncated,
  };
}

/**
 * Git 실행 콜백의 진행 정보를 웹뷰 경계에 맞게 수치·문자열·목록 상한으로 정규화한다.
 * 서비스가 타입을 지키더라도 callback 구현 교체나 미래 확장에서 비정상 값이 들어올 수 있으므로,
 * `current <= total`을 보장하고 계획 메시지와 경로가 무제한 postMessage로 전달되지 않게 한다.
 * @param progress 실행 서비스가 보고한 현재 phase와 완료 그룹 수
 * @returns 웹뷰 progressbar와 카드 상태에 바로 사용할 제한된 새 객체
 */
export function presentCommitPlanExecutionProgress(
  progress: CommitPlanExecutionProgress
): CommitPlanExecutionProgress {
  const phase = normalizeProgressPhase(progress.phase);
  const total = nonNegativeSafeInteger(progress.total);
  const current = Math.min(nonNegativeSafeInteger(progress.current), total);
  const step = normalizeProgressStep(phase, progress.step);
  const message = clipOptionalText(
    progress.message,
    MAX_PROGRESS_MESSAGE_LENGTH
  );
  const paths = Array.isArray(progress.paths)
    ? progress.paths
        .slice(0, MAX_PROGRESS_PATHS)
        .map((item) => clipOptionalText(item, MAX_PATH_LENGTH).value)
        .filter((item): item is string => Boolean(item))
    : [];
  return {
    phase,
    current,
    total,
    ...(step ? { step } : {}),
    ...(message.value ? { message: message.value } : {}),
    ...(paths.length > 0 ? { paths } : {}),
  };
}

/**
 * 진행 phase를 UI가 지원하는 네 값으로 제한하고 알 수 없는 값은 검증 단계로 폴백한다.
 * @param value 서비스 또는 런타임에서 전달된 phase 후보
 * @returns 웹뷰 상태 머신이 처리할 수 있는 실행 phase
 */
function normalizeProgressPhase(value: unknown): CommitPlanExecutionProgressPhase {
  return ALLOWED_PROGRESS_PHASES.has(value as CommitPlanExecutionProgressPhase)
    ? (value as CommitPlanExecutionProgressPhase)
    : "validate";
}

/**
 * 시작/완료 step은 commit phase에서만 보존해 validate/complete가 특정 카드를 잘못 강조하지 않게 한다.
 * @param phase 정규화가 끝난 현재 실행 phase
 * @param value started/completed 후보
 * @returns 유효한 commit step, 그 밖에는 undefined
 */
function normalizeProgressStep(
  phase: CommitPlanExecutionProgressPhase,
  value: unknown
): CommitPlanExecutionProgressStep | undefined {
  if (
    phase !== "commit" ||
    !ALLOWED_PROGRESS_STEPS.has(value as CommitPlanExecutionProgressStep)
  ) {
    return undefined;
  }
  return value as CommitPlanExecutionProgressStep;
}

/**
 * progress 수치가 0 이상의 안전한 정수인지 확인하고 아니면 0으로 되돌린다.
 * @param value total/current로 받은 런타임 숫자 후보
 * @returns progressbar 속성에 안전하게 넣을 0 이상의 정수
 */
function nonNegativeSafeInteger(value: unknown): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : 0;
}

/**
 * 파싱된 진단에서 식별자와 내부 메타데이터를 제외하고 표시 필드만 복사한다.
 * 메시지·경로 길이를 제한하고 숫자 위치와 심각도를 재검증하므로, 타입 경계를
 * 우회한 런타임 값도 웹뷰 렌더링에 안전한 형태가 된다.
 * @param source Git 실패 파서가 만든 단일 진단
 * @returns 표시용 진단과 문자열 생략 여부
 */
function presentFailureItem(
  source: CommitFailureReport["items"][number]
): PresentedFailureItem {
  const message = clipRequiredText(source.message, MAX_ITEM_MESSAGE_LENGTH);
  const itemPath = clipOptionalText(source.path, MAX_PATH_LENGTH);
  const line = positiveInteger(source.line);
  const column = positiveInteger(source.column);

  return {
    item: {
      message: message.value,
      ...(itemPath.value ? { path: itemPath.value } : {}),
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
      severity: normalizeSeverity(source.severity),
    },
    truncated: message.truncated || itemPath.truncated,
  };
}

/**
 * 필수 표시 문자열의 앞뒤 공백을 제거하고 지정한 UTF-16 길이 안으로 자른다.
 * 잘린 문자열 끝에는 생략 기호를 두며, surrogate pair 중간에서 자르는 경우에는
 * 깨진 문자 대신 앞 글자를 한 글자 덜 보존한다.
 * @param value 정리할 런타임 값
 * @param maximumLength 결과 문자열이 넘지 않아야 할 최대 길이
 * @returns 정리된 문자열과 실제 생략 여부
 */
function clipRequiredText(value: unknown, maximumLength: number): ClippedText {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length <= maximumLength) {
    return { value: trimmed, truncated: false };
  }

  let prefix = trimmed.slice(0, Math.max(0, maximumLength - 1));
  if (endsWithUnpairedHighSurrogate(prefix)) {
    prefix = prefix.slice(0, -1);
  }
  return { value: `${prefix}…`, truncated: true };
}

/**
 * 선택 표시 문자열이 비어 있으면 필드를 생략하고, 내용이 있으면 공통 상한을 적용한다.
 * @param value hook 이름·검사 이름·경로처럼 없을 수 있는 런타임 값
 * @param maximumLength 값이 있을 때 허용할 최대 문자열 길이
 * @returns 선택 문자열과 실제 생략 여부
 */
function clipOptionalText(
  value: unknown,
  maximumLength: number
): OptionalClippedText {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { truncated: false };
  }
  return clipRequiredText(value, maximumLength);
}

/**
 * 행·열 값이 웹뷰 위치 표시로 사용할 수 있는 양의 안전한 정수인지 확인한다.
 * NaN, Infinity, 소수, 0, 음수 및 정밀도를 보장할 수 없는 큰 정수는 버린다.
 * @param value 파서 보고서에 담긴 행 또는 열 후보
 * @returns 유효한 양의 정수, 아니면 undefined
 */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : undefined;
}

/**
 * 심각도를 error/warning/info 세 값으로 제한하고 알 수 없는 값은 안전하게 error로 표시한다.
 * 실패 진단을 눈에 띄게 유지하기 위해 잘못된 값이나 향후 추가된 값도 숨기지 않는다.
 * @param value 파서 또는 외부 런타임에서 들어온 심각도 후보
 * @returns 웹뷰가 지원하는 심각도
 */
function normalizeSeverity(
  value: unknown
): CommitPlanExecutionFailureItem["severity"] {
  return ALLOWED_SEVERITIES.has(
    value as CommitPlanExecutionFailureItem["severity"]
  )
    ? (value as CommitPlanExecutionFailureItem["severity"])
    : "error";
}

/**
 * 잘린 접두사가 UTF-16 high surrogate로 끝나는지 확인해 깨진 유니코드 출력을 막는다.
 * @param value 상한 직전까지 잘라 둔 문자열
 * @returns 마지막 code unit이 짝을 잃은 high surrogate이면 true
 */
function endsWithUnpairedHighSurrogate(value: string): boolean {
  if (!value) {
    return false;
  }
  const finalCodeUnit = value.charCodeAt(value.length - 1);
  return finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff;
}
