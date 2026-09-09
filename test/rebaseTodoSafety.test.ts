import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { assertGitOperation, captureGitOperation } from "../src/git/operationControl";
import { RebaseService, type RebaseItem } from "../src/git/rebaseService";
import { updateInProgressRebaseTodo } from "../src/git/rebaseTodoEditor";
import { readRebaseTodoProgress } from "../src/git/rebaseTodoProgress";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

const editorScript = resolve("media/rebase/rebaseEditor.js");

/**
 * 첫 커밋에서 edit로 멈추고 두 번째 커밋은 todo에 남긴 실제 rebase를 만든다.
 * @param t 사용자 저장소와 분리된 fixture의 정리를 소유할 테스트
 * @param options linked worktree 또는 SHA-256 저장소에서 같은 경로를 검사할 옵션
 * @returns 실제 service와 남은 todo 경로, UI 계획, 읽기 전 상태
 */
async function pausedFixture(t: TestContext, options: { linked?: boolean; sha256?: boolean } = {}) {
  const fixture = await safetyFixture(t, "rebase-todo-safety");
  let root = fixture.root;
  let base = fixture.head;
  if (options.sha256) {
    root = join(fixture.directory, "sha256");
    await fs.mkdir(root);
    await git(root, "init", "-q", "-b", "main", "--object-format=sha256");
    for (const [key, value] of Object.entries({
      "user.name": "Todo Safety", "user.email": "todo@example.test", "commit.gpgsign": "false",
      "core.hooksPath": join(fixture.directory, "hooks"), "core.fsmonitor": "false",
    })) await git(root, "config", key, value);
    base = await commitText(root, "base\n", "base");
  } else if (options.linked) {
    root = join(fixture.directory, "linked");
    await git(fixture.root, "worktree", "add", "-qb", "linked", root, base);
  }
  const first = await commitText(root, "first\n", "first");
  const second = await commitText(root, "second\n", "second");
  const items: RebaseItem[] = [{ hash: first, action: "edit" }, { hash: second, action: "pick" }];
  const service = new RebaseService(root);
  const result = await service.start(base, false, items, editorScript);
  assert.equal(result.status, "paused");
  assert.ok(result.paused);
  const gitDir = await git(root, "rev-parse", "--absolute-git-dir");
  const todoPath = join(gitDir, "rebase-merge/git-rebase-todo");
  const raw = await fs.readFile(todoPath, "utf8");
  return { ...fixture, root, base, first, second, items, service, paused: result.paused, gitDir, todoPath, raw };
}

/**
 * todo 원문을 읽은 직후 외부 Git/에디터 동작을 한 번 끼워 넣는다.
 * @param t 파일 API 대역 수명을 소유할 테스트
 * @param todoPath 조립에 사용되는 UTF-8 원문 경로
 * @param change 원문을 읽는 동안 발생한 외부 변경
 */
function changeAfterRead(t: TestContext, todoPath: string, change: () => Promise<void>): void {
  const read = fs.readFile;
  let armed = true;
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    const result = await read(...args);
    if (armed && String(args[0]) === todoPath && args[1] === "utf8") {
      armed = false;
      await change();
    }
    return result;
  });
}

/** 두 번째 커밋의 action만 바꾸어 현재 edit 정지 지점은 보존한다. */
function changeSecond(items: RebaseItem[], action: RebaseItem["action"]): RebaseItem[] {
  return items.map((item, index) => index === 1 ? { ...item, action } : item);
}

test("external todo edits made during preparation are preserved", async t => {
  const fixture = await pausedFixture(t);
  const { root, items, second, todoPath } = fixture;
  const external = `reword ${second} external choice\n# external comment\n`;
  changeAfterRead(t, todoPath, () => fs.writeFile(todoPath, external));
  await assert.rejects(updateInProgressRebaseTodo(root, changeSecond(items, "drop")), /changed|ownership/i);
  assert.equal(await fs.readFile(todoPath, "utf8"), external);
  assert.equal(await git(root, "rev-parse", "HEAD"), fixture.paused.hash);
});

test("an external Continue cannot have its consumed todo recreated", async t => {
  const { root, items, second, todoPath } = await pausedFixture(t);
  changeAfterRead(t, todoPath, async () => { await git(root, "rebase", "--continue"); });
  await assert.rejects(updateInProgressRebaseTodo(root, changeSecond(items, "drop")), /changed|ownership/i);
  await assert.rejects(fs.readFile(todoPath), { code: "ENOENT" });
  assert.equal(await git(root, "rev-parse", "HEAD"), second);
});

test("aborting and restarting the same rebase cannot adopt an obsolete todo update", async t => {
  const { root, base, items, service, todoPath } = await pausedFixture(t);
  let replacement = "";
  changeAfterRead(t, todoPath, async () => {
    await git(root, "rebase", "--abort");
    const restarted = await service.start(base, false, items, editorScript);
    assert.equal(restarted.status, "paused");
    replacement = await fs.readFile(todoPath, "utf8");
  });
  await assert.rejects(updateInProgressRebaseTodo(root, changeSecond(items, "drop")), /changed|ownership/i);
  assert.equal(await fs.readFile(todoPath, "utf8"), replacement);
});

test("a busy todo writer is rejected without changing or removing its lock", async t => {
  const { root, items, gitDir, todoPath, raw } = await pausedFixture(t);
  const lock = join(gitDir, "gitsimplecompare/rebase-todo.lock");
  await fs.mkdir(dirname(lock), { recursive: true });
  await fs.writeFile(lock, "another writer\n");
  await assert.rejects(updateInProgressRebaseTodo(root, changeSecond(items, "drop")), /already|lock|EEXIST/i);
  assert.equal(await fs.readFile(todoPath, "utf8"), raw);
  assert.equal(await fs.readFile(lock, "utf8"), "another writer\n");
});

test("an atomic publish failure preserves the old todo and releases only the owned lock", async t => {
  const { root, items, gitDir, todoPath, raw } = await pausedFixture(t);
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (from, to) => {
    if (String(to) === todoPath) throw Object.assign(new Error("disk full during publish"), { code: "ENOSPC" });
    return rename(from, to);
  });
  await assert.rejects(updateInProgressRebaseTodo(root, changeSecond(items, "drop")), /disk full/);
  assert.equal(await fs.readFile(todoPath, "utf8"), raw);
  await assert.rejects(fs.readFile(join(gitDir, "gitsimplecompare/rebase-todo.lock")), { code: "ENOENT" });
});

test("an unchanged todo preserves the operation identity and performs no writes", async t => {
  const { root, items, todoPath, raw } = await pausedFixture(t);
  const before = await captureGitOperation(root);
  let writes = 0;
  const write = fs.writeFile;
  t.mock.method(fs, "writeFile", async (...args) => { writes++; return write(...args); });
  assert.equal((await updateInProgressRebaseTodo(root, items)).changed, false);
  assert.equal(writes, 0);
  assert.equal(await fs.readFile(todoPath, "utf8"), raw);
  await assertGitOperation(root, before);
});

test("already applied requested edits reject the whole todo change instead of partially applying it", async t => {
  const { root, items, first, todoPath, raw } = await pausedFixture(t);
  const result = await updateInProgressRebaseTodo(root, changeSecond(items, "drop"), [first]);
  assert.deepEqual(result.missingChangedEditHashes, [first]);
  assert.equal(result.changed, false);
  assert.equal(await fs.readFile(todoPath, "utf8"), raw);
});

test("abbreviated Git todo actions preserve edit detection and can be updated", async t => {
  const { root, items, second, todoPath, gitDir } = await pausedFixture(t);
  const donePath = join(gitDir, "rebase-merge/done");
  const done = await fs.readFile(donePath, "utf8");
  await fs.writeFile(donePath, done.replace(/^edit /m, "e "));
  await fs.writeFile(todoPath, `p ${second}\tsecond\n# keep this comment\n`);
  const paused = await new RebaseService(root).getPausedEditState();
  assert.ok(paused, "Git's e alias must still stop for an editable commit");
  const result = await updateInProgressRebaseTodo(root, changeSecond(items, "edit"), [second], paused);
  assert.equal(result.changed, true);
  assert.deepEqual(result.missingChangedEditHashes, []);
  assert.equal(await fs.readFile(todoPath, "utf8"), `edit ${second}\tsecond\n# keep this comment\n`);
  const progress = await readRebaseTodoProgress(root);
  assert.equal(progress?.items.find(item => item.role === "current")?.action, "edit");
});

for (const kind of ["linked", "sha256"] as const) {
  test(`todo updates and paused edit state work in ${kind} repositories`, async t => {
    const { root, items, second, todoPath, paused } = await pausedFixture(t, { [kind]: true });
    const result = await updateInProgressRebaseTodo(root, changeSecond(items, "edit"), [second], paused);
    assert.equal(result.changed, true);
    assert.match(await fs.readFile(todoPath, "utf8"), new RegExp(`^edit ${second}`));
    assert.equal((await readRebaseTodoProgress(root))?.items.find(item => item.role === "remaining")?.hash, second);
    await git(root, "rebase", "--continue");
    assert.equal((await new RebaseService(root).getPausedEditState())?.originalHash, second);
  });
}

test("an empty UI plan requires no repository or filesystem reads", async t => {
  for (const method of ["readFile", "access", "open"] as const) {
    t.mock.method(fs, method, async () => { throw new Error("unexpected filesystem read"); });
  }
  assert.deepEqual(await updateInProgressRebaseTodo("/missing/repository", []), {
    changed: false, missingChangedEditHashes: [], missingChangedFileHashes: [],
  });
});

test("a lock identification failure closes its handle and safely cleans up after identity recovers", async t => {
  const { root, items, gitDir, todoPath, raw } = await pausedFixture(t);
  const lockPath = join(gitDir, "gitsimplecompare/rebase-todo.lock");
  const open = fs.open;
  let handle: fs.FileHandle | undefined;
  t.mock.method(fs, "open", async (...args) => {
    const opened = await open(...args);
    if (String(args[0]) === lockPath) {
      handle = opened;
      const stat = opened.stat.bind(opened);
      let failed = false;
      t.mock.method(opened, "stat", async () => {
        if (!failed) { failed = true; throw new Error("lock identity temporarily unavailable"); }
        return stat();
      });
    }
    return opened;
  });
  await assert.rejects(updateInProgressRebaseTodo(root, changeSecond(items, "drop")), /identity temporarily unavailable/);
  assert.equal(handle?.fd, -1, "Failed preparation must close the opened file handle");
  assert.equal(await fs.readFile(todoPath, "utf8"), raw);
  await assert.rejects(fs.readFile(lockPath), { code: "ENOENT" });
});

test("a failed temporary write preserves the original todo and releases its lock", async t => {
  const { root, items, gitDir, todoPath, raw } = await pausedFixture(t);
  const lockPath = join(gitDir, "gitsimplecompare/rebase-todo.lock");
  const before = await captureGitOperation(root);
  const open = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === lockPath) {
      t.mock.method(handle, "writeFile", async () => { throw new Error("disk full during preparation"); });
    }
    return handle;
  });
  await assert.rejects(updateInProgressRebaseTodo(root, changeSecond(items, "drop")), /disk full/);
  assert.equal(await fs.readFile(todoPath, "utf8"), raw);
  await assert.rejects(fs.readFile(lockPath), { code: "ENOENT" });
  await assertGitOperation(root, before);
});

test("a replaced lock is neither published nor deleted by the original writer", async t => {
  const { root, items, gitDir, todoPath, raw } = await pausedFixture(t);
  const lockPath = join(gitDir, "gitsimplecompare/rebase-todo.lock");
  const read = fs.readFile;
  let reads = 0;
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    const result = await read(...args);
    if (String(args[0]) === todoPath && args[1] === "utf8" && ++reads === 2) {
      await fs.rename(lockPath, `${lockPath}.displaced`);
      await fs.writeFile(lockPath, "foreign writer\n");
    }
    return result;
  });
  await assert.rejects(updateInProgressRebaseTodo(root, changeSecond(items, "drop")), /changed/i);
  assert.equal(await fs.readFile(todoPath, "utf8"), raw);
  assert.equal(await fs.readFile(lockPath, "utf8"), "foreign writer\n");
});

test("an ambiguous shortened commit hash refuses to change either candidate", async t => {
  const { root, second, todoPath } = await pausedFixture(t);
  const other = second.slice(0, -1) + (second.endsWith("0") ? "1" : "0");
  const raw = `pick ${second.slice(0, 8)} ambiguous commit\n`;
  await fs.writeFile(todoPath, raw);
  const items: RebaseItem[] = [{ hash: second, action: "drop" }, { hash: other, action: "edit" }];
  await assert.rejects(updateInProgressRebaseTodo(root, items), /ambiguous commit hash/i);
  assert.equal(await fs.readFile(todoPath, "utf8"), raw);
});
