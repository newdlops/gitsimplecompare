// rebase edit 커밋을 수정하기 위한 임시 편집 파일 세션.
// - 과거 커밋의 파일 내용을 repo worktree 파일에 직접 묶지 않고, /tmp 파일로 편집하게 한다.
// - Continue 시 임시 파일 내용을 현재 edit 커밋의 대상 경로에 반영한 뒤 amend 할 수 있게 stage 한다.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGit, runGitLiteralPaths } from "./gitExec";
import { assertGitOperation, captureGitOperation, type GitOperationIdentity } from "./operationControl";
import { claimConflictWorkingLeaf, readConflictWorkingLeaf, type ConflictWorktreeClaim } from "./conflictWorktreeCas";
import { resolveSafeConflictWorkingPath } from "./conflictPathSafety";
import type { RebaseCommitFile, RebasePausedState } from "./rebaseService";

/** rebase edit diff 오른쪽에 열 임시 파일 정보 */
export interface RebaseEditTempFile {
  tempPath: string;
  relPath: string;
  leftRelPath: string;
}

interface RebaseEditEntry extends RebaseEditTempFile {
  repoRoot: string;
  pausedHash: string;
  originalHash?: string;
  tempDir: string;
  operation: GitOperationIdentity;
  workingVersion: string;
  indexEntry: string;
}

const sessions = new Map<string, RebaseEditEntry[]>();

/**
 * paused edit 커밋의 파일 내용을 임시 파일로 복사한다.
 * - 파일 내용은 worktree 가 아니라 `paused.hash:path` blob 에서 읽는다.
 * - 같은 파일을 다시 열면 기존 임시 파일을 재사용해 저장된 편집 내용을 유지한다.
 * @param repoRoot 저장소 루트
 * @param paused 현재 rebase edit 정지 상태
 * @param file drawer 에서 선택한 커밋 변경 파일
 * @returns diff 오른쪽에 열 임시 파일 경로와 기준 경로 정보
 */
export async function createRebaseEditTempFile(
  repoRoot: string,
  paused: RebasePausedState,
  file: RebaseCommitFile
): Promise<RebaseEditTempFile> {
  const existing = await findExistingTempFile(repoRoot, paused, file.path);
  if (existing) {
    return existing;
  }

  const operation = await captureGitOperation(repoRoot);
  const target = await resolveSafeConflictWorkingPath(repoRoot, file.path);
  const working = await readConflictWorkingLeaf(target);
  if (working.kind !== "regular") throw new Error("Rebase temporary editing requires a regular working file.");
  const workingVersion = working.version;
  const indexEntry = await readIndexEntry(repoRoot, file.path);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gsc-rebase-edit-"));
  const tempPath = path.join(dir, safeRelativePath(file.path));
  await fs.mkdir(path.dirname(tempPath), { recursive: true });
  const content = await readCommitFile(repoRoot, paused.hash, file.path);
  await fs.writeFile(tempPath, content, "utf8");

  const entry: RebaseEditEntry = {
    repoRoot,
    pausedHash: paused.hash,
    originalHash: paused.originalHash,
    tempDir: dir,
    relPath: file.path,
    leftRelPath: file.oldPath || file.path,
    tempPath,
    operation, workingVersion, indexEntry,
  };
  const next = sessionEntries(repoRoot)
    .filter((old) => !samePausedEntry(old, entry) || old.relPath !== entry.relPath);
  next.push(entry);
  sessions.set(repoRoot, next);
  return entry;
}

/** 이미 열린 같은 paused edit 파일의 임시 파일이 살아 있으면 반환한다. */
async function findExistingTempFile(
  repoRoot: string,
  paused: RebasePausedState,
  relPath: string
): Promise<RebaseEditTempFile | undefined> {
  const entry = matchingEntries(repoRoot, paused).find((item) => item.relPath === relPath);
  if (!entry) {
    return undefined;
  }
  try {
    await assertGitOperation(repoRoot, entry.operation);
    await fs.access(entry.tempPath);
    return entry;
  } catch {
    return undefined;
  }
}

/**
 * 현재 paused edit 커밋에 연결된 임시 파일 내용을 repo 경로에 반영하고 stage 한다.
 * - temp 파일 내용이 현재 HEAD 의 대상 파일과 다를 때만 작업트리에 쓰고 `git add` 한다.
 * - 반환된 경로는 이후 amend 여부 판단에 사용한다.
 * @param repoRoot 저장소 루트
 * @param paused 현재 rebase edit 정지 상태
 * @returns stage 대상이 된 저장소 상대 경로 목록
 */
export async function applyRebaseEditTempFiles(
  repoRoot: string,
  paused: RebasePausedState
): Promise<string[]> {
  const edits: { entry: RebaseEditEntry; edited: Buffer; target: string }[] = [];
  for (const entry of matchingEntries(repoRoot, paused)) {
    const edited = await fs.readFile(entry.tempPath).catch(() => undefined);
    if (edited === undefined) {
      continue;
    }
    const current = await readCommitFile(repoRoot, paused.hash, entry.relPath).catch(() => "");
    if (edited.equals(Buffer.from(current))) {
      continue;
    }
    await assertGitOperation(repoRoot, entry.operation);
    const target = await resolveSafeConflictWorkingPath(repoRoot, entry.relPath);
    if ((await readConflictWorkingLeaf(target)).version !== entry.workingVersion ||
        await readIndexEntry(repoRoot, entry.relPath) !== entry.indexEntry) {
      throw new Error(`'${entry.relPath}' changed after the rebase editor opened. Both versions were kept; reconcile the working file and '${entry.tempPath}' before continuing.`);
    }
    edits.push({ entry, edited, target });
  }
  // 모든 파일을 먼저 검사하고 원자적으로 claim하므로 마지막 파일 검증 실패도 앞 파일을 덮어쓰지 않는다.
  const claims: ConflictWorktreeClaim[] = [];
  let staged = false;
  try {
    for (const edit of edits) claims.push(await claimConflictWorkingLeaf(edit.target, edit.entry.workingVersion));
    for (const [index, edit] of edits.entries()) {
      await claims[index].install({ kind: "regular", buffer: edit.edited,
        mode: (claims[index].snapshot.mode ?? 0) & 0o111 ? "100755" : "100644" });
    }
    if (edits.length) await runGitLiteralPaths(["add", "--", ...edits.map(edit => edit.entry.relPath)], repoRoot, { retryOnLock: false });
    staged = true;
    for (const claim of claims) await claim.commit();
    for (const edit of edits) {
      edit.entry.workingVersion = (await readConflictWorkingLeaf(edit.target)).version;
      edit.entry.indexEntry = await readIndexEntry(repoRoot, edit.entry.relPath);
    }
  } finally {
    if (!staged) for (const claim of claims.reverse()) await claim.rollback();
  }
  return edits.map(edit => edit.entry.relPath);
}

/**
 * 완료된 paused edit 커밋의 임시 파일 세션을 정리한다.
 * - 파일 삭제 실패는 UI 동작에 영향을 주지 않으므로 무시한다.
 * @param repoRoot 저장소 루트
 * @param paused 정리할 rebase edit 정지 상태
 */
export async function cleanupRebaseEditTempFiles(
  repoRoot: string,
  paused: RebasePausedState
): Promise<void> {
  const keep: RebaseEditEntry[] = [];
  for (const entry of sessionEntries(repoRoot)) {
    if (matchesPaused(entry, paused)) {
      await fs.rm(entry.tempDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      keep.push(entry);
    }
  }
  sessions.set(repoRoot, keep);
}

/**
 * 현재 paused edit 상태와 연결된 임시 파일 경로를 반환한다.
 * - Continue 직전에 VS Code 의 dirty temp 문서만 저장하기 위해 UI 레이어에서 사용한다.
 * @param repoRoot 저장소 루트
 * @param paused 현재 rebase edit 정지 상태
 */
export function listRebaseEditTempPaths(
  repoRoot: string,
  paused: RebasePausedState
): string[] {
  return matchingEntries(repoRoot, paused).map((entry) => entry.tempPath);
}

/** 저장소별 메모리 세션 목록을 반환한다. */
function sessionEntries(repoRoot: string): RebaseEditEntry[] {
  return sessions.get(repoRoot) ?? [];
}

/** 같은 paused edit 지점에 속한 임시 파일인지 확인한다. */
function samePausedEntry(a: RebaseEditEntry, b: RebaseEditEntry): boolean {
  return a.pausedHash === b.pausedHash || (
    Boolean(a.originalHash) && a.originalHash === b.originalHash
  );
}

/** 현재 paused edit 상태에 연결되는 세션만 반환한다. */
function matchingEntries(
  repoRoot: string,
  paused: RebasePausedState
): RebaseEditEntry[] {
  return sessionEntries(repoRoot).filter((entry) => matchesPaused(entry, paused));
}

/** 세션 항목이 현재 paused edit 상태와 같은 원본 커밋을 가리키는지 확인한다. */
function matchesPaused(entry: RebaseEditEntry, paused: RebasePausedState): boolean {
  return entry.pausedHash === paused.hash || (
    Boolean(entry.originalHash) && entry.originalHash === paused.originalHash
  );
}

/** commit 의 파일 blob 을 텍스트로 읽는다. */
function readCommitFile(
  repoRoot: string,
  ref: string,
  relPath: string
): Promise<string> {
  return runGit(["show", `${ref}:${relPath}`], repoRoot);
}

/** 임시 디렉터리 내부에 안전하게 만들 수 있는 상대 경로로 정규화한다. */
function safeRelativePath(relPath: string): string {
  return relPath.split(/[\\/]+/).filter((part) => part && part !== "..").join(path.sep);
}

/** 파일을 열 때의 stage 정보를 비교하기 위해 literal 경로의 index 행을 읽는다. */
async function readIndexEntry(repoRoot: string, relative: string): Promise<string> {
  return runGitLiteralPaths(["ls-files", "--stage", "-z", "--", relative], repoRoot);
}
