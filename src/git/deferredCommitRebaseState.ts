// 충돌 커밋을 뒤로 미루는 rebase merge 작업의 pending 상태 저장 모듈.
// - 일반 git rebase 가 아니라 cherry-pick 큐로 구현되므로, Conflicts 뷰의 continue/abort 시점에
//   남은 커밋 목록과 보존 stash 를 다시 찾을 수 있게 git-dir 아래에 기록한다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit } from "./gitExec";

const STATE_GIT_PATH = "gitsimplecompare/deferred-commit-rebase-state.json";

/** 충돌 커밋 후순위 적용을 사용하는 작업 종류 */
export type PendingDeferredCommitRebaseKind = "pr-rebase" | "branch-rebase" | "pr-revert";
/** deferred queue 에서 각 커밋에 적용할 git 작업 */
export type PendingDeferredCommitOperation = "cherry-pick" | "revert";

/** 충돌 커밋 후순위 적용 작업을 이어가기 위한 상태 */
export interface PendingDeferredCommitRebase {
  kind: PendingDeferredCommitRebaseKind;
  operation: PendingDeferredCommitOperation;
  label: string;
  destinationBranch: string;
  beforeHead: string;
  snapshotRef: string;
  sourceRef?: string;
  operationHead?: string;
  currentCommit?: string;
  remainingCommits: string[];
  preservedStashHash?: string;
  createdAt: number;
}

/**
 * 저장된 deferred rebase 상태를 읽는다.
 * - 파일이 없거나 현재 버전에서 이해할 수 없는 형태면 undefined 로 다룬다.
 * @param repoRoot git 저장소 루트
 * @returns 이어받을 deferred rebase 상태
 */
export async function readPendingDeferredCommitRebase(
  repoRoot: string
): Promise<PendingDeferredCommitRebase | undefined> {
  const file = await stateFilePath(repoRoot);
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }
  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * deferred rebase 상태를 git-dir 아래에 저장한다.
 * - 작업트리 파일을 만들지 않아 사용자의 변경 목록에 노출되지 않는다.
 * @param repoRoot git 저장소 루트
 * @param state 저장할 pending 상태
 */
export async function writePendingDeferredCommitRebase(
  repoRoot: string,
  state: PendingDeferredCommitRebase
): Promise<void> {
  const file = await stateFilePath(repoRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * 저장된 deferred rebase 상태를 제거한다.
 * - 작업 완료, abort, stash 정리가 끝난 뒤 중복 continue/복원을 막기 위해 호출한다.
 * @param repoRoot git 저장소 루트
 */
export async function clearPendingDeferredCommitRebase(
  repoRoot: string
): Promise<void> {
  const file = await stateFilePath(repoRoot);
  await fs.rm(file, { force: true });
}

/**
 * git-dir 안의 상태 파일 실제 경로를 계산한다.
 * - linked worktree 에서도 올바른 git metadata 경로를 얻기 위해 `git rev-parse --git-path` 를 사용한다.
 * @param repoRoot git 저장소 루트
 * @returns 상태 파일 절대 경로
 */
async function stateFilePath(repoRoot: string): Promise<string> {
  const raw = (await runGit(["rev-parse", "--git-path", STATE_GIT_PATH], repoRoot)).trim();
  return path.resolve(repoRoot, raw);
}

/**
 * JSON 값을 현재 코드가 사용할 수 있는 deferred rebase 상태로 검증한다.
 * @param value 상태 파일에서 읽은 임의 JSON 값
 * @returns 유효한 상태면 정규화된 상태, 아니면 undefined
 */
function normalizeState(value: unknown): PendingDeferredCommitRebase | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const item = value as Record<string, unknown>;
  if (
    !isKind(item.kind) ||
    typeof item.label !== "string" ||
    typeof item.destinationBranch !== "string" ||
    typeof item.beforeHead !== "string" ||
    typeof item.snapshotRef !== "string" ||
    !Array.isArray(item.remainingCommits)
  ) {
    return undefined;
  }
  const remainingCommits = item.remainingCommits.filter(
    (hash): hash is string => typeof hash === "string" && hash.length > 0
  );
  const sourceRef =
    typeof item.sourceRef === "string" && item.sourceRef ? item.sourceRef : undefined;
  const currentCommit =
    typeof item.currentCommit === "string" && item.currentCommit
      ? item.currentCommit
      : undefined;
  const operationHead =
    typeof item.operationHead === "string" && item.operationHead
      ? item.operationHead
      : undefined;
  const preservedStashHash =
    typeof item.preservedStashHash === "string" && item.preservedStashHash
      ? item.preservedStashHash
      : undefined;
  const createdAt =
    typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
      ? item.createdAt
      : 0;
  return {
    kind: item.kind,
    operation: isOperation(item.operation) ? item.operation : "cherry-pick",
    label: item.label,
    destinationBranch: item.destinationBranch,
    beforeHead: item.beforeHead,
    snapshotRef: item.snapshotRef,
    sourceRef,
    operationHead,
    currentCommit,
    remainingCommits,
    preservedStashHash,
    createdAt,
  };
}

/**
 * 상태 파일의 kind 값이 현재 지원하는 작업 종류인지 확인한다.
 * @param value JSON 에서 읽은 kind 후보
 * @returns 지원하는 deferred rebase kind 면 true
 */
function isKind(value: unknown): value is PendingDeferredCommitRebaseKind {
  return value === "pr-rebase" || value === "branch-rebase" || value === "pr-revert";
}

/**
 * 상태 파일의 operation 값이 현재 지원하는 적용 작업인지 확인한다.
 * @param value JSON 에서 읽은 operation 후보
 * @returns 지원하는 deferred operation 이면 true
 */
function isOperation(value: unknown): value is PendingDeferredCommitOperation {
  return value === "cherry-pick" || value === "revert";
}
