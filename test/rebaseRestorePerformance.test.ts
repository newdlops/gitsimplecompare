import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { GitLogService } from "../src/git/gitLogService";
import { RebaseService, type RebaseItem } from "../src/git/rebaseService";
import { beginGraphRebaseSession, recordGraphRebaseSessionResult, restoreGraphRebaseSession } from "../src/webview/graphRebaseSession";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";
import { Uri } from "./helpers/vscodeMock";

/** 실제 edit rebase를 디스크 세션에서 복원할 때 반복되는 Git 조회와 사용자 편집 보존을 측정한다. */
test("restoring a paused rebase shares current state reads and preserves the uncommitted worktree", { timeout: 45_000 }, async t => {
  const { root, head } = await safetyFixture(t, "rebase-restore-performance");
  const hash = await commitText(root, "edit content\n", "edit commit");
  const items: RebaseItem[] = [{ hash, action: "edit" }];
  const messages: any[] = [];
  t.mock.method(Uri, "joinPath", (uri, ...parts) => Uri.file(join(uri.fsPath, ...parts)));
  const deps = { logService: new GitLogService(root), extensionUri: Uri.file(resolve(".")) as any,
    refreshGraph: async () => {}, post: (message: unknown) => { messages.push(message); } };
  await beginGraphRebaseSession({ base: head, root: false, items }, deps);
  const started = await new RebaseService(root).start(head, false, items, resolve("media/rebase/rebaseEditor.js"));
  assert.equal(started.status, "paused");
  await recordGraphRebaseSessionResult(root, "run", started, items);
  await writeFile(join(root, "tracked.txt"), "user worktree edit must stay untouched\n");
  const spawn = childProcess.spawn;
  const calls: string[][] = [];
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push(args[1]); return (spawn as Function)(...args);
  });
  const before = performance.now();
  assert.equal(await restoreGraphRebaseSession(deps), true);
  t.diagnostic(JSON.stringify({ calls: calls.length, elapsedMs: +(performance.now() - before).toFixed(1),
    commands: calls.map(args => args[0]), headParentReads: calls.filter(args => args[0] === "rev-parse" && args.some(value => value.endsWith("^"))).length }));
  assert.equal(calls.length, 13);
  assert.equal(calls.filter(args => args[0] === "rev-parse" && args.some(value => value.endsWith("^"))).length, 0);
  const paused = messages.find(message => message.type === "graphRebasePaused")?.paused;
  assert.equal(paused?.hash, started.paused?.hash); assert.equal(paused?.originalHash, hash); assert.equal(paused?.parent, head);
  assert.deepEqual(paused?.files.map((file: any) => file.path), ["tracked.txt"]);
  assert.equal(messages.filter(message => message.type === "graphRebasePlan").length, 1);
  assert.equal(messages.find(message => message.type === "graphRebaseProgress")?.progress.step, 1);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "user worktree edit must stay untouched\n");
  assert.equal(await git(root, "show", "HEAD:tracked.txt"), "edit content");
});

test("a conflicted rebase restores its current step without reading edit-only commit details", { timeout: 45_000 }, async t => {
  const { root, head } = await safetyFixture(t, "rebase-conflicted-restore");
  const main = await commitText(root, "main\n", "main");
  await git(root, "switch", "-qc", "side", head);
  const hash = await commitText(root, "side\n", "side");
  const items: RebaseItem[] = [{ hash, action: "edit" }];
  const messages: any[] = [];
  const deps = { logService: new GitLogService(root), extensionUri: Uri.file(resolve(".")) as any,
    refreshGraph: async () => {}, post: (message: unknown) => { messages.push(message); } };
  await beginGraphRebaseSession({ base: head, root: false, onto: main, items }, deps);
  const started = await new RebaseService(root).start(head, false, items, resolve("media/rebase/rebaseEditor.js"), main);
  assert.equal(started.status, "conflicts");
  await recordGraphRebaseSessionResult(root, "run", started, items);
  const spawn = childProcess.spawn;
  const calls: string[][] = [];
  t.mock.method(childProcess, "spawn", (...args: any[]) => { if (args[0] === "git") calls.push(args[1]); return (spawn as Function)(...args); });
  assert.equal(await restoreGraphRebaseSession(deps), true);
  t.diagnostic(`Conflicted session restore: ${calls.length} Git processes`);
  assert.equal(calls.length, 11);
  assert.equal(calls.some(args => args[0] === "log" || args[0] === "diff-tree"), false);
  assert.equal(messages.some(message => message.type === "graphRebasePaused"), false);
  assert.equal(messages.find(message => message.type === "graphRebaseProgress")?.progress.phase, "conflicts");
  assert.equal(messages.find(message => message.type === "graphRebaseProgress")?.progress.hash, hash);
  assert.equal(messages.find(message => message.type === "graphRebaseOperation")?.active, true);
  assert.equal((await readFile(join(root, "tracked.txt"), "utf8")).includes("<<<<<<<"), true);
});
