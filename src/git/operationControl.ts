// Continue/Skip/Abort를 확인한 Git 작업 세대에 고정하고 후속 복구에 실행 영수증을 전달한다.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { detectOperationInGitDir, type MergeOperation } from "./conflictService";
import { readConflictOperationEpochAt } from "./conflictOperationEpoch";
import { runGit } from "./gitExec";
import { preserveOperationEdits } from "./operationRecoveryBackup";
import { logError, logInfo } from "../ui/outputLog";
import { finishControlledRebaseSession } from "./rebaseSessionState";

/** worktree, 작업 생성 세대와 현재 todo/HEAD를 함께 고정한 제어 대상이다. */
export interface GitOperationIdentity {
  gitDir: string;
  operation: MergeOperation;
  generation: string;
  epoch: string;
  head: string;
  branch: string;
}
type ControlAction = "continue" | "skip" | "abort";
interface ControlReceipt {
  action: ControlAction;
  before: GitOperationIdentity;
  after: GitOperationIdentity;
}

/**
 * 현재 작업의 실제 git-dir와 생성 세대/현재 항목을 읽는다. 조회 실패는 전파한다.
 * @param repoRoot 제어할 worktree 경로
 * @returns 확인창과 실행 직전 비교에 사용할 불변 값
 */
export async function captureGitOperation(repoRoot: string): Promise<GitOperationIdentity> {
  const [gitDirText, head, branch] = await Promise.all([
    runGit(["rev-parse", "--absolute-git-dir"], repoRoot),
    runGit(["rev-parse", "--verify", "HEAD"], repoRoot),
    runGit(["branch", "--show-current"], repoRoot),
  ]);
  const gitDir = await realpath(gitDirText.trim());
  const operation = detectOperationInGitDir(gitDir);
  const [epoch, generation] = await Promise.all([
    readConflictOperationEpochAt(gitDir, head), operationGeneration(gitDir, operation),
  ]);
  return { gitDir, operation, epoch, generation, head: head.trim(), branch: branch.trim() };
}

/** 확인한 작업이 현재 항목까지 같은지 검증한다. 외부 abort→동일 작업 재시작도 거부한다. */
export async function assertGitOperation(repoRoot: string, expected: GitOperationIdentity): Promise<void> {
  if (!sameIdentity(await captureGitOperation(repoRoot), expected)) throw changedOperation();
}

/**
 * 이미 확인한 작업을 다시 검증하고 Git 제어 명령을 한 번만 실행한다.
 * @param expected 확인창 이전 대상. 없으면 호출 시점의 작업을 고정한다.
 * @param env Continue/Skip에서 사용할 Git editor 환경
 */
export async function controlGitOperation(
  repoRoot: string,
  operation: MergeOperation,
  action: ControlAction,
  expected?: GitOperationIdentity,
  env: Record<string, string> = {}
): Promise<void> {
  const before = expected ?? await captureGitOperation(repoRoot);
  if (before.operation !== operation || operation === "none") throw changedOperation();
  await assertGitOperation(repoRoot, before);
  if (action === "abort" || action === "skip") {
    if (operation === "rebase") await assertNoUnrelatedUnstagedChanges(repoRoot);
    await preserveOperationEdits(repoRoot, before.gitDir, action);
  }
  await assertGitOperation(repoRoot, before);
  let failure: unknown;
  const nativeStarted = Date.now();
  try {
    await runGit([operation, `--${action}`], repoRoot, { env, retryOnLock: false });
  } catch (error) {
    failure = error;
  }
  const gitElapsedMs = Date.now() - nativeStarted;
  // 다음 충돌로 비정상 종료해도 원래 오류를 보존하면서 실행 전후의 작업만 기록한다.
  try {
    const receipt: ControlReceipt = { action, before, after: await captureGitOperation(repoRoot) };
    const file = receiptFile(before.gitDir);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 });
    await rename(temporary, file);
    logInfo("git operation controlled", { repoRoot, operation, action, generation: before.generation, gitElapsedMs });
    await finishControlledRebaseSession(repoRoot, before, receipt.after, action).catch(error => {
      // UI 세션 저장 실패 때문에 이미 수행한 Git 명령을 재실행하지 않는다. 복원 시 세대 검증도 별도로 수행한다.
      logError("ended rebase session could not be recorded", error, { repoRoot, operation, action });
    });
  } catch (error) {
    if (!failure) throw error;
  }
  if (failure) throw failure;
}

/**
 * 저장된 pending 작업이 확장에서 방금 Continue/Skip/Abort한 작업인지 확인한다.
 * @param expected 충돌이 발생했을 때 저장한 작업. 출처 없는 이전 기록은 자동 채택하지 않는다.
 * @param action 요구하는 제어 동작. Continue는 Skip 완료도 수용한다.
 */
export async function assertControlledTransition(
  repoRoot: string,
  expected: GitOperationIdentity | undefined,
  action: "continue" | "abort"
): Promise<void> {
  if (!expected) throw changedOperation();
  const current = await captureGitOperation(repoRoot);
  let receipt: ControlReceipt;
  try {
    receipt = JSON.parse(await readFile(receiptFile(current.gitDir), "utf8"));
  } catch {
    throw changedOperation();
  }
  if (!receipt.before || !receipt.after ||
      !(receipt.action === action || (action === "continue" && receipt.action === "skip")) ||
      receipt.before.gitDir !== expected.gitDir || receipt.before.operation !== expected.operation ||
      receipt.before.generation !== expected.generation || !expected.generation ||
      !sameIdentity(receipt.after, current)) throw changedOperation();
  // cherry-pick/revert의 한 커밋 큐는 같은 HEAD와 같은 marker 항목까지 소유해야 한다.
  if (expected.operation !== "rebase" && !sameIdentity(receipt.before, expected)) throw changedOperation();
}

/** rebase --abort/--skip이 reset으로 지울 수 있는 다른 파일의 새 편집은 그대로 두고 멈춘다. */
async function assertNoUnrelatedUnstagedChanges(repoRoot: string): Promise<void> {
  const [unmerged, unstaged] = await Promise.all([
    runGit(["diff", "--name-only", "--diff-filter=U", "-z"], repoRoot),
    runGit(["diff", "--name-only", "-z"], repoRoot),
  ]);
  const conflicts = new Set(unmerged.split("\0").filter(Boolean));
  const other = unstaged.split("\0").filter(file => file && !conflicts.has(file));
  if (other.length) throw new Error(`Git operation was left unchanged because these files have new unstaged edits: ${other.join(", ")}. Preserve these edits separately before retrying.`);
}

/** rebase의 진행 중 바뀌는 todo와 독립된 디렉터리 생성 세대, 또는 단일 작업 marker를 해시한다. */
async function operationGeneration(gitDir: string, operation: MergeOperation): Promise<string> {
  if (operation === "none") return "";
  const candidates = operation === "rebase" ? ["rebase-merge", "rebase-apply"]
    : [operation === "merge" ? "MERGE_HEAD" : operation === "revert" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD"];
  for (const candidate of candidates) {
    const absolute = path.join(gitDir, candidate);
    try {
      const info = await lstat(absolute);
      const metadata = info.isDirectory()
        ? await Promise.all(["head-name", "orig-head", "onto"].map(file => readFile(path.join(absolute, file), "utf8")))
        : [await readFile(absolute, "utf8")];
      return createHash("sha256").update(JSON.stringify([gitDir, candidate, info.dev, info.ino, info.birthtimeMs, metadata])).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw changedOperation();
}

/** 직렬화 속성 순서에 의존하지 않고 실행 대상의 모든 필드를 비교한다. */
function sameIdentity(a: GitOperationIdentity, b: GitOperationIdentity): boolean {
  return a.gitDir === b.gitDir && a.operation === b.operation && a.generation === b.generation &&
    a.epoch === b.epoch && a.head === b.head && a.branch === b.branch;
}

/** 영수증을 해당 worktree의 전용 Git 메타데이터 안에만 보관한다. */
function receiptFile(gitDir: string): string {
  return path.join(gitDir, "gitsimplecompare", "operation-control.json");
}

/** 작업 경계 검증 실패 시 복구 자료를 남긴 채 사용자가 현재 상태를 다시 확인하도록 안내한다. */
function changedOperation(): Error {
  return new Error("The Git operation changed or its ownership could not be verified. Refresh the repository and retry. Recovery snapshots were kept.");
}
