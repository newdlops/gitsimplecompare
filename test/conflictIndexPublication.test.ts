import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { withConflictIndexTransaction } from "../src/git/conflictIndexTransaction";
import { runGitWithInput } from "../src/git/gitExec";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 정상 Git index를 여러 복사 chunk보다 크게 만들어 바이트 보존과 Native tree를 함께 대조한다. */
async function largeIndex(t: TestContext) {
  const f = await safetyFixture(t, "index-publication");
  const blob = (await runGitWithInput(["hash-object", "-w", "--stdin"], f.root, "index content\n")).trim();
  await runGitWithInput(["update-index", "-z", "--index-info"], f.root,
    Array.from({ length: 12000 }, (_, index) => `100644 ${blob}\tfile-${String(index).padStart(6, "0")}.txt\0`).join(""));
  const tree = await git(f.root, "write-tree"), index = path.join(f.root, ".git/index");
  const bytes = await fs.promises.readFile(index);
  assert.ok(bytes.length > 2 * 256 * 1024);
  return { ...f, index, bytes, tree };
}

/** 실제 lock handle의 write만 감싸 disk의 짧은 쓰기/실패/경로 교체를 재현하며 다른 파일 I/O는 그대로 둔다. */
function interceptLock(t: TestContext, lockPath: string, write: (handle: any, original: any, args: any[]) => Promise<any>) {
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, "open", async (...args: any[]) => {
    const handle = await (open as any)(...args);
    if (args[0] === lockPath && args[1] === "wx") {
      const original = handle.write.bind(handle);
      t.mock.method(handle, "write", (...values: any[]) => write(handle, original, values));
    }
    return handle;
  });
}

for (const linked of [false, true]) {
  /** 작은 index도 정확히 복사하며 linked worktree의 실제 index 위치를 따르는지 확인한다. */
  test(`small index publication preserves Native bytes in ${linked ? "a linked worktree" : "the main worktree"}`, async t => {
    const f = await safetyFixture(t, "small-index-publication"), root = linked ? path.join(f.directory, "linked") : f.root;
    if (linked) await git(f.root, "worktree", "add", "--detach", root, f.head);
    const tree = await git(root, "write-tree"), index = path.resolve(root, await git(root, "rev-parse", "--git-path", "index"));
    const bytes = await fs.promises.readFile(index); assert.ok(bytes.length < 256 * 1024);
    await withConflictIndexTransaction(root, true, async () => undefined);
    assert.deepEqual(await fs.promises.readFile(index), bytes);
    assert.equal(await git(root, "write-tree"), tree);
    assert.equal(fs.existsSync(`${index}.lock`), false);
  });
}

/** 여러 짧은 write 뒤에도 실제 stage entry와 tree가 정확히 유지되는지 확인한다. */
test("large Native index publication handles short writes without losing bytes", async t => {
  const f = await largeIndex(t); let writes = 0;
  interceptLock(t, `${f.index}.lock`, async (_handle, original, [buffer, offset, length, position]) => {
    writes++; return original(buffer, offset, Math.min(length, 64 * 1024), position);
  });
  await withConflictIndexTransaction(f.root, true, async () => undefined);
  assert.ok(writes > 4);
  assert.deepEqual(await fs.promises.readFile(f.index), f.bytes);
  assert.equal(await git(f.root, "write-tree"), f.tree);
  assert.equal(fs.existsSync(`${f.index}.lock`), false);
});

/** 복사 도중 disk 실패가 나도 원래 index가 게시되지 않고 자기 임시 파일만 정리되는지 확인한다. */
test("a failed partial index write preserves the original Native index and releases owned files", async t => {
  const f = await largeIndex(t); let writes = 0;
  interceptLock(t, `${f.index}.lock`, async (_handle, original, [buffer, offset, _length, position]) => {
    if (++writes > 1) throw Object.assign(new Error("simulated full disk"), { code: "ENOSPC" });
    return original(buffer, offset, 17, position);
  });
  await assert.rejects(withConflictIndexTransaction(f.root, true, async () => undefined), /simulated full disk/);
  assert.deepEqual(await fs.promises.readFile(f.index), f.bytes);
  assert.equal(await git(f.root, "write-tree"), f.tree);
  assert.equal(fs.existsSync(`${f.index}.lock`), false);
  assert.deepEqual((await fs.promises.readdir(path.dirname(f.index))).filter(name => name.startsWith(".gsc-conflict-index-")), []);
});

/** 임시 index 읽기가 중간에 실패해도 부분 lock을 실제 index로 게시하지 않는지 확인한다. */
test("a failed source index read never publishes the partial copy", async t => {
  const f = await largeIndex(t), open = fs.promises.open.bind(fs.promises); let reads = 0, sourceHandle: any;
  t.mock.method(fs.promises, "open", async (...args: any[]) => {
    const handle = await (open as any)(...args);
    if (String(args[0]).includes(".gsc-conflict-index-") && args[1] === "r") {
      sourceHandle = handle;
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", async (...values: any[]) => {
        if (++reads > 1) throw Object.assign(new Error("simulated read failure"), { code: "EIO" });
        return read(...values);
      });
    }
    return handle;
  });
  await assert.rejects(withConflictIndexTransaction(f.root, true, async () => undefined), /simulated read failure/);
  assert.equal(sourceHandle.fd, -1, "The failed reader must release its file descriptor");
  assert.deepEqual(await fs.promises.readFile(f.index), f.bytes);
  assert.equal(await git(f.root, "write-tree"), f.tree);
  assert.equal(fs.existsSync(`${f.index}.lock`), false);
});

/** 무진행 I/O를 무한 재시도하지 않고 원본을 보존한 채 중단하는지 확인한다. */
test("a zero-progress index write fails before publication", async t => {
  const f = await safetyFixture(t, "index-write-progress"), index = path.join(f.root, ".git/index");
  const original = await fs.promises.readFile(index);
  interceptLock(t, `${index}.lock`, async (_handle, _original, [buffer]) => ({ bytesWritten: 0, buffer }));
  await assert.rejects(withConflictIndexTransaction(f.root, true, async () => undefined), /write made no progress/);
  assert.deepEqual(await fs.promises.readFile(index), original);
  assert.equal(fs.existsSync(`${index}.lock`), false);
});

/** 복사 중 다른 inode가 lock 경로에 나타나면 그 내용을 쓰거나 지우지 않고 원래 index도 유지한다. */
test("a replacement index lock is neither overwritten nor removed during publication", async t => {
  const f = await largeIndex(t), lock = `${f.index}.lock`; let replaced = false;
  interceptLock(t, lock, async (_handle, original, [buffer, offset, length, position]) => {
    const result = await original(buffer, offset, Math.min(length, 64 * 1024), position);
    if (!replaced) {
      replaced = true; await fs.promises.rename(lock, path.join(f.directory, "owned-lock"));
      await fs.promises.writeFile(lock, "replacement writer\n");
    }
    return result;
  });
  await assert.rejects(withConflictIndexTransaction(f.root, true, async () => undefined), /index lock changed/);
  assert.deepEqual(await fs.promises.readFile(f.index), f.bytes);
  assert.equal(await fs.promises.readFile(lock, "utf8"), "replacement writer\n");
});
