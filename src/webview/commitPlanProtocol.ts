// AI 커밋 플랜 웹뷰와 extension host 사이의 메시지 및 안전한 데이터 경계.
// - 웹뷰에서 돌아온 객체를 그대로 실행 계층에 넘기지 않고 이 모듈에서 크기/형태를 정규화한다.
// - 계획 편집에 필요한 순수 변환도 함께 제공해 패널과 테스트가 같은 규칙을 재사용하게 한다.
import {
  findCommitPlanPathTransitionConflict,
  type CommitPlanContext,
  type CommitPlanGroup,
  type CommitPlanPathTransitionConflict,
  type CommitPlanResult,
} from "../ai/commitPlanModel";
import type * as vscode from "vscode";

/** 웹뷰 입력이 지나치게 커져 extension host 를 압박하지 않도록 두는 상한. */
export const COMMIT_PLAN_LIMITS = Object.freeze({
  groups: 50,
  pathsPerGroup: 500,
  messageChars: 8_000,
  reasonChars: 4_000,
  promptChars: 12_000,
  intentChars: 1_000,
  pathChars: 4_096,
  warnings: 100,
  warningChars: 2_000,
});

/** AI 커밋 플랜 패널에서 동시에 수행할 수 있는 host 작업 종류. */
export type CommitPlanOperation =
  | "refresh"
  | "generate"
  | "execute"
  | "openFile"
  | "configure";

/** 패널을 열 때 함께 전달하는 초기 UI/생성 옵션. */
export interface CommitPlanLaunchOptions {
  /** 패널 준비 직후 AI 생성을 자동 시작할지 여부. */
  autoGenerate?: boolean;
  /** 사용자가 이번 생성에만 적용할 선택 추가 프롬프트. */
  prompt?: string;
  /** 호출 명령이 전달하는 커밋 범위 또는 생성 의도 식별자. */
  intent?: string;
}

/** host 가 정규화해 실제 패널 세션에서 사용하는 초기 옵션. */
export interface NormalizedCommitPlanLaunchOptions {
  autoGenerate: boolean;
  prompt: string;
  intent?: string;
}

/** 계획 실행 콜백이 선택적으로 돌려줄 완료 정보. */
export interface CommitPlanExecutionResult {
  /** 완료 배너에 표시할 사용자용 메시지. */
  message?: string;
  /** 실행 직후 새 Git 상태를 이미 읽었다면 교체할 최신 컨텍스트. */
  context?: CommitPlanContext;
}

/** 패널이 명령/AI/git 계층에 위임하는 액션 계약. */
export interface CommitPlanPanelActions {
  /**
   * 현재 컨텍스트와 추가 프롬프트로 AI 계획을 만든다.
   * @param context 생성 시점의 변경 파일/patch 컨텍스트
   * @param prompt 이번 요청에만 적용할 사용자 추가 프롬프트
   * @param intent 호출 명령이 전달한 범위 또는 생성 의도
   * @param token 패널 교체/닫기 때 취소되는 VS Code 토큰
   */
  generate(
    context: CommitPlanContext,
    prompt: string,
    intent: string | undefined,
    token: vscode.CancellationToken
  ): Promise<CommitPlanResult>;

  /**
   * 작업트리 변경을 다시 읽는다.
   * @param intent 최초 호출에서 지정한 컨텍스트 범위 또는 생성 의도
   */
  refreshContext(intent?: string): Promise<CommitPlanContext>;

  /**
   * 사용자가 편집하고 승인한 계획을 순서대로 실행한다.
   * @param context 계획이 만들어진 Git 변경 컨텍스트
   * @param result 실행 직전에 검증된 커밋 그룹과 경고
   */
  execute(
    context: CommitPlanContext,
    result: CommitPlanResult
  ): Promise<void | CommitPlanExecutionResult>;

  /**
   * 계획에 포함된 파일을 diff 또는 편집기로 연다.
   * @param path 저장소 상대 파일 경로
   * @param context 경로가 속한 계획 컨텍스트
   */
  openFile(path: string, context: CommitPlanContext): void | Promise<void>;

  /** AI CLI 설정 화면을 연다. */
  configure(): void | Promise<void>;

  /**
   * 패널 동작 실패를 Output 로그 등 공용 관찰성 계층에 보고한다.
   * @param error 원본 오류
   * @param operation 실패한 패널 작업
   */
  reportError(
    error: unknown,
    operation: CommitPlanOperation
  ): void | Promise<void>;

  /**
   * Git/AI 순수 계층 오류를 현재 UI 언어의 짧은 패널 문구로 바꾼다.
   * @param error 패널 작업에서 발생한 원본 오류
   * @returns 웹뷰 오류 배너에 표시할 안전한 문자열
   */
  formatError(error: unknown): string;
}

/** extension host 가 웹뷰로 보내는 타입이 보장된 상태 메시지. */
export type CommitPlanToWebview =
  | {
      type: "context";
      context: CommitPlanContext;
      prompt: string;
      intent?: string;
      autoGenerate: boolean;
    }
  | {
      type: "plan";
      result: CommitPlanResult;
      context: CommitPlanContext;
    }
  | {
      type: "progress";
      operation: "refresh" | "generate" | "execute";
      message: string;
    }
  | { type: "idle" }
  | { type: "error"; operation: CommitPlanOperation; message: string }
  | { type: "completed"; message: string };

/** 웹뷰가 extension host 로 요청할 수 있는 제한된 액션 메시지. */
export type CommitPlanFromWebview =
  | { type: "ready" }
  | { type: "generate"; prompt: string; intent?: string }
  | { type: "refreshContext"; prompt: string }
  | { type: "execute"; result: CommitPlanResult }
  | { type: "openFile"; path: string }
  | { type: "configure" };

/** 계획 실행 가능성 검증 결과. */
export interface CommitPlanValidation {
  valid: boolean;
  errors: string[];
  plannedPaths: number;
  contextPaths: number;
  pathTransition?: CommitPlanPathTransitionConflict;
}

/**
 * 외부 호출자가 전달한 패널 시작 옵션을 문자열 상한 안에서 정규화한다.
 * @param options 생략 가능 초기 옵션
 * @returns 패널 내부에서 바로 사용할 안전한 값
 */
export function normalizeCommitPlanLaunchOptions(
  options: CommitPlanLaunchOptions | undefined
): NormalizedCommitPlanLaunchOptions {
  const prompt = clippedString(options?.prompt, COMMIT_PLAN_LIMITS.promptChars);
  const intent = clippedString(options?.intent, COMMIT_PLAN_LIMITS.intentChars);
  return {
    autoGenerate: options?.autoGenerate === true,
    prompt,
    intent: intent || undefined,
  };
}

/**
 * 알 수 없는 웹뷰 메시지를 허용된 union 으로 읽고 문자열 크기를 제한한다.
 * - execute 계획은 여기서 구조 정규화까지 수행해 prototype/추가 필드를 제거한다.
 * @param value postMessage 로 받은 신뢰하지 않는 값
 * @returns 지원 메시지면 정규화된 객체, 아니면 undefined
 */
export function parseCommitPlanFromWebview(
  value: unknown
): CommitPlanFromWebview | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  switch (value.type) {
    case "ready":
      return { type: "ready" };
    case "refreshContext":
      return {
        type: "refreshContext",
        prompt: clippedString(value.prompt, COMMIT_PLAN_LIMITS.promptChars),
      };
    case "configure":
      return { type: "configure" };
    case "generate": {
      const prompt = clippedString(value.prompt, COMMIT_PLAN_LIMITS.promptChars);
      const intent = clippedString(value.intent, COMMIT_PLAN_LIMITS.intentChars);
      return { type: "generate", prompt, intent: intent || undefined };
    }
    case "openFile": {
      const path = clippedPath(value.path, COMMIT_PLAN_LIMITS.pathChars);
      return path ? { type: "openFile", path } : undefined;
    }
    case "execute":
      try {
        return {
          type: "execute",
          result: normalizeCommitPlanResult(value.result),
        };
      } catch {
        return undefined;
      }
    default:
      return undefined;
  }
}

/**
 * AI 또는 웹뷰가 만든 계획을 모델의 최소 필드만 남긴 새 객체로 정규화한다.
 * @param value AI 응답 파서 또는 웹뷰가 전달한 계획
 * @returns 길이/중복이 정리된 계획 복사본
 * @throws 그룹 배열이 없거나 허용 상한을 넘으면 오류
 */
export function normalizeCommitPlanResult(value: unknown): CommitPlanResult {
  if (!isRecord(value) || !Array.isArray(value.groups)) {
    throw new Error("Commit plan does not contain a groups array.");
  }
  if (value.groups.length > COMMIT_PLAN_LIMITS.groups) {
    throw new Error(
      `Commit plan exceeds ${COMMIT_PLAN_LIMITS.groups} groups.`
    );
  }
  const groups = value.groups.map((group, index) => normalizeGroup(group, index));
  const warnings = Array.isArray(value.warnings)
    ? value.warnings
        .slice(0, COMMIT_PLAN_LIMITS.warnings)
        .map((warning) => clippedString(warning, COMMIT_PLAN_LIMITS.warningChars))
        .filter(Boolean)
    : [];
  return { groups, warnings };
}

/**
 * 계획이 현재 컨텍스트의 모든 파일을 정확히 한 번 포함하는지 검사한다.
 * @param result 사용자가 편집한 실행 후보 계획
 * @param context 계획 생성에 사용한 변경 컨텍스트
 * @returns 사용자에게 표시 가능한 오류 목록과 파일 개수
 */
export function validateCommitPlanForExecution(
  result: CommitPlanResult,
  context: CommitPlanContext
): CommitPlanValidation {
  const errors: string[] = [];
  const knownPaths = new Set(commitPlanContextPaths(context));
  const seen = new Set<string>();
  if (result.groups.length === 0) {
    errors.push("The plan must contain at least one commit group.");
  }
  result.groups.forEach((group, groupIndex) => {
    const label = `Commit ${groupIndex + 1}`;
    if (!group.message.trim()) {
      errors.push(`${label} needs a commit message.`);
    }
    if (group.paths.length === 0) {
      errors.push(`${label} needs at least one file.`);
    }
    for (const path of group.paths) {
      if (seen.has(path)) {
        errors.push(`File '${path}' appears in more than one commit.`);
      }
      seen.add(path);
      if (knownPaths.size > 0 && !knownPaths.has(path)) {
        errors.push(`File '${path}' is no longer in the current context.`);
      }
    }
  });
  for (const path of knownPaths) {
    if (!seen.has(path)) {
      errors.push(`File '${path}' is not assigned to a commit.`);
    }
  }
  const pathTransition = findCommitPlanPathTransitionConflict(
    context.files,
    result.groups
  );
  if (pathTransition) {
    errors.push(
      `File/directory transition paths must stay in the same commit: ${pathTransition.ancestorPath} and ${pathTransition.descendantPath}`
    );
  }
  return {
    valid: errors.length === 0,
    errors: uniqueStrings(errors),
    plannedPaths: seen.size,
    contextPaths: knownPaths.size,
    pathTransition,
  };
}

/**
 * 컨텍스트에서 저장소 상대 파일 경로를 순서대로 추출한다.
 * - 모델 확장 중 `files` 대신 `changes` 별칭을 쓰는 과도기 데이터도 읽되 출력은 중복 제거한다.
 * @param context AI 계획 생성 컨텍스트
 * @returns 비어 있지 않은 파일 경로 목록
 */
export function commitPlanContextPaths(context: CommitPlanContext): string[] {
  const source = context as unknown as {
    files?: Array<{ path?: unknown }>;
    changes?: Array<{ path?: unknown }>;
  };
  const files = Array.isArray(source.files)
    ? source.files
    : Array.isArray(source.changes)
      ? source.changes
      : [];
  return uniqueStrings(
    files
      .map((file) => clippedPath(file?.path, COMMIT_PLAN_LIMITS.pathChars))
      .filter((path) => path.length > 0)
  );
}

/**
 * 계획의 두 그룹 위치를 바꾼 새 결과를 만든다.
 * @param result 원본 계획
 * @param from 이동할 그룹 인덱스
 * @param to 대상 그룹 인덱스
 * @returns 범위를 벗어나면 원본 복사, 유효하면 재정렬된 결과
 */
export function reorderCommitPlanGroups(
  result: CommitPlanResult,
  from: number,
  to: number
): CommitPlanResult {
  const groups = result.groups.map(cloneGroup);
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= groups.length ||
    to >= groups.length ||
    from === to
  ) {
    return { groups, warnings: [...result.warnings] };
  }
  const [group] = groups.splice(from, 1);
  groups.splice(to, 0, group);
  return { groups, warnings: [...result.warnings] };
}

/**
 * 파일 하나를 다른 커밋 그룹으로 옮기고 빈 그룹은 제거한다.
 * @param result 원본 계획
 * @param path 이동할 저장소 상대 경로
 * @param targetIndex 이동 전 배열 기준 대상 그룹 인덱스
 * @returns 파일이 없거나 대상이 잘못되면 내용이 같은 새 결과
 */
export function moveCommitPlanPath(
  result: CommitPlanResult,
  path: string,
  targetIndex: number
): CommitPlanResult {
  const groups = result.groups.map(cloneGroup);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= groups.length) {
    return { groups, warnings: [...result.warnings] };
  }
  let sourceIndex = -1;
  for (let index = 0; index < groups.length; index++) {
    const position = groups[index].paths.indexOf(path);
    if (position >= 0) {
      groups[index].paths.splice(position, 1);
      sourceIndex = index;
    }
  }
  if (sourceIndex < 0) {
    return { groups, warnings: [...result.warnings] };
  }
  groups[targetIndex].paths.push(path);
  return {
    groups: groups.filter((group) => group.paths.length > 0),
    warnings: [...result.warnings],
  };
}

/** AI/웹뷰 오류 값을 알림과 Output 로그에 쓸 한 줄 문자열로 바꾼다. */
export function commitPlanErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim() || "Unknown commit plan error.";
}

/** 알 수 없는 그룹 객체를 실행 모델의 안전한 필드만 가진 객체로 바꾼다. */
function normalizeGroup(value: unknown, index: number): CommitPlanGroup {
  if (!isRecord(value) || !Array.isArray(value.paths)) {
    throw new Error(`Commit plan group ${index + 1} is invalid.`);
  }
  if (value.paths.length > COMMIT_PLAN_LIMITS.pathsPerGroup) {
    throw new Error(
      `Commit plan group ${index + 1} exceeds ${COMMIT_PLAN_LIMITS.pathsPerGroup} files.`
    );
  }
  const message = clippedString(value.message, COMMIT_PLAN_LIMITS.messageChars);
  const reason = clippedString(value.reason, COMMIT_PLAN_LIMITS.reasonChars);
  const paths = uniqueStrings(
    value.paths
      .map((path) => clippedPath(path, COMMIT_PLAN_LIMITS.pathChars))
      .filter((path) => path.length > 0)
  );
  const group: CommitPlanGroup = { message, paths };
  if (reason) {
    group.reason = reason;
  }
  if (typeof value.fallback === "boolean") {
    group.fallback = value.fallback;
  }
  return group;
}

/** 계획 그룹을 중첩 배열까지 복제해 호출자 mutation이 원본 상태를 바꾸지 않게 한다. */
function cloneGroup(group: CommitPlanGroup): CommitPlanGroup {
  return { ...group, paths: [...group.paths] };
}

/** unknown 값이 문자열 key를 읽을 수 있는 일반 객체인지 판별한다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 문자열로 들어온 값만 공백 제거/길이 제한해 반환한다. */
function clippedString(value: unknown, maxChars: number): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, maxChars);
}

/**
 * Git 경로는 앞뒤 공백도 파일명의 일부이므로 trim 하지 않고 길이만 제한한다.
 * @param value 웹뷰 또는 컨텍스트에서 받은 경로 후보
 * @param maxChars extension host 로 들일 최대 문자 수
 * @returns 문자열이면 원문 공백을 보존한 제한 경로, 아니면 빈 문자열
 */
function clippedPath(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.slice(0, maxChars) : "";
}

/** 문자열 배열의 첫 등장 순서를 유지하면서 중복을 제거한다. */
function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
