import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadCommitWindowForCandidates, loadLocalCommitWindowForCandidates } from "../src/git/gitLogWindow";
import { loadFilteredGraphCommitWindow } from "../src/webview/graphCommitWindowLoading";
import { ensureGraphCommitVisible } from "../src/webview/graphCommitFocus";
import { resolveBranchFilter } from "../src/webview/graphBranchFilter";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { GraphReadLifecycleCoordinator } from "../src/webview/graphPageLoading";
import type { ToWebviewMessage } from "../src/webview/graphProtocol";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

const all = () => resolveBranchFilter({ mode: "all", selected: [], compact: true }, []);
const missing = Array.from({ length: 80 }, (_, i) => (i + 1).toString(16).padStart(40, "0"));

test("eighty missing PR candidates and a present candidate read history once and preserve candidate priority", async t => {
  const f = await safetyFixture(t, "pr-jump-candidates");
  const head = await commitText(f.root, "next\n", "next"), commands: string[] = [];
  const stop = setGitExecutionObserver(row => commands.push(row.command)); t.after(stop);
  const window = await loadCommitWindowForCandidates(f.root, [...missing, f.head, head], { before: 0, after: 1 });
  assert.equal(window.hash, f.head, "candidate priority wins over the graph's newest commit");
  assert.deepEqual(window.commits.map(commit => commit.hash), [f.head]);
  assert.equal(window.targetIndex, 1); assert.equal(window.totalCount, 2);
  assert.equal(commands.filter(command => command === "rev-list").length, 1);
  assert.equal(commands.filter(command => command === "log").length, 1);
});

test("an unreferenced local PR commit can be displayed without changing HEAD, refs, index, or configuration", async t => {
  const f = await safetyFixture(t, "pr-jump-local");
  const tree = await git(f.root, "rev-parse", "HEAD^{tree}");
  const detached = await git(f.root, "commit-tree", tree, "-p", f.head, "-m", "unreferenced PR");
  const before = { head: await git(f.root, "rev-parse", "HEAD"), refs: await git(f.root, "show-ref"),
    index: await readFile(path.join(f.root, ".git/index")), config: await readFile(path.join(f.root, ".git/config")) };
  const commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command));
  const window = await loadFilteredGraphCommitWindow(f.root, [...missing, detached], all(), 10); stop();
  assert.equal(window?.hash, detached); assert.equal(window?.commits[0].hash, detached);
  assert.deepEqual(window?.commits.map(commit => commit.hash), [detached, f.head]);
  assert.equal(commands.filter(command => command === "rev-list").length, 1);
  assert.equal(commands.filter(command => command === "cat-file").length, 1);
  assert.equal(commands.filter(command => command === "log").length, 1);
  assert.equal(commands.includes("fetch"), false);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), before.head);
  assert.equal(await git(f.root, "show-ref"), before.refs);
  assert.deepEqual(await readFile(path.join(f.root, ".git/index")), before.index);
  assert.deepEqual(await readFile(path.join(f.root, ".git/config")), before.config);
});

test("explicit branch filters are preserved and empty filters never expand to all refs", async t => {
  const f = await safetyFixture(t, "pr-jump-filter");
  const tree = await git(f.root, "rev-parse", "HEAD^{tree}");
  const detached = await git(f.root, "commit-tree", tree, "-p", f.head, "-m", "filtered PR");
  const filter = resolveBranchFilter({ mode: "custom", selected: ["main"], compact: true }, [{ name: "main", kind: "local" }]);
  const commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command)); t.after(stop);
  assert.equal(await loadFilteredGraphCommitWindow(f.root, [detached], filter, 10), undefined);
  assert.deepEqual(commands, ["rev-list"]);
  const empty = resolveBranchFilter({ mode: "custom", selected: [], compact: true }, []);
  assert.equal(await loadFilteredGraphCommitWindow(f.root, [f.head], empty, 10), undefined);
  assert.deepEqual(commands, ["rev-list"], "an empty custom selection must not query the repository");
});

for (const remoteStatus of ["pending", "ready", "error"] as const) {
  test(`an All branches jump can show an unreferenced PR while the catalog is ${remoteStatus}`, async t => {
    const f = await safetyFixture(t, "pr-jump-safe-catalog");
    const tree = await git(f.root, "rev-parse", "HEAD^{tree}");
    const detached = await git(f.root, "commit-tree", tree, "-p", f.head, "-m", "PR outside the branch catalog");
    const filter = resolveBranchFilter({ mode: "all", selected: [], compact: true },
      [{ name: "main", kind: "local" }], remoteStatus, true);
    const before = { refs: await git(f.root, "show-ref"), index: await readFile(path.join(f.root, ".git/index")),
      config: await readFile(path.join(f.root, ".git/config")) };
    const commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command)); t.after(stop);
    const window = await loadFilteredGraphCommitWindow(f.root, [detached], filter, 10);
    assert.equal(window?.hash, detached);
    assert.deepEqual(window?.commits.map(commit => commit.hash), [detached, f.head]);
    assert.deepEqual(commands, ["rev-list", "cat-file", "log"]);
    assert.equal(await git(f.root, "show-ref"), before.refs);
    assert.deepEqual(await readFile(path.join(f.root, ".git/index")), before.index);
    assert.deepEqual(await readFile(path.join(f.root, ".git/config")), before.config);
  });
}

test("an empty pending All branches catalog resolves only the requested commit without an implicit all-ref read", async t => {
  const f = await safetyFixture(t, "pr-jump-empty-catalog");
  const filter = resolveBranchFilter({ mode: "all", selected: [], compact: true }, [], "pending");
  const commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command)); t.after(stop);
  const window = await loadFilteredGraphCommitWindow(f.root, [f.head], filter, 10);
  assert.equal(window?.hash, f.head);
  assert.deepEqual(commands, ["cat-file", "log"]);
});

test("missing and noncommit candidates fail without repeated history reads or fetching", async t => {
  const f = await safetyFixture(t, "pr-jump-missing"), tree = await git(f.root, "rev-parse", "HEAD^{tree}");
  const commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command)); t.after(stop);
  assert.equal(await loadFilteredGraphCommitWindow(f.root, [...missing, tree], all(), 10), undefined);
  assert.deepEqual(commands, ["rev-list", "cat-file"]);
  assert.equal(await loadLocalCommitWindowForCandidates(f.root, ["HEAD", "--all", "malformed\nHEAD"], 10), undefined);
  assert.deepEqual(commands, ["rev-list", "cat-file"]);
});

test("cancelled candidate reads never start Git and visibility failures always complete the UI request", async t => {
  const controller = new AbortController(); controller.abort();
  const commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command)); t.after(stop);
  await assert.rejects(loadCommitWindowForCandidates(process.cwd(), missing, { before: 80, after: 10, signal: controller.signal }));
  await assert.rejects(loadLocalCommitWindowForCandidates(process.cwd(), missing, 10, controller.signal));
  await assert.rejects(loadFilteredGraphCommitWindow(process.cwd(), missing, all(), 10, controller.signal));
  assert.deepEqual(commands, []);
  const messages: ToWebviewMessage[] = [], failure = new Error("Native log failed");
  await ensureGraphCommitVisible({ repoRoot: "/fixture", hashes: missing, requestId: "failed-jump",
    loadedHash: () => undefined, loadWindow: async () => { throw failure; }, post: message => messages.push(message) });
  assert.deepEqual(messages, [{ type: "commitVisibility", requestId: "failed-jump", found: false }]);
});

test("cancelling an unloaded PR jump cannot stop a newer jump or an unrelated graph page", async () => {
  const reads = new GraphReadLifecycleCoordinator();
  let oldSignal!: AbortSignal, newSignal!: AbortSignal, finish!: () => void;
  const old = reads.run("/fixture", "commitWindow", signal => {
    oldSignal = signal; return new Promise<string>(resolve => signal.addEventListener("abort", () => resolve("old"), { once: true }));
  }, "old");
  const current = reads.run("/fixture", "commitWindow", async signal => {
    newSignal = signal; await new Promise<void>(resolve => { finish = resolve; }); return "new";
  }, "new");
  reads.cancelCommitFocus("old"); assert.equal(oldSignal.aborted, true); assert.equal(newSignal.aborted, false);
  reads.cancelCommitFocus("new"); assert.equal(newSignal.aborted, true); finish();
  assert.equal(await old, undefined); assert.equal(await current, undefined);
  let pageSignal!: AbortSignal;
  const page = reads.run("/fixture", "page", async signal => { pageSignal = signal; reads.cancelCommitFocus("new"); return "page"; });
  assert.equal(pageSignal.aborted, false); assert.equal(await page, "page");
});
