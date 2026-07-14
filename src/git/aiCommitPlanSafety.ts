// AI 커밋 계획 실행에서 공유하는 snapshot, path allowlist, ref/index fence 순수 로직.
// - Git I/O와 분리해 외부 변경을 덮지 않는 판정을 독립적으로 검증하고 재사용할 수 있게 한다.
import { createHash } from "node:crypto";
import type {
  CommitPlanContext,
  CommitPlanGroup,
  CommitPlanResult,
} from "../ai/commitPlanModel";
import { findCommitPlanPathTransitionConflict } from "../ai/commitPlanModel";
import type { MergeOperation } from "./conflictService";

/** 계획 실행 실패 종류를 command/UI 계층이 문자열 파싱 없이 구분할 수 있게 한다. */
export type AiCommitPlanErrorCode =
  | "repository-mismatch"
  | "stale-snapshot"
  | "invalid-plan"
  | "unsupported-head"
  | "active-operation"
  | "concurrent-change"
  | "commit-tree-mismatch"
  | "rollback-failed";

/**
 * AI 커밋 계획의 검증, 동시성 fence, rollback 실패를 나타내는 오류다.
 * 실제 `git commit`/hook 오류는 서비스가 원래 GitError를 다시 던져 기존 진단 출력을 보존한다.
 */
export class AiCommitPlanError extends Error {
  /**
   * 안정적인 코드와 선택적 원인을 포함한 계획 실행 오류를 만든다.
   * @param code UI가 분기할 오류 종류
   * @param message 사용자에게 보여줄 구체적인 실패 설명
   * @param cause stale/rollback 판정의 원본 오류
   */
  constructor(
    public readonly code: AiCommitPlanErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "AiCommitPlanError";
  }
}

/** planner 결과 전체 또는 사용자가 편집한 그룹 배열을 받는 공개 실행 입력이다. */
export type ExecutableCommitPlan = CommitPlanResult | CommitPlanGroup[];

/** AI 커밋 계획 실행 진행 단계다. */
export type CommitPlanProgressPhase =
  | "validate"
  | "commit"
  | "rollback"
  | "complete";

/** UI progress와 OUTPUT 로그가 현재 실행 위치를 표시할 때 받는 구조화된 진행 정보다. */
export interface CommitPlanProgress {
  phase: CommitPlanProgressPhase;
  current: number;
  total: number;
  /** commit 단계에서 현재 그룹 시작과 private 준비 완료를 명시적으로 구분한다. */
  step?: "started" | "completed";
  message?: string;
  paths?: string[];
}

/** 동기 또는 비동기 UI가 사용할 수 있는 계획 실행 진행 callback이다. */
export type CommitPlanProgressCallback = (
  progress: CommitPlanProgress
) => void | PromiseLike<void>;

/** 성공적으로 만들어진 커밋 한 건의 실행 결과다. */
export interface ExecutedCommitPlanGroup {
  hash: string;
  message: string;
  paths: string[];
  hookAdjustedPaths?: string[];
}

/** 전체 계획이 성공했을 때 호출자에게 반환하는 HEAD와 생성 커밋 목록이다. */
export interface CommitPlanExecutionResult {
  originalHead?: string;
  head: string;
  commits: ExecutedCommitPlanGroup[];
}

/** 외부 변경을 판별할 현재 Git ref/index/operation 상태다. */
export interface GitFenceState {
  head?: string;
  headRef?: string;
  indexFingerprint: string;
  operation: MergeOperation;
}

/** source index에서 읽은 stage 0 blob/tree entry 한 건이다. */
export interface CommitPlanIndexEntry {
  path: string;
  mode: string;
  oid: string;
}

/** 실행 시작 시 한 번 고정한 전체 source index/tree와 그룹별 immutable binary patch다. */
export interface FrozenCommitPlanInput {
  indexPath: string;
  tree: string;
  entries: ReadonlyMap<string, CommitPlanIndexEntry>;
}

/**
 * HEAD, 계획 범위, source index의 full binary patch, 실제 index fingerprint를 한 snapshot으로 묶는다.
 * - all 범위의 source binary patch는 임시 index에 `git add -A`한 결과라 미추적 파일의 전체 내용도 포함한다.
 * - 실제 index fingerprint를 별도 필드로 넣어 all 계획 중 외부 stage/unstage도 stale 상태로 감지한다.
 * @param head 계획 기준 HEAD. 제품 흐름에서는 born local branch OID를 사용한다.
 * @param scope staged 또는 all 계획 범위
 * @param binaryDiff source index와 HEAD 사이의 전체 binary patch 원본 바이트
 * @param indexFingerprint 계획 생성 시점 실제 index 엔트리 fingerprint
 * @returns `sha256:` 접두사가 붙은 deterministic snapshot
 */
export function computeCommitPlanSnapshot(
  head: string | undefined,
  scope: CommitPlanContext["scope"],
  binaryDiff: string | Uint8Array,
  indexFingerprint: string
): string {
  const hash = createHash("sha256");
  updateHashField(hash, head ?? "(unborn)");
  updateHashField(hash, scope);
  updateHashField(hash, binaryDiff);
  updateHashField(hash, indexFingerprint);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * `git ls-files --stage -v -z` 원문을 실제 index의 의미 있는 entry/flag fingerprint로 바꾼다.
 * @param raw assume/skip tag, mode, blob id, stage, path가 NUL로 구분된 index 원문
 * @returns HEAD와 독립적으로 비교 가능한 SHA-256 fingerprint
 */
export function fingerprintIndexEntries(raw: string | Uint8Array): string {
  const hash = createHash("sha256");
  updateHashField(hash, raw);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * planner 결과 객체와 UI가 직접 넘긴 그룹 배열을 같은 배열로 정규화한다.
 * @param plan CommitPlanResult 또는 CommitPlanGroup 배열
 * @returns 검증 전 그룹 배열
 */
export function commitPlanGroups(plan: ExecutableCommitPlan): CommitPlanGroup[] {
  return Array.isArray(plan) ? plan : plan.groups;
}

/**
 * 현재 scope의 모든 허용 path가 계획 전체에서 정확히 한 번 사용됐는지 검사한다.
 * @param context 파일 allowlist와 범위를 가진 계획 컨텍스트
 * @param groups 사용자가 최종 승인한 커밋 그룹
 * @returns 외부 변경을 막기 위해 message/path를 복제한 안전한 그룹 배열
 */
export function validateExecutableCommitPlan(
  context: CommitPlanContext,
  groups: CommitPlanGroup[]
): CommitPlanGroup[] {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw invalidCommitPlan("The AI commit plan has no commit groups.");
  }
  // context.files 자체가 context 수집기가 선택 scope의 cached diff에서 만든 단일 SoT다.
  // staged/unstaged 표시는 UI 메타데이터이므로 실행 allowlist를 다시 줄이는 데 사용하지 않는다.
  const allowed = new Set(context.files.map((file) => file.path));
  const seen = new Set<string>();
  const safeGroups = groups.map((group, groupIndex) => {
    const message = typeof group?.message === "string" ? group.message.trim() : "";
    if (!message) {
      throw invalidCommitPlan(`Commit group ${groupIndex + 1} has an empty message.`);
    }
    if (!Array.isArray(group.paths) || group.paths.length === 0) {
      throw invalidCommitPlan(`Commit group ${groupIndex + 1} has no paths.`);
    }
    const paths = group.paths.map((filePath) => {
      if (typeof filePath !== "string" || !allowed.has(filePath)) {
        throw invalidCommitPlan(
          `Commit group ${groupIndex + 1} contains an unknown path: ${String(filePath)}`
        );
      }
      if (seen.has(filePath)) {
        throw invalidCommitPlan(`Path is assigned more than once: ${filePath}`);
      }
      seen.add(filePath);
      return filePath;
    });
    return { ...group, message, paths: [...paths] };
  });
  const missing = [...allowed].filter((filePath) => !seen.has(filePath));
  if (missing.length > 0) {
    throw invalidCommitPlan(
      `Plan does not assign every changed path: ${missing.join(", ")}`
    );
  }
  const transition = findCommitPlanPathTransitionConflict(
    context.files,
    safeGroups
  );
  if (transition) {
    throw invalidCommitPlan(
      `File/directory transition paths must stay in the same commit: ${transition.ancestorPath} and ${transition.descendantPath}`
    );
  }
  return safeGroups;
}

/**
 * 일관된 오류 코드가 붙은 계획 검증 오류를 만든다.
 * @param message 구체적인 path/message 검증 실패 설명
 */
export function invalidCommitPlan(message: string): AiCommitPlanError {
  return new AiCommitPlanError("invalid-plan", message);
}

/**
 * 새 커밋의 parent 목록이 서비스가 직전에 확인한 HEAD와 정확히 이어지는지 검사한다.
 * - 최초 커밋은 parent가 없어야 하고, 일반 계획 커밋은 merge가 아닌 단일 parent여야 한다.
 * @param parents `git rev-list --parents -n 1`에서 commit hash를 제외한 parent 목록
 * @param expectedHead 커밋 직전 HEAD. unborn이면 undefined
 * @returns 외부 commit이 사이에 끼지 않은 우리 커밋이면 true
 */
export function hasExpectedCommitParents(
  parents: readonly string[],
  expectedHead: string | undefined
): boolean {
  return expectedHead === undefined
    ? parents.length === 0
    : parents.length === 1 && parents[0] === expectedHead;
}

/**
 * 읽어 둔 Git 상태가 예상 fence와 다르면 외부 상태를 보존하도록 concurrency 오류를 던진다.
 * @param state 현재 HEAD OID/ref, index, operation
 * @param expectedHead 서비스가 예상하는 HEAD OID
 * @param expectedHeadRef 실행 시작 symbolic HEAD ref. detached이면 undefined
 * @param expectedIndex 실행 시작 실제 index fingerprint
 * @param stage 오류에 표시할 단계
 */
export function assertCommitPlanFence(
  state: GitFenceState,
  expectedHead: string | undefined,
  expectedHeadRef: string | undefined,
  expectedIndex: string,
  stage: string
): void {
  if (state.operation !== "none") {
    throw new AiCommitPlanError(
      "active-operation",
      `The active ${state.operation} operation interrupted the AI commit plan during ${stage}.`
    );
  }
  if (
    state.head !== expectedHead ||
    state.headRef !== expectedHeadRef ||
    state.indexFingerprint !== expectedIndex
  ) {
    throw new AiCommitPlanError(
      "concurrent-change",
      `HEAD identity or the Git index changed concurrently during ${stage}. External changes were preserved.`
    );
  }
}

/**
 * 오류가 외부 Git 상태를 보존하기 위해 rollback 없이 전파해야 하는 종류인지 확인한다.
 * @param error 실행 중 발생한 임의 오류
 * @returns concurrent-change 또는 active-operation 오류이면 true
 */
export function isCommitPlanConcurrencyError(error: unknown): boolean {
  return error instanceof AiCommitPlanError &&
    (error.code === "concurrent-change" || error.code === "active-operation");
}

/**
 * unknown 오류 값을 rollback/concurrency 메시지에 넣을 문자열로 변환한다.
 * @param error catch에서 받은 임의 오류
 * @returns Error.message 또는 문자열 변환값
 */
export function commitPlanErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * UI 진행 callback 오류가 이미 수행된 Git 상태의 성공 여부를 바꾸지 않도록 안전하게 호출한다.
 * @param callback 호출자가 제공한 선택 callback
 * @param progress 현재 단계와 그룹 진행률
 */
export async function reportCommitPlanProgress(
  callback: CommitPlanProgressCallback | undefined,
  progress: CommitPlanProgress
): Promise<void> {
  try {
    await callback?.(progress);
  } catch {
    // 진행 UI 오류는 실행 서비스의 Git 상태와 무관하므로 무시한다.
  }
}

/**
 * 문자열/바이너리 필드를 길이와 함께 hash에 넣어 서로 다른 필드 조합의 경계 충돌을 막는다.
 * @param hash 갱신할 SHA-256 객체
 * @param value 추가할 문자열 또는 바이트 배열
 */
function updateHashField(
  hash: ReturnType<typeof createHash>,
  value: string | Uint8Array
): void {
  const bytes = Buffer.from(value);
  hash.update(String(bytes.length));
  hash.update(":");
  hash.update(bytes);
  hash.update(";");
}
