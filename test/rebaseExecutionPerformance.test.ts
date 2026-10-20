import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import type * as vscode from "vscode";
import { GitLogService } from "../src/git/gitLogService";
import { assertGitOperation, captureGitOperation } from "../src/git/operationControl";
import { assertRebaseCheckout, captureRebaseCheckout } from "../src/git/rebasePlanSafety";
import { RebaseService, type RebaseItem } from "../src/git/rebaseService";
import { readRebaseTodoProgress } from "../src/git/rebaseTodoProgress";
import { continueGraphRebase } from "../src/webview/graphRebaseActions";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";
import { Uri } from "./helpers/vscodeMock";

/** 실제 Git을 실행하면서 사용자 동작 하나가 만드는 프로세스 수를 센다. */
function recordGitCalls(t: TestContext): string[][] {
  const calls: string[][] = [];
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push(args[1]);
    return (spawn as Function)(...args);
  });
  return calls;
}

/** 실제 저장소를 사용하는 그래프 실행에 VS Code URI 조립과 빈 화면 새로고침만 주입한다. */
function graphDeps(t: TestContext, root: string) {
  t.mock.method(Uri, "joinPath", (uri, ...parts) => Uri.file(join(uri.fsPath, ...parts)));
  return {
    logService: new GitLogService(root), extensionUri: Uri.file(resolve(".")) as unknown as vscode.Uri,
    refreshGraph: async () => {},
  };
}

test("checkout and operation identity each use one Git process and still observe branch switches", async t => {
  const { root, head } = await safetyFixture(t, "rebase-identity-fast");
  const calls = recordGitCalls(t);
  const started = performance.now();
  const checkout = await captureRebaseCheckout(root);
  const checkoutCalls = calls.length;
  calls.length = 0;
  const operation = await captureGitOperation(root);
  const operationCalls = calls.length;
  t.diagnostic(`Identity: checkout=${checkoutCalls}, operation=${operationCalls} Git processes, ${Math.round(performance.now() - started)}ms total`);
  assert.equal(checkout.head, head);
  assert.equal(checkout.branch, "refs/heads/main");
  assert.equal(checkout.gitDir, await realpath(join(root, ".git")));
  assert.equal(operation.head, head);
  assert.equal(operation.branch, "main");
  await git(root, "switch", "-qc", "another");
  await assert.rejects(assertRebaseCheckout(root, checkout), /branch or HEAD changed/);
  await assert.rejects(assertGitOperation(root, operation), /operation changed/);
  assert.equal(checkoutCalls, 1);
  assert.equal(operationCalls, 1);
});

test("identity keeps linked worktrees, Unicode refs and newline paths separate", async t => {
  const { root, directory, head } = await safetyFixture(t, "rebase-identity-worktree");
  const linked = join(directory, "linked path\nwith whitespace ");
  await git(root, "worktree", "add", "-qb", "feature/한글", linked, head);
  const alias = join(directory, "alias");
  await symlink(linked, alias, "dir");
  const checkout = await captureRebaseCheckout(alias);
  const operation = await captureGitOperation(alias);
  assert.equal(checkout.branch, "refs/heads/feature/한글");
  assert.equal(operation.branch, "feature/한글");
  assert.equal(checkout.head, head);
  assert.equal(checkout.gitDir, operation.gitDir);
  assert.notEqual(checkout.gitDir, await realpath(join(root, ".git")));
  await assertRebaseCheckout(linked, checkout);
  await assertGitOperation(linked, operation);
});

test("checkout identity also parses CRLF command output without changing the directory", async t => {
  const { root, head } = await safetyFixture(t, "rebase-identity-crlf");
  const gitDir = await realpath(join(root, ".git"));
  const output = `${gitDir}\r\n${head}\r\nrefs/heads/main\r\n`;
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git" && args[1].includes("--symbolic-full-name")) {
      return spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(output)});`], args[2]);
    }
    return (spawn as Function)(...args);
  });
  assert.deepEqual(await captureRebaseCheckout(root), { gitDir, head, branch: "refs/heads/main" });
});

test("detached operation identity remains supported and cannot become a rebase checkout", async t => {
  const { root, head } = await safetyFixture(t, "rebase-identity-detached");
  await git(root, "switch", "--detach", "HEAD");
  const operation = await captureGitOperation(root);
  assert.equal(operation.head, head);
  assert.equal(operation.branch, "");
  await assert.rejects(captureRebaseCheckout(root));
});

test("a tag named HEAD cannot replace or hide the actual symbolic branch", async t => {
  const { root, head: base } = await safetyFixture(t, "rebase-identity-head-tag");
  const head = await commitText(root, "new HEAD\n", "new HEAD");
  await git(root, "update-ref", "refs/tags/HEAD", base);
  const checkout = await captureRebaseCheckout(root);
  const operation = await captureGitOperation(root);
  assert.equal(checkout.head, head);
  assert.equal(checkout.branch, "refs/heads/main");
  assert.equal(operation.branch, "main");
  await git(root, "switch", "--detach", head);
  const detached = await captureGitOperation(root);
  assert.equal(detached.head, head);
  assert.equal(detached.branch, "");
  await assert.rejects(captureRebaseCheckout(root));
});

test("checkout identity supports SHA-256 and rejects an unborn HEAD", async t => {
  const { directory } = await safetyFixture(t, "rebase-identity-sha256");
  const root = join(directory, "sha256\nrepo");
  await mkdir(root);
  await git(root, "init", "-qb", "main", "--object-format=sha256");
  await assert.rejects(captureGitOperation(root));
  for (const [key, value] of Object.entries({ "user.name": "Test", "user.email": "test@example.test", "commit.gpgsign": "false", "core.fsmonitor": "false", "core.hooksPath": join(directory, "hooks") })) {
    await git(root, "config", key, value);
  }
  const head = await commitText(root, "sha256\n", "sha256");
  const checkout = await captureRebaseCheckout(root);
  assert.equal(checkout.head, head);
  assert.equal(head.length, 64);
  assert.equal(checkout.gitDir, await realpath(join(root, ".git")));
});

test("Start and Continue finish a real edit rebase with bounded Git preparation", async t => {
  const { root, head } = await safetyFixture(t, "rebase-execution-count");
  const hash = await commitText(root, "edit content\n", "edit");
  const service = new RebaseService(root, { nativeEditors: true });
  const calls = recordGitCalls(t);
  const started = performance.now();
  const result = await service.start(head, false, [{ hash, action: "edit" }], resolve("media/rebase/rebaseEditor.js"));
  const startCalls = calls.length;
  const startMs = Math.round(performance.now() - started);
  assert.equal(result.status, "paused");
  calls.length = 0;
  const continueStarted = performance.now();
  const continued = await continueGraphRebase(graphDeps(t, root));
  const continueCalls = calls.length;
  t.diagnostic(`Start: ${startCalls} Git processes, ${startMs}ms; Continue: ${continueCalls} Git processes, ${Math.round(performance.now() - continueStarted)}ms`);
  assert.equal(continued.status, "completed");
  assert.ok(startCalls <= 14, `Start exceeded its Git process budget: ${startCalls}`);
  assert.ok(continueCalls <= 32, `Continue exceeded its Git process budget: ${continueCalls}`);
  assert.equal(await git(root, "show", "HEAD:tracked.txt"), "edit content");
  assert.equal(await git(root, "rev-list", "--count", `${head}..HEAD`), "1");
});

test("a known worktree directory avoids path processes but observes every native Continue and Abort", async t => {
  const { root, head } = await safetyFixture(t, "rebase-progress-fresh");
  const first = await commitText(root, "first\n", "first");
  const second = await commitText(root, "second\n", "second");
  const result = await new RebaseService(root, { nativeEditors: true }).start(head, false, [
    { hash: first, action: "edit" }, { hash: second, action: "edit" },
  ], resolve("media/rebase/rebaseEditor.js"));
  assert.equal(result.status, "paused");
  const { gitDir } = await captureGitOperation(root);
  const calls = recordGitCalls(t);
  assert.equal((await readRebaseTodoProgress(root, gitDir))?.currentHash, first);
  assert.equal(calls.length, 0);
  await git(root, "-c", "core.editor=true", "rebase", "--continue");
  calls.length = 0;
  assert.equal((await readRebaseTodoProgress(root, gitDir))?.currentHash, second);
  assert.equal(calls.length, 0);
  await git(root, "rebase", "--abort");
  calls.length = 0;
  assert.equal(await readRebaseTodoProgress(root, gitDir), undefined);
  assert.equal(calls.length, 0);
});

for (const linked of [false, true]) {
  test(`reword and squash use the latest queued messages across an edit pause in a ${linked ? "linked" : "normal"} worktree`, async t => {
    const fixture = await safetyFixture(t, "rebase-message-resume");
    let root = fixture.root;
    if (linked) {
      root = join(fixture.directory, "linked");
      await git(fixture.root, "worktree", "add", "-qb", "linked", root, fixture.head);
    }
    const hashes: string[] = [];
    for (let index = 0; index < 4; index++) hashes.push(await commitText(root, `content ${index}\n`, `original ${index}`));
    const items: RebaseItem[] = [
      { hash: hashes[0], action: "reword", message: "first rewritten\n\nfirst body" },
      { hash: hashes[1], action: "edit" },
      { hash: hashes[2], action: "squash", message: "combined edit and squash" },
      { hash: hashes[3], action: "reword", message: "old final message" },
    ];
    const result = await new RebaseService(root, { nativeEditors: true }).start(fixture.head, false, items, resolve("media/rebase/rebaseEditor.js"));
    assert.equal(result.status, "paused");
    items[3].message = "latest final message";
    const gitDir = (await captureGitOperation(root)).gitDir;
    assert.equal((await continueGraphRebase(graphDeps(t, root), items)).status, "completed");
    assert.equal(await git(root, "log", "--reverse", "--format=%s", `${fixture.head}..HEAD`), "first rewritten\ncombined edit and squash\nlatest final message");
    assert.equal(await git(root, "show", "HEAD:tracked.txt"), "content 3");
    await assert.rejects(readFile(join(gitDir, "gitsimplecompare/rebase-message-queue-state.json")), { code: "ENOENT" });
    if (linked) assert.equal(await git(fixture.root, "rev-parse", "HEAD"), fixture.head);
  });
}
