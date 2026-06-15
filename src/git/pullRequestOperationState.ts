// PR rebase 충돌을 이어가기 위한 임시 상태 저장 모듈.
// - 확장이 재시작되거나 사용자가 Conflicts 뷰에서 continue/abort 를 누르는 시점에도
//   목적 브랜치, undo snapshot, 보존 stash 를 다시 찾을 수 있게 git-dir 아래에 기록한다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit } from "./gitExec";

const STATE_GIT_PATH = "gitsimplecompare/pr-rebase-state.json";

/** PR rebase 가 충돌로 멈췄을 때 후속 처리에 필요한 상태 */
export interface PendingPullRequestRebase {
  kind: "rebase";
  number: number;
  destinationBranch: string;
  beforeHead: string;
  snapshotRef: string;
  sourceBranch: string;
  preservedStashHash?: string;
  createdAt: number;
}

/**
 * 저장된 PR rebase 상태를 읽는다.
 * - 파일이 없거나 현재 버전에서 이해할 수 없는 형태면 undefined 로 다룬다.
 * @param repoRoot git 저장소 루트
 * @returns 이어받을 PR rebase 상태
 */
export async function readPendingPullRequestRebase(
  repoRoot: string
): Promise<PendingPullRequestRebase | undefined> {
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
 * PR rebase 상태를 git-dir 아래에 저장한다.
 * - 작업트리를 더럽히지 않도록 `.git/gitsimplecompare` 영역만 사용한다.
 * @param repoRoot git 저장소 루트
 * @param state 저장할 PR rebase 상태
 */
export async function writePendingPullRequestRebase(
  repoRoot: string,
  state: PendingPullRequestRebase
): Promise<void> {
  const file = await stateFilePath(repoRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * 저장된 PR rebase 상태를 제거한다.
 * - rebase 완료, undo, abort, stash 정리가 끝난 뒤 중복 복원을 막기 위해 호출한다.
 * @param repoRoot git 저장소 루트
 */
export async function clearPendingPullRequestRebase(
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
 * JSON 값을 현재 코드가 사용할 수 있는 PR rebase 상태로 검증한다.
 * @param value 상태 파일에서 읽은 임의 JSON 값
 * @returns 유효한 상태면 정규화된 상태, 아니면 undefined
 */
function normalizeState(value: unknown): PendingPullRequestRebase | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const item = value as Record<string, unknown>;
  if (
    item.kind !== "rebase" ||
    typeof item.number !== "number" ||
    typeof item.destinationBranch !== "string" ||
    typeof item.beforeHead !== "string" ||
    typeof item.snapshotRef !== "string" ||
    typeof item.sourceBranch !== "string"
  ) {
    return undefined;
  }
  const preserved =
    typeof item.preservedStashHash === "string" && item.preservedStashHash
      ? item.preservedStashHash
      : undefined;
  const createdAt =
    typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
      ? item.createdAt
      : 0;
  return {
    kind: "rebase",
    number: item.number,
    destinationBranch: item.destinationBranch,
    beforeHead: item.beforeHead,
    snapshotRef: item.snapshotRef,
    sourceBranch: item.sourceBranch,
    preservedStashHash: preserved,
    createdAt,
  };
}
