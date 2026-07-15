// 동일한 unmerged blob이 새 Git 작업에서 재현되는 ABA를 구분할 operation epoch를 계산한다.
// - Git operation marker의 내용과 inode/시간 identity를 함께 해시해 abort→재시작 경계를 고정한다.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { runGit } from "./gitExec";

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
export async function readConflictOperationEpoch(repoRoot: string): Promise<string> {
  const [gitDirText, head] = await Promise.all([
    runGit(["rev-parse", "--absolute-git-dir"], repoRoot),
    runGit(["rev-parse", "--verify", "HEAD"], repoRoot).catch(() => "unborn"),
  ]);
  const gitDir = gitDirText.trim();
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
