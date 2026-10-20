import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readGraphRefreshSnapshot } from "../src/git/graphRefreshFingerprint";
import { readGraphHistoryIdentity } from "../src/git/graphHistoryIdentity";
import { canReuseGraphSnapshot } from "../src/webview/graphHistoryReuse";
import { GitLogService } from "../src/git/gitLogService";
import { createOperationGraphPanel } from "./helpers/graphOperationPanel";
import { disposeWorkingTreeSnapshots } from "../src/git/workingTreeSnapshot";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";
import * as vscode from "./helpers/vscodeMock";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";

test("same refs with a changed shallow/graft boundary have a distinct refresh fingerprint", async t => {
  const { root, head } = await safetyFixture(t, "graph-topology");
  const before = await readGraphRefreshSnapshot(root);
  await writeFile(join(root, ".git", "shallow"), `${head}\n`);
  const shallow = await readGraphRefreshSnapshot(root);
  assert.notEqual(shallow.fingerprint, before.fingerprint);
  assert.notEqual(shallow.historyIdentity, before.historyIdentity);
  await rm(join(root, ".git", "shallow"));
  await writeFile(join(root, ".git", "info", "grafts"), `${head}\n`);
  assert.notEqual(await readGraphHistoryIdentity(root), before.historyIdentity);
});

test("unknown metadata, manual refresh, replacement refs and topology changes cannot reuse the graph", async t => {
  const { root } = await safetyFixture(t, "graph-topology-guard"), snapshot = await readGraphRefreshSnapshot(root);
  const commits = await new GitLogService(root).getCommitPage(300, 0, [], false);
  const context = { ...snapshot, repoRoot: root, cause: "fetch", generation: 1, previous: snapshot };
  assert.equal(canReuseGraphSnapshot(context, commits), true);
  for (const cause of ["ready", "manual"]) assert.equal(canReuseGraphSnapshot({ ...context, cause }, commits), false);
  assert.equal(canReuseGraphSnapshot({ ...context, historyIdentity: undefined }, commits), false);
  assert.equal(canReuseGraphSnapshot({ ...context, historyIdentity: "changed" }, commits), false);
  assert.equal(canReuseGraphSnapshot({ ...context, fingerprint: snapshot.fingerprint.replace("--worktrees--", `refs/replace/${"a".repeat(40)} ${"b".repeat(40)}\n--worktrees--`) }, commits), false);
  assert.equal(await readGraphHistoryIdentity(join(root, "missing")), undefined);
  await mkdir(join(root, ".git", "shallow"));
  assert.equal(await readGraphHistoryIdentity(root), undefined);
});

test("deepening a shallow clone reloads the real newly available parents even when refs stay fixed", { timeout: 60000 }, async t => {
  const f = await safetyFixture(t, "graph-shallow-fetch");
  await commitText(f.root, "second\n", "second"); await commitText(f.root, "third\n", "third");
  const remote = await addOrigin(f.root, f.directory), clone = join(f.directory, "clone");
  await git(f.directory, "clone", "-q", "--depth=1", "--branch=main", `file://${remote}`, clone);
  await git(clone, "config", "core.fsmonitor", "false");
  const service = new GitLogService(clone), { panel } = createOperationGraphPanel(t, service);
  t.after(async () => { panel.dispose(); await disposeWorkingTreeSnapshots(); });
  await panel.runDirectGraph("ready");
  assert.equal(panel.commits.length, 1); assert.deepEqual(panel.commits[0].parents, []);
  const head = await git(clone, "rev-parse", "HEAD"), before = await readGraphRefreshSnapshot(clone);
  await git(clone, "fetch", "-q", "--deepen=10", "origin");
  assert.equal(await git(clone, "rev-parse", "HEAD"), head);
  assert.notEqual((await readGraphRefreshSnapshot(clone)).historyIdentity, before.historyIdentity);
  await panel.refreshAfterFetchAction();
  const actual = await new GitLogService(clone).getCommitPage(300, 0, [], false);
  assert.equal(panel.commits.length, 3);
  assert.deepEqual(panel.commits.map(({ hash, parents }: any) => ({ hash, parents })), actual.map(({ hash, parents }) => ({ hash, parents })));
});

test("a graph created in an unfocused window performs no half reload and resumes on focus", { timeout: 30000 }, async t => {
  const { root, head } = await safetyFixture(t, "graph-initial-unfocused");
  const focused = vscode.window.state.focused;
  vscode.window.state.focused = false;
  const { panel } = createOperationGraphPanel(t, new GitLogService(root));
  let processes = 0;
  const unobserve = setGitExecutionObserver(() => { processes++; });
  try {
    assert.equal(await panel.runDirectGraph("ready"), false);
    assert.equal(processes, 0, "background creation must not spawn partial fingerprint/branch queries");
    assert.equal(panel.commits.length, 0);
    vscode.window.state.focused = true; panel.handleWindowFocusChange(true);
    const deadline = Date.now() + 20000;
    while (!panel.commits.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(panel.commits[0]?.hash, head);
  } finally { vscode.window.state.focused = focused; unobserve(); panel.dispose(); await disposeWorkingTreeSnapshots(); }
});
