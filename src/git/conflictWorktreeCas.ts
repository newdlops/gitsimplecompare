// 충돌 작업 파일 leaf를 원자적으로 격리해 외부 편집을 덮어쓰거나 삭제하지 않는 CAS를 제공한다.
// - index는 다루지 않으며 caller가 index transaction 성공/실패 뒤 commit 또는 rollback을 호출한다.
import * as fs from "node:fs";
import * as path from "node:path";
import { hashWorkingResult } from "./conflictContentIdentity";

/** 작업트리 leaf의 원본 바이트와 CAS version을 함께 보존한 snapshot이다. */
export interface ConflictWorkingLeafSnapshot {
  kind: "absent" | "regular" | "symlink" | "nonfile";
  version: string;
  mode?: number;
  buffer?: Buffer;
  identity?: fs.Stats;
}

/** CAS 뒤 작업트리에 설치할 exact leaf 종류다. */
export type ConflictDesiredLeaf =
  | { kind: "absent" }
  | { kind: "regular"; buffer: Buffer; mode: "100644" | "100755" }
  | { kind: "symlink"; target: Buffer };

/** index 게시 결과에 맞춰 격리본을 정리하거나 원상 복구하는 worktree claim이다. */
export interface ConflictWorktreeClaim {
  snapshot: ConflictWorkingLeafSnapshot;
  install(desired: ConflictDesiredLeaf): Promise<void>;
  commit(): Promise<string | undefined>;
  rollback(): Promise<void>;
}

/**
 * 현재 leaf를 raw bytes와 lstat mode가 같은 snapshot으로 읽는다.
 * @param absolute 검증된 저장소 내부 절대 경로
 * @returns regular/symlink/absent/nonfile snapshot과 CAS version
 */
export async function readConflictWorkingLeaf(
  absolute: string
): Promise<ConflictWorkingLeafSnapshot> {
  const stat = await lstatIfPresent(absolute);
  if (!stat) return { kind: "absent", version: "worktree:absent" };
  if (stat.isSymbolicLink()) {
    const target = await fs.promises.readlink(absolute, { encoding: "buffer" });
    return {
      kind: "symlink",
      version: hashWorkingResult("symlink", stat.mode, target, stat),
      mode: stat.mode,
      buffer: target,
      identity: stat,
    };
  }
  if (!stat.isFile()) {
    return {
      kind: "nonfile",
      version: `worktree:non-file:${stat.mode}:${stat.size}:${stat.mtimeMs}`,
      mode: stat.mode,
      identity: stat,
    };
  }
  const handle = await fs.promises.open(
    absolute,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw staleResultError();
    const buffer = await handle.readFile();
    return {
      kind: "regular",
      version: hashWorkingResult("file", opened.mode, buffer, opened),
      mode: opened.mode,
      buffer,
      identity: opened,
    };
  } finally {
    await handle.close();
  }
}

/**
 * leaf를 sibling transaction 디렉터리로 rename해 원자적으로 소유하고 expected version을 검증한다.
 * @param absolute 검증된 저장소 내부 절대 경로
 * @param expectedVersion 패널이 표시한 작업트리 version. 없으면 claim 시점 값을 수용한다.
 * @returns desired 설치와 index 결과 후 정리를 담당할 claim
 */
export async function claimConflictWorkingLeaf(
  absolute: string,
  expectedVersion?: string
): Promise<ConflictWorktreeClaim> {
  const parentFence = await captureParentDirectory(path.dirname(absolute));
  const transactionDir = await fs.promises.mkdtemp(
    path.join(path.dirname(absolute), ".gsc-conflict-")
  );
  await assertParentDirectory(parentFence).catch(async (error) => {
    await fs.promises.rmdir(transactionDir).catch(() => undefined);
    throw error;
  });
  const originalPath = path.join(transactionDir, "original");
  let moved = false;
  try {
    await assertParentDirectory(parentFence);
    await fs.promises.rename(absolute, originalPath);
    moved = true;
  } catch (error) {
    if (!isMissing(error)) {
      await fs.promises.rmdir(transactionDir).catch(() => undefined);
      throw error;
    }
  }
  if (moved) {
    await assertParentDirectory(parentFence).catch(() => {
      throw recoveryError(transactionDir);
    });
  }
  let snapshot: ConflictWorkingLeafSnapshot;
  try {
    snapshot = moved
      ? await readConflictWorkingLeaf(originalPath)
      : { kind: "absent", version: "worktree:absent" };
  } catch (error) {
    const restored = moved && await restoreUnreadableOriginal(absolute, originalPath);
    if (restored) await fs.promises.rmdir(transactionDir).catch(() => undefined);
    if (!restored) throw recoveryError(transactionDir);
    throw error;
  }
  if (snapshot.kind === "nonfile" || (expectedVersion !== undefined && snapshot.version !== expectedVersion)) {
    await assertParentDirectory(parentFence);
    const restored = await restoreOriginal(absolute, originalPath, snapshot);
    if (restored) await fs.promises.rmdir(transactionDir).catch(() => undefined);
    if (!restored) throw recoveryError(transactionDir);
    if (snapshot.kind === "nonfile") {
      throw new Error("Manual Result editing is not available for symlink, directory, or other non-regular file conflicts.");
    }
    throw staleResultError();
  }
  return createClaim(absolute, transactionDir, originalPath, snapshot, parentFence);
}

/** 검증된 quarantine과 새 desired leaf의 생애주기를 묶은 claim 구현을 만든다. */
function createClaim(
  absolute: string,
  transactionDir: string,
  originalPath: string,
  snapshot: ConflictWorkingLeafSnapshot,
  parentFence: ParentDirectoryFence
): ConflictWorktreeClaim {
  const desiredPath = path.join(transactionDir, "desired");
  let desiredIdentity: fs.Stats | undefined;
  let installedIdentity: fs.Stats | undefined;
  let installedVersion: string | undefined;
  return {
    snapshot,
    async install(desired): Promise<void> {
      await assertParentDirectory(parentFence);
      if (desired.kind === "absent") return;
      if (desired.kind === "regular") {
        const createMode = desiredWorktreeMode(snapshot, desired.mode);
        const handle = await fs.promises.open(desiredPath, "wx", createMode);
        try {
          await handle.writeFile(desired.buffer);
          if (snapshot.kind === "regular") await handle.chmod(createMode);
          await handle.sync();
          desiredIdentity = await handle.stat();
          installedVersion = hashWorkingResult(
            "file",
            desiredIdentity.mode,
            desired.buffer,
            desiredIdentity
          );
        } finally {
          await handle.close();
        }
        await assertParentDirectory(parentFence);
        await fs.promises.link(desiredPath, absolute);
        await assertParentDirectory(parentFence);
        installedIdentity = desiredIdentity;
      } else {
        await fs.promises.symlink(desired.target, desiredPath);
        desiredIdentity = await fs.promises.lstat(desiredPath);
        await assertParentDirectory(parentFence);
        await fs.promises.symlink(desired.target, absolute);
        await assertParentDirectory(parentFence);
        installedIdentity = await fs.promises.lstat(absolute);
        installedVersion = hashWorkingResult(
          "symlink",
          installedIdentity.mode,
          desired.target,
          installedIdentity
        );
      }
    },
    async commit(): Promise<string | undefined> {
      const originalRemoved = await unlinkIfOwnedAndUnchanged(
        originalPath, snapshot.identity, snapshot.version
      );
      await unlinkIfOwned(desiredPath, desiredIdentity);
      const directoryRemoved = await fs.promises.rmdir(transactionDir)
        .then(() => true)
        .catch(() => false);
      return originalRemoved && directoryRemoved ? undefined : transactionDir;
    },
    async rollback(): Promise<void> {
      await assertParentDirectory(parentFence).catch(() => {
        throw recoveryError(transactionDir);
      });
      const current = await lstatIfPresent(absolute).catch(() => {
        throw recoveryError(transactionDir);
      });
      if (
        sameIdentity(current, installedIdentity) &&
        await pathHasVersion(absolute, installedVersion)
      ) {
        await fs.promises.unlink(absolute).catch(() => undefined);
      }
      const restored = await restoreOriginal(absolute, originalPath, snapshot);
      if (!restored) throw recoveryError(transactionDir);
      await cleanupKnown(transactionDir, desiredPath, desiredIdentity);
    },
  };
}

/** claim이 시작된 실제 parent directory의 inode와 canonical 경로를 고정한 fence다. */
interface ParentDirectoryFence {
  lexicalPath: string;
  realPath: string;
  dev: number;
  ino: number;
}

/** leaf 격리 전에 parent directory의 canonical path와 inode identity를 캡처한다. */
async function captureParentDirectory(parent: string): Promise<ParentDirectoryFence> {
  const [realPath, stat] = await Promise.all([
    fs.promises.realpath(parent),
    fs.promises.stat(parent),
  ]);
  if (!stat.isDirectory()) throw new Error("Conflict path parent is not a directory.");
  return { lexicalPath: parent, realPath, dev: stat.dev, ino: stat.ino };
}

/** await 경계마다 parent가 같은 canonical directory인지 다시 확인해 symlink 교체를 거부한다. */
async function assertParentDirectory(fence: ParentDirectoryFence): Promise<void> {
  let realPath: string;
  let stat: fs.Stats;
  try {
    [realPath, stat] = await Promise.all([
      fs.promises.realpath(fence.lexicalPath),
      fs.promises.stat(fence.lexicalPath),
    ]);
  } catch {
    throw new Error("Conflict path parent changed during resolution.");
  }
  if (!stat.isDirectory() || realPath !== fence.realPath || stat.dev !== fence.dev || stat.ino !== fence.ino) {
    throw new Error("Conflict path parent changed during resolution.");
  }
}

/** 원본 일반 파일 권한을 보존하면서 Git owner-executable bit만 선택 stage mode에 맞춘다. */
function desiredWorktreeMode(
  snapshot: ConflictWorkingLeafSnapshot,
  gitMode: "100644" | "100755"
): number {
  if (snapshot.kind !== "regular" || snapshot.mode === undefined) {
    return gitMode === "100755" ? 0o755 : 0o644;
  }
  const permissions = snapshot.mode & 0o777;
  return gitMode === "100755" ? permissions | 0o100 : permissions & ~0o100;
}

/** snapshot 읽기 전에 실패한 quarantine을 hard-link no-clobber 방식으로 원래 경로에 되돌린다. */
async function restoreUnreadableOriginal(
  absolute: string,
  originalPath: string
): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(originalPath);
    if (stat.isFile()) {
      await fs.promises.link(originalPath, absolute);
    } else if (stat.isSymbolicLink()) {
      const target = await fs.promises.readlink(originalPath, { encoding: "buffer" });
      await fs.promises.symlink(target, absolute);
    } else {
      return false;
    }
    await fs.promises.unlink(originalPath);
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    return false;
  }
}

/** original quarantine을 외부 target을 덮지 않는 방식으로 원래 경로에 복구한다. */
async function restoreOriginal(
  absolute: string,
  originalPath: string,
  snapshot: ConflictWorkingLeafSnapshot
): Promise<boolean> {
  if (snapshot.kind === "absent") return true;
  try {
    if (snapshot.kind === "regular") {
      await fs.promises.link(originalPath, absolute);
      await fs.promises.unlink(originalPath);
      return true;
    }
    if (snapshot.kind === "symlink") {
      await fs.promises.symlink(snapshot.buffer!, absolute);
      await fs.promises.unlink(originalPath);
      return true;
    }
    if (await lstatIfPresent(absolute)) return false;
    await fs.promises.rename(originalPath, absolute);
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  }
}

/** transaction 내부의 알려진 desired inode만 지우고 외부가 만든 항목은 보존한다. */
async function cleanupKnown(
  transactionDir: string,
  desiredPath: string,
  desiredIdentity: fs.Stats | undefined
): Promise<void> {
  await unlinkIfOwned(desiredPath, desiredIdentity);
  await fs.promises.rmdir(transactionDir).catch(() => undefined);
}

/** 경로가 예상한 dev/ino와 같을 때만 unlink해 외부 교체 파일을 건드리지 않는다. */
async function unlinkIfOwned(target: string, identity: fs.Stats | undefined): Promise<void> {
  const current = await lstatIfPresent(target).catch(() => undefined);
  if (sameIdentity(current, identity)) await fs.promises.unlink(target).catch(() => undefined);
}

/** quarantine 원본이 claim 이후 바뀌지 않았을 때만 마지막 링크를 제거한다. */
async function unlinkIfOwnedAndUnchanged(
  target: string,
  identity: fs.Stats | undefined,
  version: string
): Promise<boolean> {
  let current: fs.Stats | undefined;
  try {
    current = await lstatIfPresent(target);
  } catch {
    return false;
  }
  if (!current) return true;
  if (sameIdentity(current, identity) && await pathHasVersion(target, version)) {
    return fs.promises.unlink(target).then(() => true).catch(() => false);
  }
  return false;
}

/** ENOENT만 부재로 처리하고 권한/IO 오류는 경로가 없다고 오인하지 않게 그대로 던진다. */
async function lstatIfPresent(target: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(target);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** 경로를 다시 raw snapshot으로 읽어 예상 version과 같은지 보수적으로 판정한다. */
async function pathHasVersion(target: string, version: string | undefined): Promise<boolean> {
  if (!version) return false;
  return readConflictWorkingLeaf(target)
    .then((snapshot) => snapshot.version === version)
    .catch(() => false);
}

/** 두 lstat 결과가 같은 filesystem inode를 가리키는지 비교한다. */
function sameIdentity(actual: fs.Stats | undefined, expected: fs.Stats | undefined): boolean {
  return Boolean(actual && expected && actual.dev === expected.dev && actual.ino === expected.ino);
}

/** 작업트리 snapshot이 달라졌음을 공용 지역화 문구로 알리는 오류를 만든다. */
function staleResultError(): Error {
  return new Error("The conflict Result changed outside this editor. Reload it before resolving.");
}

/** 자동 복구가 외부 leaf를 덮게 될 때 두 버전을 보존한 transaction 경로를 알린다. */
function recoveryError(transactionDir: string): Error {
  return new Error(`The conflict file changed again. Recovery files were preserved at ${transactionDir}`);
}

/** Node 파일 오류가 rename 대상 부재인지 판별한다. */
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Node 파일 오류가 no-clobber 대상 존재인지 판별한다. */
function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
