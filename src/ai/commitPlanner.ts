// AI CLI를 호출해 변경 파일을 여러 커밋 단위로 나누는 플랜 생성 서비스.
// - 설정/실행/로깅만 조립하고 프롬프트 구성 및 응답 보정은 순수 commitPlanModel에 위임한다.
import * as vscode from "vscode";
import { logError, logInfo } from "../ui/outputLog";
import { readAiCliConfig } from "./cliConfig";
import { runAiCliPrompt } from "./cliRunner";
import {
  buildCommitPlanPrompt,
  CommitPlanContext,
  CommitPlanResult,
  eligibleCommitPlanPaths,
  parseCommitPlanResponse,
} from "./commitPlanModel";

/** AI 커밋 플랜 한 번에 적용할 사용자 입력 옵션. */
export interface GenerateAiCommitPlanOptions {
  /** 이번 플랜에만 적용하는 자유 형식 추가 요청. */
  extraPrompt?: string;
  /** 사용자가 이미 생각해 둔 변경 목적이나 커밋 방향. */
  commitIntent?: string;
}

/** 로그에 남길 커밋 플랜 요청의 안전한 크기 요약. */
interface CommitPlanLogContext extends Record<string, unknown> {
  repoRoot: string;
  branch: string;
  scope: CommitPlanContext["scope"];
  files: number;
  diffChars: number;
  snapshotChars: number;
  hasExtraPrompt: boolean;
  hasCommitIntent: boolean;
}

/**
 * 현재 설정의 AI CLI로 변경 파일 분할 계획을 생성하고 검증한다.
 * - 단독 커밋 메시지 생성과 같은 품질 규칙 및 커밋 전용 지시문을 각 플랜 메시지에 적용한다.
 * - CancellationToken을 CLI 실행까지 전달하고 응답 파싱 전에도 취소 상태를 다시 확인한다.
 * @param context 동일 요청 동안 변하지 않는 git 변경 컨텍스트
 * @param options 일회성 추가 프롬프트와 사용자의 커밋 의도
 * @param token 진행 알림이나 호출자가 제공한 VS Code 취소 토큰
 * @returns allowlist, 중복, 누락 보정을 마친 커밋 플랜
 * @throws AI CLI 설정/인증/실행 오류 또는 응답 JSON 파싱 오류
 */
export async function generateAiCommitPlan(
  context: CommitPlanContext,
  options: GenerateAiCommitPlanOptions,
  token: vscode.CancellationToken
): Promise<CommitPlanResult> {
  throwIfCancelled(token);
  const eligiblePaths = eligibleCommitPlanPaths(context);
  if (eligiblePaths.length === 0) {
    throw new Error(noChangesMessage(context.scope));
  }

  const config = readAiCliConfig();
  const logContext = commitPlanLogContext(context, options, eligiblePaths.length);
  logInfo("AI commit plan requested", logContext);

  try {
    const prompt = buildCommitPlanPrompt(context, {
      responseLanguage: config.responseLanguage,
      commonInstructions: config.commonInstructions,
      commitInstructions: config.commitInstructions,
      extraPrompt: options.extraPrompt,
      commitIntent: options.commitIntent,
    });
    const response = await runAiCliPrompt(
      prompt,
      context.repoRoot,
      token,
      { modelPurpose: "commitPlan" }
    );
    throwIfCancelled(token);

    const result = localizeCommitPlanResult(
      parseCommitPlanResponse(context, response.text)
    );
    logInfo("AI commit plan completed", {
      ...logContext,
      provider: response.provider,
      groups: result.groups.length,
      warnings: result.warnings.length,
      fallbackGroups: result.groups.filter((group) => group.fallback).length,
    });
    return result;
  } catch (error) {
    logError("AI commit plan generation failed", error, logContext);
    throw localizeCommitPlanError(error);
  }
}

/**
 * VS Code 비의존 순수 모델이 만든 fallback 문구와 보정 경고를 현재 UI 언어로 바꾼다.
 * @param result 경로 검증과 누락 보정이 끝난 영문 기준 결과
 * @returns 경로/그룹 구조는 유지하고 사용자 표시 문자열만 지역화한 새 결과
 */
function localizeCommitPlanResult(result: CommitPlanResult): CommitPlanResult {
  return {
    groups: result.groups.map((group) =>
      group.fallback
        ? {
            ...group,
            paths: [...group.paths],
            message: vscode.l10n.t("Review remaining changes"),
            reason: vscode.l10n.t(
              "AI did not assign these files. Review and edit this commit before applying the plan."
            ),
          }
        : { ...group, paths: [...group.paths] }
    ),
    warnings: result.warnings.map(localizeCommitPlanWarning),
  };
}

/**
 * 모델 경고의 고정 형식을 해석해 숫자와 경로를 보존하면서 지역화한다.
 * 알 수 없는 새 형식은 원문을 유지해 경고가 사라지지 않게 한다.
 * @param warning 순수 모델이 만든 영문 경고
 * @returns 현재 VS Code 언어의 경고 또는 인식하지 못한 원문
 */
function localizeCommitPlanWarning(warning: string): string {
  const patterns: Array<[
    RegExp,
    (match: RegExpExecArray) => string,
  ]> = [
    [/^Commit (\d+) was ignored because it is not a JSON object\.$/, (match) =>
      vscode.l10n.t("Commit {0} was ignored because it is not a JSON object.", match[1])],
    [/^Commit (\d+) was ignored because its message is empty\.$/, (match) =>
      vscode.l10n.t("Commit {0} was ignored because its message is empty.", match[1])],
    [/^Commit (\d+) was ignored because paths is not an array\.$/, (match) =>
      vscode.l10n.t("Commit {0} was ignored because paths is not an array.", match[1])],
    [/^Commit (\d+) was ignored because it has no eligible paths\.$/, (match) =>
      vscode.l10n.t("Commit {0} was ignored because it has no eligible paths.", match[1])],
    [/^(\d+) unassigned file\(s\) were added to an editable fallback commit\.$/, (match) =>
      vscode.l10n.t("{0} unassigned file(s) were added to an editable fallback commit.", match[1])],
    [/^Commit (\d+) contains a non-string path; it was ignored\.$/, (match) =>
      vscode.l10n.t("Commit {0} contains a non-string path; it was ignored.", match[1])],
    [/^Commit (\d+) referenced unknown path (.+); it was ignored\.$/, (match) =>
      vscode.l10n.t("Commit {0} referenced unknown path {1}; it was ignored.", match[1], match[2])],
    [/^Path (.+) was assigned more than once; the first assignment was kept\.$/, (match) =>
      vscode.l10n.t("Path {0} was assigned more than once; the first assignment was kept.", match[1])],
  ];
  for (const [pattern, translate] of patterns) {
    const match = pattern.exec(warning);
    if (match) {
      return translate(match);
    }
  }
  return warning;
}

/**
 * AI JSON 구조 오류를 현재 UI 언어로 바꾸되 CLI/취소/알 수 없는 오류는 원형을 유지한다.
 * @param error AI 실행 또는 응답 파싱 중 발생한 오류
 * @returns 사용자 표시를 위한 지역화 오류
 */
function localizeCommitPlanError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  if (error.message === "AI did not return a commit plan JSON object.") {
    return new Error(vscode.l10n.t(error.message));
  }
  if (error.message === "AI commit plan JSON must contain a commits array.") {
    return new Error(vscode.l10n.t(error.message));
  }
  const invalidJson = /^AI returned invalid commit plan JSON: (.+)$/s.exec(
    error.message
  );
  return invalidJson
    ? new Error(
        vscode.l10n.t(
          "AI returned invalid commit plan JSON: {0}",
          invalidJson[1]
        )
      )
    : error;
}

/**
 * 플랜 생성 시작 전에 취소된 요청이 AI CLI를 실행하지 않도록 즉시 중단한다.
 * 응답을 받은 직후에도 호출해 취소 뒤 늦게 도착한 결과가 UI에 반영되는 것을 막는다.
 * @param token 호출자가 전달한 VS Code 취소 토큰
 * @throws {vscode.CancellationError} 토큰이 이미 취소된 경우
 */
function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
}

/**
 * 변경이 없는 요청에 scope를 반영한 사용자 표시용 오류 문구를 만든다.
 * staged 모드에서는 먼저 stage해야 한다는 행동 지침을 포함한다.
 * @param scope 현재 플랜이 대상으로 삼은 staged 또는 all 범위
 * @returns 지역화가 적용된 짧은 오류 문구
 */
function noChangesMessage(scope: CommitPlanContext["scope"]): string {
  return scope === "staged"
    ? vscode.l10n.t("Stage changes before generating an AI commit plan.")
    : vscode.l10n.t("No changes are available for AI commit planning.");
}

/**
 * 프롬프트 원문이나 사용자 입력을 노출하지 않고 재현에 필요한 크기 정보만 로그로 만든다.
 * 경로 수는 context 원본이 아니라 scope와 중복 제거가 적용된 실제 allowlist 수를 기록한다.
 * @param context git 변경 컨텍스트
 * @param options 일회성 사용자 입력 옵션
 * @param eligibleFileCount 이번 요청에서 AI에 허용한 고유 파일 수
 * @returns OUTPUT 채널 구조화 로그에 전달할 안전한 메타데이터
 */
function commitPlanLogContext(
  context: CommitPlanContext,
  options: GenerateAiCommitPlanOptions,
  eligibleFileCount: number
): CommitPlanLogContext {
  return {
    repoRoot: context.repoRoot,
    branch: context.branch,
    scope: context.scope,
    files: eligibleFileCount,
    diffChars: context.diff.length,
    snapshotChars: context.snapshot.length,
    hasExtraPrompt: hasText(options.extraPrompt),
    hasCommitIntent: hasText(options.commitIntent),
  };
}

/**
 * 선택적 사용자 문자열에 공백 외 실제 내용이 있는지 확인한다.
 * 로그에는 원문 대신 이 boolean만 남겨 민감한 커밋 의도가 OUTPUT에 노출되지 않게 한다.
 * @param value 추가 프롬프트 또는 commit intent
 * @returns 내용이 있는 문자열이면 true
 */
function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
