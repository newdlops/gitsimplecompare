// 동일한 unmerged blob이 새 Git 작업에서 재현되는 ABA를 구분할 operation epoch를 계산한다.
// - Git operation marker의 내용과 inode/시간 identity를 함께 해시해 abort→재시작 경계를 고정한다.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { GitError, runGit } from "./gitExec";
import type { MergeOperation } from "./conflictService";

const OPERATION_PATHS = [
  "MERGE_HEAD",
  "AUTO_MERGE",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-merge/head-name",
  "rebase-merge/orig-head",
  "rebase-merge/onto",
  "rebase-merge/stopped-sha",
  "rebase-merge/done",
  "rebase-merge/git-rebase-todo",
  "rebase-apply",
  "rebase-apply/head-name",
  "rebase-apply/orig-head",
  "rebase-apply/onto",
  "rebase-apply/next",
  "rebase-apply/last",
] as const;

/**
 * 현재 HEAD와 operation marker snapshot을 opaque epoch로 만든다.
 * @param repoRoot 대상 저장소 루트
 * @returns 같은 stage blob이어도 Git 작업이 새로 시작되면 달라지는 SHA-256 epoch
 */
export async function readConflictOperationEpoch(repoRoot: string, signal?: AbortSignal): Promise<string> {
  return (await readConflictOperationSnapshot(repoRoot, signal)).epoch;
}

/**
 * 같은 읽기 안의 operation 판별과 epoch가 Git directory/HEAD 조회 하나를 공유한다.
 * - 호출 간 캐시는 없으며 marker 내용과 identity는 매번 새로 읽는다.
 * - unborn HEAD에서도 rev-parse가 먼저 출력한 실제 Git directory만 사용한다.
 * @returns 이번 조회의 작업 종류와 mutation/metadata 재검증에 사용할 epoch
 */
export async function readConflictOperationSnapshot(
  repoRoot: string, signal?: AbortSignal
): Promise<{ operation: MergeOperation; epoch: string }> {
  let output: string, unborn = false;
  try { output = await runGit(["rev-parse", "--absolute-git-dir", "--verify", "HEAD"], repoRoot, { signal }); }
  catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof GitError) || error.code !== 128 || !error.stdout) throw error;
    output = error.stdout; unborn = true;
  }
  const lineEnd = output.endsWith("\r\n") ? "\r\n" : "\n";
  const match = new RegExp(`${lineEnd}([0-9a-f]{40}|[0-9a-f]{64})${lineEnd}$`).exec(output);
  if (!match && !unborn) throw new Error("Cannot verify the current conflict operation.");
  const gitDir = match ? output.slice(0, match.index) : output.slice(0, -lineEnd.length);
  if (!path.isAbsolute(gitDir)) throw new Error("Cannot verify the conflict Git directory.");
  const operation = detectOperationInGitDir(gitDir);
  const epoch = await readConflictOperationEpochAt(gitDir, match?.[1] ?? "unborn");
  signal?.throwIfAborted();
  return { operation, epoch };
}

/** 현재 worktree의 Git directory에서 작업 marker를 검사한다. stale REBASE_HEAD는 판별에서 제외한다. */
export function detectOperationInGitDir(gitDir: string): MergeOperation {
  const has = (name: string): boolean => fs.existsSync(path.join(gitDir, name));
  if (has("rebase-merge") || has("rebase-apply")) return "rebase";
  if (has("MERGE_HEAD")) return "merge";
  if (has("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (has("REVERT_HEAD")) return "revert";
  return "none";
}

/**
 * 같은 검증 시점에 이미 읽은 git-dir와 HEAD로 marker를 새로 읽는다.
 * - 호출 사이의 캐시는 두지 않아 abort·재시작과 todo 변경 검증을 그대로 유지한다.
 * @param gitDir 현재 worktree의 실제 Git directory
 * @param head 이번 snapshot에서 읽은 HEAD 또는 unborn 표시
 * @returns 현재 marker identity와 HEAD를 모두 포함한 epoch
 */
export async function readConflictOperationEpochAt(gitDir: string, head: string): Promise<string> {
  const parts = await Promise.all(
    OPERATION_PATHS.map((rel) => operationPathIdentity(gitDir, rel, true))
  );
  const digest = createHash("sha256")
    .update(`HEAD\0${head.trim()}\0`)
    .update(parts.join("\0"))
    .digest("hex");
  return `operation:${digest}`;
}

/**
 * operation marker 한 항목의 존재와 inode/시간 identity를 직렬화한다.
 * @param gitDir 현재 worktree의 실제 Git directory
 * @param rel Git directory 아래 marker 상대 경로
 * @param includeContent 작은 operation metadata의 원문 hash까지 포함할지 여부
 */
async function operationPathIdentity(
  gitDir: string,
  rel: string,
  includeContent: boolean
): Promise<string> {
  const absolute = path.join(gitDir, rel);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${rel}:absent`;
    throw error;
  }
  const identity = [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
    stat.birthtimeMs,
  ].join(":");
  if (!stat.isFile() || !includeContent) return `${rel}:node:${identity}`;
  const content = await fs.promises.readFile(absolute);
  return `${rel}:file:${identity}:${createHash("sha256").update(content).digest("hex")}`;
}
