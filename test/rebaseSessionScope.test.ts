import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { GitLogService } from "../src/git/gitLogService";
import { gitCommandIndex } from "../src/git/gitCommandPolicy";
import { captureRebaseCheckout } from "../src/git/rebasePlanSafety";
import { RebaseService, type RebasePlanInfo } from "../src/git/rebaseService";
import { readRebaseSessionState, startRebaseSessionState, updateRebaseSessionState } from "../src/git/rebaseSessionState";
import { beginGraphRebaseSession, recordGraphRebaseSessionResult } from "../src/webview/graphRebaseSession";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 Git을 실행하되 전역 -c 옵션 뒤의 명령까지 함께 기록해 중복 경로 조회를 센다. */
function observeGit(t: TestContext, after: (args: string[], child: childProcess.ChildProcess) => void = () => {}) {
  const calls: string[][] = [], spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const child = (spawn as Function)(...args);
    if (args[0] === "git") { calls.push([...args[1]]); after(args[1], child); }
    return child;
  });
  return calls;
}

/** 본문·파일 목록·checkout을 갖춘 실제 세션을 만들고 계측 전 초기 저장까지 끝낸다. */
async function sessionFixture(t: TestContext, label: string, linked = false) {
  const fixture = await safetyFixture(t, label), root = linked ? join(fixture.directory, "linked 한글") : fixture.root;
  if (linked) await git(fixture.root, "worktree", "add", "-qb", "linked", root, fixture.head);
  await commitText(root, "topic\n", "original subject\n\n원래 본문\n" + "body ".repeat(20_000));
  const commits = await new RebaseService(root).getCommits(fixture.head);
  const items = commits.map(commit => ({ hash: commit.hash, action: "reword" as const, message: "new subject\n\nnew body", files: commit.files }));
  const checkout = await captureRebaseCheckout(root);
  const plan: RebasePlanInfo = { branch: checkout.branch.slice("refs/heads/".length), checkout,
    base: fixture.head, root: false, baseReason: "selected", commits, items };
  const saved = await startRebaseSessionState(root, plan, items);
  return { ...fixture, root, items, plan, ...saved };
}

/** 최신 checkout 안전 검사와 디렉터리 위치만 확인하는 조회를 구분한다. */
function checkoutCalls(calls: string[][]) {
  return calls.filter(args => args.includes("--absolute-git-dir") && args.includes("--symbolic-full-name"));
}

for (const linked of [false, true]) {
  test(`session checkpoints share only paths inside one invocation in a ${linked ? "linked" : "normal"} worktree`, async t => {
    const fixture = await sessionFixture(t, "rebase-session-checkpoint", linked), calls = observeGit(t);
    for (const action of ["continue", "skip"]) {
      calls.length = 0;
      const state = await updateRebaseSessionState(fixture.root, { action, phase: "running", items: fixture.items });
      assert.equal(calls.length, 2, "one state path and one fresh progress directory query, with no cross-action cache");
      assert.equal(calls.filter(args => args.includes("--git-path")).length, 1);
      assert.equal(state?.operationId, fixture.state.operationId);
      assert.deepEqual(state?.plan.commits, JSON.parse(JSON.stringify(fixture.plan.commits)));
      assert.deepEqual(state?.items, JSON.parse(JSON.stringify(fixture.items)));
      assert.equal(state?.lastAction, action);
    }
    assert.deepEqual((await readRebaseSessionState(fixture.root))?.events.map(event => event.action), ["run", "continue", "skip"]);
  });

  test(`Graph Start snapshots preserve canonical bodies and verify checkout twice in a ${linked ? "linked" : "normal"} worktree`, async t => {
    const fixture = await sessionFixture(t, "rebase-session-start", linked), calls = observeGit(t);
    const saved = await beginGraphRebaseSession({ base: fixture.head, root: false, items: fixture.items }, { logService: new GitLogService(fixture.root) });
    assert.equal(calls.length, 5, "canonical metadata, upstream, two checkout guards, and one private path");
    assert.equal(checkoutCalls(calls).length, 2);
    assert.equal(calls.some(args => args[gitCommandIndex(args)] === "branch"), false);
    assert.equal(calls.some(args => ["diff", "diff-tree"].includes(args[gitCommandIndex(args)])), false);
    assert.equal(saved, fixture.path);
    const state = await readRebaseSessionState(fixture.root);
    assert.deepEqual(state?.plan.commits, JSON.parse(JSON.stringify(fixture.plan.commits)));
    assert.deepEqual(state?.plan.checkout, fixture.plan.checkout);
    assert.equal(state?.plan.branch, linked ? "linked" : "main");
  });
}

test("a completed Graph result retains a fresh operation check while sharing state and progress paths", async t => {
  const fixture = await sessionFixture(t, "rebase-session-result"), calls = observeGit(t);
  await recordGraphRebaseSessionResult(fixture.root, "run", { status: "completed" }, fixture.items);
  assert.equal(calls.length, 2, "fresh native operation and one private path, without a directory-only subprocess");
  assert.equal(checkoutCalls(calls).length, 1);
  const state = await readRebaseSessionState(fixture.root);
  assert.equal(state?.phase, "completed");
  assert.deepEqual(state?.plan.commits, JSON.parse(JSON.stringify(fixture.plan.commits)));
  assert.equal(state?.nativeOperation, undefined);
});

test("a paused Graph result binds the actual native generation without redundant state path queries", async t => {
  const fixture = await sessionFixture(t, "rebase-session-paused");
  const result = await new RebaseService(fixture.root, { nativeEditors: true }).start(fixture.head, false,
    [{ ...fixture.items[0], action: "edit" }], resolve("media/rebase/rebaseEditor.js"));
  assert.equal(result.status, "paused", result.message);
  const calls = observeGit(t);
  await recordGraphRebaseSessionResult(fixture.root, "run", result, fixture.items);
  assert.equal(calls.length, 3, "capture and assert the actual native generation, plus one shared private path");
  assert.equal(checkoutCalls(calls).length, 2);
  const state = await readRebaseSessionState(fixture.root);
  assert.equal(state?.phase, "paused");
  assert.equal(state?.nativeOperation?.operation, "rebase");
  assert.ok(state?.nativeOperation?.generation);
  assert.equal(state?.progress?.currentHash, fixture.items[0].hash);
  await git(fixture.root, "rebase", "--abort");
});

test("metadata replacement after the first state lookup cannot write recovery state to another repository", async t => {
  const fixture = await sessionFixture(t, "rebase-session-metadata", true), other = await safetyFixture(t, "rebase-session-foreign");
  const locator = join(fixture.root, ".git"), original = await fs.readFile(locator), before = await fs.readFile(fixture.path);
  let replaced = false;
  observeGit(t, (args, child) => {
    if (args.includes("--git-path") && !replaced) child.prependOnceListener("close", () => {
      replaced = true; fsSync.writeFileSync(locator, `gitdir: ${join(other.root, ".git")}\n`);
    });
  });
  try {
    await assert.rejects(updateRebaseSessionState(fixture.root, { action: "continue", phase: "running" }), /metadata changed/);
    assert.equal(replaced, true);
    assert.deepEqual(await fs.readFile(fixture.path), before);
    await assert.rejects(fs.readFile(join(other.root, ".git/gitsimplecompare/rebase-session.json")), { code: "ENOENT" });
  } finally { await fs.writeFile(locator, original); }
  assert.equal(await git(fixture.root, "rev-parse", "HEAD"), fixture.plan.checkout?.head);
  assert.equal(await git(other.root, "rev-parse", "HEAD"), other.head);
});

/** 기존 경로 쓰기와 배타적 FD 쓰기 모두 실제 임시 파일 기록 직후에 장애를 주입한다. */
function afterTemporaryWrite(t: TestContext, statePath: string, inject: () => Promise<void>) {
  const writeFile = fs.writeFile, open = fs.open;
  const isTemporary = (file: unknown) => String(file).startsWith(statePath + ".") && String(file).endsWith(".tmp");
  t.mock.method(fs, "writeFile", async (...args: any[]) => {
    await (writeFile as Function)(...args);
    if (isTemporary(args[0])) await inject();
  });
  t.mock.method(fs, "open", async (...args: any[]) => {
    const handle = await (open as Function)(...args);
    if (isTemporary(args[0]) && args[1] === "wx") {
      const write = handle.writeFile.bind(handle);
      t.mock.method(handle, "writeFile", async (...values: any[]) => { await write(...values); await inject(); });
    }
    return handle;
  });
}

test("metadata replacement after temporary write stops publication and removes only the owned temporary file", async t => {
  const fixture = await sessionFixture(t, "rebase-session-publish", true), other = await safetyFixture(t, "rebase-session-publish-foreign");
  const locator = join(fixture.root, ".git"), original = await fs.readFile(locator), before = await fs.readFile(fixture.path);
  const unrelated = fixture.path + ".unrelated.tmp";
  await fs.writeFile(unrelated, "keep unrelated recovery data");
  let replaced = false;
  afterTemporaryWrite(t, fixture.path, async () => { replaced = true; await fs.writeFile(locator, `gitdir: ${join(other.root, ".git")}\n`); });
  try {
    await assert.rejects(updateRebaseSessionState(fixture.root, { action: "continue", phase: "running" }), /metadata changed/);
    assert.equal(replaced, true);
    assert.deepEqual(await fs.readFile(fixture.path), before);
    await assert.rejects(fs.readFile(join(other.root, ".git/gitsimplecompare/rebase-session.json")), { code: "ENOENT" });
    assert.deepEqual((await fs.readdir(join(fixture.plan.checkout!.gitDir, "gitsimplecompare"))).sort(), ["rebase-session.json", "rebase-session.json.unrelated.tmp"]);
    assert.equal(await fs.readFile(unrelated, "utf8"), "keep unrelated recovery data");
  } finally { await fs.writeFile(locator, original); }
});

for (const failure of ["write", "rename"]) {
  test(`a session ${failure} failure preserves the old state and removes its incomplete temporary file`, async t => {
    const fixture = await sessionFixture(t, "rebase-session-io-failure"), before = await fs.readFile(fixture.path);
    const failureError = Object.assign(new Error("session storage sentinel"), { code: "ENOSPC" });
    if (failure === "write") afterTemporaryWrite(t, fixture.path, async () => { throw failureError; });
    else {
      const rename = fs.rename;
      t.mock.method(fs, "rename", async (...args: any[]) => {
        if (args[1] === fixture.path) throw failureError;
        return (rename as Function)(...args);
      });
    }
    await assert.rejects(updateRebaseSessionState(fixture.root, { action: "continue", phase: "running" }), error => error === failureError);
    assert.deepEqual(await fs.readFile(fixture.path), before);
    assert.deepEqual(await fs.readdir(join(fixture.plan.checkout!.gitDir, "gitsimplecompare")), ["rebase-session.json"]);
  });
}

test("an exclusive temporary-file collision never removes another writer's file", async t => {
  const fixture = await sessionFixture(t, "rebase-session-temp-owner"), before = await fs.readFile(fixture.path);
  const open = fs.open;
  let collision: string | undefined;
  t.mock.method(fs, "open", async (...args: any[]) => {
    if (String(args[0]).startsWith(fixture.path + ".") && args[1] === "wx") {
      collision = String(args[0]);
      await fs.writeFile(collision, "another writer owns this file", { flag: "wx" });
    }
    return (open as Function)(...args);
  });
  await assert.rejects(updateRebaseSessionState(fixture.root, { action: "continue", phase: "running" }), { code: "EEXIST" });
  assert.ok(collision);
  assert.equal(await fs.readFile(collision, "utf8"), "another writer owns this file");
  assert.deepEqual(await fs.readFile(fixture.path), before);
});

test("a branch switch during canonical metadata loading rejects the snapshot before publishing it", async t => {
  const fixture = await sessionFixture(t, "rebase-session-plan-race"), before = await fs.readFile(fixture.path);
  let captured!: () => void;
  const checkoutRead = new Promise<void>(resolveRead => { captured = resolveRead; });
  observeGit(t, (args, child) => {
    if (args.includes("--absolute-git-dir") && args.includes("--symbolic-full-name")) child.once("close", captured);
  });
  const getCommits = RebaseService.prototype.getCommits;
  let switched = false;
  t.mock.method(RebaseService.prototype, "getCommits", async function(this: RebaseService, ...args: Parameters<typeof getCommits>) {
    await checkoutRead;
    const commits = await getCommits.apply(this, args);
    if (!switched) { switched = true; await git(fixture.root, "switch", "-qc", "same-head-other-branch"); }
    return commits;
  });
  await assert.rejects(beginGraphRebaseSession({ base: fixture.head, root: false, items: fixture.items }, { logService: new GitLogService(fixture.root) }), /branch or HEAD changed/);
  assert.equal(switched, true);
  assert.deepEqual(await fs.readFile(fixture.path), before);
  assert.equal(await git(fixture.root, "branch", "--show-current"), "same-head-other-branch");
});
