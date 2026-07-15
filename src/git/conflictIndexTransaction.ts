// 충돌 stage 0 갱신을 실제 Git index.lock 임계 구역 안에서 원자적으로 게시한다.
// - linked worktree/split-index의 실제 index를 sibling index에서 수정하고 소유 lock을 통해 게시한다.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { runGit } from "./gitExec";

/** transaction 안의 Git 명령이 동일한 sibling index를 읽고 쓰게 하는 환경이다. */
export interface ConflictIndexTransactionContext {
  indexEnv: Record<string, string>;
}

const LOCK_RETRY_DELAYS_MS = [250, 500, 900, 1400, 2000];

/**
 * 실제 index.lock을 소유한 동안 caller 작업을 실행하고 선택적으로 sibling index를 게시한다.
 * @param repoRoot 대상 저장소 또는 linked worktree 루트
 * @param publishIndex true면 callback이 수정한 sibling index를 실제 index로 원자 교체한다
 * @param action lock 안에서 source 검증, worktree CAS, update-index를 수행하는 callback
 * @returns callback의 반환값
 */
export async function withConflictIndexTransaction<T>(
  repoRoot: string,
  publishIndex: boolean,
  action: (context: ConflictIndexTransactionContext) => Promise<T>
): Promise<T> {
  const indexPath = await resolveIndexPath(repoRoot);
  const lockPath = `${indexPath}.lock`;
  const lock = await acquireIndexLock(lockPath);
  let identity: fs.Stats | undefined;
  let tempPath: string | undefined;
  let closed = false;
  let published = false;
  let released = false;
  try {
    identity = await lock.stat();
    tempPath = siblingTempPath(indexPath);
    await fs.promises.copyFile(indexPath, tempPath, fs.constants.COPYFILE_EXCL);
    const result = await action({ indexEnv: { GIT_INDEX_FILE: tempPath } });
    if (publishIndex) {
      const bytes = await fs.promises.readFile(tempPath);
      await lock.truncate(0);
      await lock.writeFile(bytes);
      await lock.sync();
      await assertOwnedLock(lockPath, identity);
      await lock.close();
      closed = true;
      await assertOwnedLock(lockPath, identity);
      await fs.promises.rename(lockPath, indexPath);
      published = true;
    } else {
      await lock.close();
      closed = true;
      await assertOwnedLock(lockPath, identity);
      await fs.promises.unlink(lockPath);
      released = true;
    }
    return result;
  } finally {
    if (!closed) await lock.close().catch(() => undefined);
    if (!published && !released && identity) await removeOwnedLock(lockPath, identity);
    if (tempPath) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      await fs.promises.rm(`${tempPath}.lock`, { force: true }).catch(() => undefined);
    }
  }
}

/** `git rev-parse --git-path index`로 linked worktree를 포함한 실제 index 경로를 찾는다. */
async function resolveIndexPath(repoRoot: string): Promise<string> {
  const raw = (await runGit(["rev-parse", "--git-path", "index"], repoRoot)).trim();
  return path.resolve(repoRoot, raw);
}

/** 표준 index.lock을 O_EXCL로 열어 다른 Git writer와 같은 직렬화 규칙을 따른다. */
async function acquireIndexLock(lockPath: string): Promise<fs.promises.FileHandle> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.promises.open(lockPath, "wx");
    } catch (error) {
      if (!isAlreadyExists(error) || attempt >= LOCK_RETRY_DELAYS_MS.length) {
        if (isAlreadyExists(error)) {
          throw new Error("Another Git process is updating the index. Try the conflict action again.");
        }
        throw error;
      }
      await delay(LOCK_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** 같은 index 디렉터리에 충돌하지 않을 확률이 충분히 높은 sibling 임시 경로를 만든다. */
function siblingTempPath(indexPath: string): string {
  const nonce = randomBytes(12).toString("hex");
  return path.join(path.dirname(indexPath), `.gsc-conflict-index-${process.pid}-${nonce}`);
}

/** lock 경로가 처음 O_EXCL로 연 inode와 같은지 dev/ino로 확인한다. */
async function assertOwnedLock(lockPath: string, identity: fs.Stats): Promise<void> {
  const current = await fs.promises.lstat(lockPath).catch(() => undefined);
  if (!current || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error("The Git index lock changed during conflict resolution. The index was not published.");
  }
}

/** 실패 정리 시 다른 writer의 lock을 지우지 않고 자신이 만든 inode만 제거한다. */
async function removeOwnedLock(lockPath: string, identity: fs.Stats): Promise<void> {
  const current = await fs.promises.lstat(lockPath).catch(() => undefined);
  if (current && current.dev === identity.dev && current.ino === identity.ino) {
    await fs.promises.unlink(lockPath).catch(() => undefined);
  }
}

/** Node 파일 오류가 이미 존재하는 lock 충돌인지 판별한다. */
function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

/** index lock 재시도 사이에 이벤트 루프를 막지 않고 지정 시간만 기다린다. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
