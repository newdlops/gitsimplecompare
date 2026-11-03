import assert from "node:assert/strict";
import test from "node:test";
import io, { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrivateStatusIndex } from "../src/git/privateStatusIndex";
import { GitStatusFsMonitorGuard } from "../src/git/gitStatusExec";
import { parseWorkingTreeV2, workingTreeSnapshot } from "../src/git/workingTreeStatusFormat";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 사용자 index의 byte·inode·시각을 기록해 읽기 경로가 원본을 쓰지 않았는지 확인한다. */
async function sourceIdentity(root: string) {
  const file = path.join(root, ".git/index"), info = await stat(file);
  return { bytes: await readFile(file), ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs };
}

/** 순서만 제외하고 staged·unstaged 전체 의미를 독립 Native status와 대조한다. */
async function verifyFresh(index: PrivateStatusIndex, root: string) {
  const before = await sourceIdentity(root), actual = await index.read(AbortSignal.timeout(60000));
  const expected = workingTreeSnapshot(root, parseWorkingTreeV2(await git(root,
    "status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=all")));
  const sorted = (value: typeof actual) => ({ head: value.head, branch: value.branch,
    staged: [...value.groups.staged].sort((a,b) => a.path.localeCompare(b.path)),
    unstaged: [...value.groups.unstaged].sort((a,b) => a.path.localeCompare(b.path)) });
  assert.deepEqual(sorted(actual), sorted(expected)); assert.deepEqual(await sourceIdentity(root), before);
  return actual;
}

test("a partially written private index at cancellation is rebuilt before it can be reused", async t => {
  const { root } = await safetyFixture(t, "cancel-private-partial-write");
  const index = new PrivateStatusIndex(root, () => undefined); t.after(() => index.dispose());
  await index.read(new AbortController().signal);
  const privateFile = (index as any).index as string, original = await sourceIdentity(root);
  // stage 의미가 같은 외부 metadata 갱신으로 prepare가 사본을 다시 쓰게 한다.
  await writeFile(path.join(root, ".git/index"), original.bytes);
  const controller = new AbortController(), nativeWrite = io.writeFile;
  let injected = false;
  const override = t.mock.method(io, "writeFile", (async (...args: Parameters<typeof io.writeFile>) => {
    if (String(args[0]) === privateFile && !injected) {
      injected = true; await nativeWrite(privateFile, Buffer.from("partial index"));
      controller.abort(); throw new DOMException("cancelled during write", "AbortError");
    }
    return nativeWrite(...args);
  }) as typeof io.writeFile);
  await assert.rejects(index.read(controller.signal), { name: "AbortError" }); override.mock.restore();
  assert.equal(injected, true);
  await writeFile(path.join(root, "new.txt"), "new\n");
  await verifyFresh(index, root);
});

test("source staging changes after a cancelled read replace the retained private state", async t => {
  const { root } = await safetyFixture(t, "cancel-private-new-stage");
  const index = new PrivateStatusIndex(root, () => undefined); t.after(() => index.dispose());
  await index.read(new AbortController().signal);
  const controller = new AbortController();
  const override = t.mock.method(GitStatusFsMonitorGuard.prototype, "run", async () => {
    controller.abort(); throw new DOMException("cancelled", "AbortError");
  });
  await assert.rejects(index.read(controller.signal), { name: "AbortError" }); override.mock.restore();
  await writeFile(path.join(root, "tracked.txt"), "new stage\n"); await git(root, "add", "tracked.txt");
  await writeFile(path.join(root, "tracked.txt"), "working after stage\n");
  const fresh = await verifyFresh(index, root);
  assert.equal(fresh.groups.staged.length, 1); assert.equal(fresh.groups.unstaged.length, 1);
});

test("explicit dispose after consumer cancellation unregisters and removes retained private files", async t => {
  const { root } = await safetyFixture(t, "cancel-private-dispose");
  const index = new PrivateStatusIndex(root, () => undefined); t.after(() => index.dispose());
  await index.read(new AbortController().signal); const privateFile = (index as any).index as string;
  const controller = new AbortController();
  const override = t.mock.method(GitStatusFsMonitorGuard.prototype, "run", async () => {
    controller.abort(); throw new DOMException("cancelled", "AbortError");
  });
  await assert.rejects(index.read(controller.signal), { name: "AbortError" }); override.mock.restore();
  await index.dispose(); await assert.rejects(stat(privateFile), { code: "ENOENT" });
  assert.equal((index as any).index, undefined); assert.equal((index as any).warmup.task, undefined);
});
