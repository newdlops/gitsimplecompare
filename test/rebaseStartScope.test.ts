import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { captureRebaseCheckout } from "../src/git/rebasePlanSafety";
import { detectOperation } from "../src/git/conflictService";
import { GitError, runGit } from "../src/git/gitExec";
import { cleanupRebaseMessageQueue } from "../src/git/rebaseMessageQueue";
import { withGitStatePathScope } from "../src/git/gitStatePathScope";
import { RebaseService } from "../src/git/rebaseService";
import { GitLogService } from "../src/git/gitLogService";
import { runGraphRebase } from "../src/webview/graphRebaseActions";
import { git, commitText, safetyFixture } from "./helpers/gitSafetyFixture";
import { Uri, window } from "./helpers/vscodeMock";

const editor = resolve("media/rebase/rebaseEditor.js");

/** 실제 Git을 전달하면서 실행 직전 race를 결정적으로 발생시킨다. 임시 저장소 밖은 변경하지 않는다. */
function observeSpawns(
  t: TestContext, before: (args: string[]) => void = () => {},
  after: (args: string[], child: childProcess.ChildProcess) => void = () => {}
) {
  const calls: string[][] = [], spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") { calls.push([...args[1]]); before(args[1]); }
    const child = (spawn as Function)(...args);
    if (args[0] === "git") after(args[1], child);
    return child;
  });
  return calls;
}

for (const linked of [false, true]) {
  for (const planned of [false, true]) {
  test(`Start releases scoped paths between successive ${planned ? "planned" : "direct"} rebases in a ${linked ? "linked" : "normal"} worktree`, async t => {
    const f = await safetyFixture(t, "rebase-start-path-scope");
    const root = linked ? join(f.directory, "linked 한글") : f.root;
    if (linked) await git(f.root, "worktree", "add", "-qb", "linked", root, f.head);
    const tip = await commitText(root, "topic\n", "topic");
    const service = new RebaseService(root, { nativeEditors: true }), calls = observeSpawns(t);
    for (const message of ["first rewritten", "second rewritten"]) {
      const checkout = await captureRebaseCheckout(root);
      calls.length = 0;
      const result = await service.start(f.head, false, [{ hash: checkout.head, action: "reword", message }], editor, undefined, planned ? checkout : undefined);
      assert.equal(result.status, "completed", result.message);
      assert.equal(calls.filter(args => args.includes("--symbolic-full-name")).length, 2, "both fresh checkout safety checks must remain");
      assert.equal(calls.filter(args => args.includes("--absolute-git-dir") && !args.includes("--symbolic-full-name")).length, 0,
        "The first fresh checkout supplies this invocation's directory without a path-only process");
      assert.equal(calls.filter(args => args.includes("--git-path")).length, 1, "initialize and cleanup share only this invocation's queue path");
      assert.equal(await git(root, "log", "-1", "--format=%s"), message);
      assert.equal(await git(root, "show", "HEAD:tracked.txt"), "topic");
      await assert.rejects(readFile(join(checkout.gitDir, "gitsimplecompare/rebase-message-queue-state.json")), { code: "ENOENT" });
    }
    assert.notEqual(await git(root, "rev-parse", "HEAD"), tip);
    if (linked) assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
  });
  }
}

test("Start preserves an already-paused rebase and releases the consumed input todo", async t => {
  const f = await safetyFixture(t, "rebase-start-already-paused"), tip = await commitText(f.root, "edit\n", "edit");
  const checkout = await captureRebaseCheckout(f.root), temporaryFiles: string[] = [], writeSync = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (...args: any[]) => {
    if (String(args[0]).includes("gsc-rebase-todo-")) temporaryFiles.push(String(args[0]));
    return (writeSync as Function)(...args);
  });
  const service = new RebaseService(f.root, { nativeEditors: true });
  const items = [{ hash: tip, action: "edit" as const }];
  assert.equal((await service.start(f.head, false, items, editor, undefined, checkout)).status, "paused");
  assert.equal(temporaryFiles.length, 1);
  await assert.rejects(readFile(temporaryFiles[0]), { code: "ENOENT" });
  const state = join(checkout.gitDir, "gitsimplecompare/rebase-message-queue-state.json"), before = await readFile(state);
  const calls = observeSpawns(t);
  const result = await service.start(f.head, false, items, editor, undefined, checkout);
  assert.equal(result.status, "paused", "Detached HEAD during an active rebase must not replace its paused state with a checkout error");
  assert.equal(calls.some(args => args[0] === "rebase"), false);
  assert.deepEqual(await readFile(state), before);
  assert.equal(temporaryFiles.length, 1);
  const modal = t.mock.method(window, "showWarningMessage", async () => { throw new Error("An existing rebase must not open Start confirmation"); });
  const graph = await runGraphRebase(f.head, false, undefined, items, undefined, {
    logService: new GitLogService(f.root), extensionUri: Uri.file(resolve(".")) as any, refreshGraph: async () => {},
  }, checkout);
  assert.equal(graph.status, "paused", "The actual Graph Start adapter must also adopt detached rebase state");
  assert.equal(modal.mock.callCount(), 0);
  assert.deepEqual(await readFile(state), before);
  assert.equal(calls.some(args => args[0] === "rebase"), false);
  await git(f.root, "rebase", "--abort"); await cleanupRebaseMessageQueue(f.root);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), tip);
});

test("Graph Start shares the initial checkout directory only until confirmation", async t => {
  const f = await safetyFixture(t, "graph-rebase-start-context"), tip = await commitText(f.root, "topic\n", "topic");
  const checkout = await captureRebaseCheckout(f.root), calls = observeSpawns(t);
  const modal = t.mock.method(window, "showWarningMessage", async () => undefined);
  const result = await runGraphRebase(f.head, false, undefined, [{ hash: tip, action: "reword", message: "unused" }], undefined, {
    logService: new GitLogService(f.root), extensionUri: Uri.file(resolve(".")) as any, refreshGraph: async () => {},
  }, checkout);
  assert.equal(result.status, "failed"); assert.equal(result.message, "cancelled"); assert.equal(modal.mock.callCount(), 1);
  assert.equal(calls.length, 1, "Confirmation preparation needs one fresh checkout and no path-only process");
  assert.equal(calls[0].includes("--symbolic-full-name"), true);
  calls.length = 0;
  assert.equal(await detectOperation(f.root), "none");
  assert.equal(calls.length, 1, "The UI preflight directory cache must be released before waiting for user confirmation");
  assert.equal(await git(f.root, "rev-parse", "HEAD"), tip);
  await assert.rejects(readFile(join(checkout.gitDir, "gitsimplecompare/rebase-message-queue-state.json")), { code: "ENOENT" });
});

test("custom sequence helpers retain their paused input lifetime", async t => {
  const f = await safetyFixture(t, "rebase-start-custom-input"), tip = await commitText(f.root, "edit\n", "edit");
  const custom = join(f.directory, "custom-editor.js"), inputs: string[] = [], writeSync = fs.writeFileSync;
  await writeFile(custom, (await readFile(editor, "utf8")) + "\n// 사용자 지정 호출 규약\n");
  t.mock.method(fs, "writeFileSync", (...args: any[]) => {
    if (String(args[0]).includes("gsc-rebase-todo-")) inputs.push(String(args[0]));
    return (writeSync as Function)(...args);
  });
  t.after(async () => { for (const file of inputs) await fs.promises.rm(file, { force: true }); });
  const result = await new RebaseService(f.root, { nativeEditors: true }).start(f.head, false, [{ hash: tip, action: "edit" }], custom);
  assert.equal(result.status, "paused"); assert.equal(inputs.length, 1);
  assert.match(await readFile(inputs[0], "utf8"), new RegExp(`^edit ${tip}`, "m"));
  await git(f.root, "rebase", "--abort"); await cleanupRebaseMessageQueue(f.root);
});

test("a consumed input todo can be removed while pending rewrite exec files remain usable", async t => {
  const f = await safetyFixture(t, "rebase-start-pending-exec");
  await writeFile(join(f.root, "side.txt"), "keep addition\n"); await git(f.root, "add", "side.txt");
  const tip = await commitText(f.root, "remove this change\n", "edit with pending rewrite"), checkout = await captureRebaseCheckout(f.root);
  const inputs: string[] = [], writeSync = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (...args: any[]) => {
    if (String(args[0]).includes("gsc-rebase-todo-")) inputs.push(String(args[0]));
    return (writeSync as Function)(...args);
  });
  const result = await new RebaseService(f.root, { nativeEditors: true }).start(f.head, false,
    [{ hash: tip, action: "edit", excludePaths: ["tracked.txt"] }], editor, undefined, checkout);
  assert.equal(result.status, "paused"); assert.equal(inputs.length, 1);
  await assert.rejects(readFile(inputs[0]), { code: "ENOENT" });
  assert.match(await readFile(join(checkout.gitDir, "rebase-merge/git-rebase-todo"), "utf8"), /^exec /m);
  await git(f.root, "-c", "core.editor=true", "rebase", "--continue");
  assert.equal(await detectOperation(f.root), "none");
  assert.equal(await git(f.root, "show", "HEAD:tracked.txt"), "base");
  assert.equal(await git(f.root, "show", "HEAD:side.txt"), "keep addition");
  assert.equal(await git(f.root, "status", "--porcelain"), "");
  await cleanupRebaseMessageQueue(f.root);
});

test("Start propagates an initial checkout read failure when no native operation is active", async t => {
  const f = await safetyFixture(t, "rebase-start-checkout-error"), checkout = await captureRebaseCheckout(f.root);
  const spawn = childProcess.spawn, calls: string[][] = [];
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") {
      calls.push(args[1]);
      if (args[1].includes("--symbolic-full-name")) return spawn(process.execPath,
        ["-e", 'process.stderr.write("initial checkout sentinel\\n");process.exit(17);'], args[2]);
    }
    return (spawn as Function)(...args);
  });
  await assert.rejects(new RebaseService(f.root).start(f.head, false, [{ hash: f.head, action: "pick" }], editor, undefined, checkout),
    (error: unknown) => error instanceof GitError && error.code === 17 && error.stderr.includes("initial checkout sentinel"));
  assert.equal(calls.some(args => args[0] === "rebase"), false);
  await assert.rejects(readFile(join(checkout.gitDir, "gitsimplecompare/rebase-message-queue-state.json")), { code: "ENOENT" });
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
});

test("a commit arriving after queue preparation is preserved and prevents native rebase from starting", async t => {
  const { root, head: base } = await safetyFixture(t, "rebase-start-late-head");
  const tip = await commitText(root, "topic\n", "topic"), checkout = await captureRebaseCheckout(root);
  const tree = await git(root, "rev-parse", "HEAD^{tree}");
  const external = await git(root, "commit-tree", tree, "-p", tip, "-m", "external commit");
  await writeFile(join(root, "tracked.txt"), "local staged\n"); await git(root, "add", "tracked.txt");
  await writeFile(join(root, "tracked.txt"), "local unstaged\n"); await writeFile(join(root, "untracked.txt"), "untracked\n");
  const staged = await git(root, "diff", "--cached"), unstaged = await git(root, "diff");
  let guards = 0;
  const calls = observeSpawns(t, args => {
    if (args.includes("--symbolic-full-name") && ++guards === 2)
      childProcess.execFileSync("git", ["update-ref", checkout.branch, external, tip], { cwd: root });
  });
  const result = await new RebaseService(root, { nativeEditors: true }).start(base, false, [{ hash: tip, action: "reword", message: "rewritten" }], editor, undefined, checkout);
  assert.equal(result.status, "failed"); assert.match(result.message!, /branch or HEAD changed/);
  assert.equal(guards, 2); assert.equal(calls.some(args => args[0] === "rebase"), false);
  assert.equal(await git(root, "rev-parse", "HEAD"), external);
  assert.equal(await git(root, "diff", "--cached"), staged); assert.equal(await git(root, "diff"), unstaged);
  assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "untracked\n");
  await assert.rejects(readFile(join(checkout.gitDir, "gitsimplecompare/rebase-message-queue-state.json")), { code: "ENOENT" });
});

test("sharing the operation directory still observes native rebase start and abort immediately", async t => {
  const f = await safetyFixture(t, "rebase-start-fresh-markers"), tip = await commitText(f.root, "topic\n", "topic");
  const todo = join(f.directory, "todo"); await writeFile(todo, `edit ${tip}\n`);
  const calls = observeSpawns(t);
  await withGitStatePathScope(f.root, async () => {
    assert.equal(await detectOperation(f.root), "none");
    await runGit(["rebase", "-i", f.head], f.root, {
      ELECTRON_RUN_AS_NODE: "1", GIT_SEQUENCE_EDITOR: `"${process.execPath}" "${editor}" seq`, GSC_TODO: todo, GIT_EDITOR: "true",
    });
    assert.equal(await detectOperation(f.root), "rebase");
    await runGit(["rebase", "--abort"], f.root);
    assert.equal(await detectOperation(f.root), "none");
    assert.equal(calls.filter(args => args.includes("--absolute-git-dir")).length, 1);
  });
  assert.equal(await git(f.root, "rev-parse", "HEAD"), tip);
});

test("replacing linked metadata during plan validation stops Start before queue writes in another repository", async t => {
  const first = await safetyFixture(t, "rebase-start-metadata"), second = await safetyFixture(t, "rebase-start-other");
  const root = join(first.directory, "linked"), locator = join(root, ".git");
  await git(first.root, "worktree", "add", "-qb", "linked", root, first.head);
  const tip = await commitText(root, "topic\n", "topic"), checkout = await captureRebaseCheckout(root);
  const original = await readFile(locator);
  const temporaryFiles: string[] = [], writeSync = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (...args: any[]) => {
    if (String(args[0]).includes("gsc-rebase-todo-")) temporaryFiles.push(String(args[0]));
    return (writeSync as Function)(...args);
  });
  let replaced = false;
  const calls = observeSpawns(t, () => {}, (args, child) => {
    if (args[0] === "log") child.prependOnceListener("close", () => {
      replaced = true; writeFileSync(locator, `gitdir: ${join(second.root, ".git")}\n`);
    });
  });
  try {
    await assert.rejects(new RebaseService(root, { nativeEditors: true }).start(first.head, false, [{ hash: tip, action: "reword", message: "rewritten" }], editor, undefined, checkout), /metadata changed/);
    assert.equal(replaced, true);
    assert.equal(temporaryFiles.length, 1);
    for (const file of temporaryFiles) await assert.rejects(readFile(file), { code: "ENOENT" });
    assert.equal(calls.some(args => args[0] === "rebase"), false);
    await assert.rejects(readFile(join(second.root, ".git/gitsimplecompare/rebase-message-queue-state.json")), { code: "ENOENT" });
    assert.equal(await git(second.root, "rev-parse", "HEAD"), second.head);
  } finally { await writeFile(locator, original); }
  assert.equal(await git(root, "rev-parse", "HEAD"), tip);
});
