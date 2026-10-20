import assert from "node:assert/strict";
import test from "node:test";
import cp from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitLogService } from "../src/git/gitLogService";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { disposeWorkingTreeSnapshots } from "../src/git/workingTreeSnapshot";
import { gitProcesses } from "../src/git/gitProcessRegistry";
import { createOperationGraphPanel } from "./helpers/graphOperationPanel";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 테스트 gate로 실제 Git의 완료 순서를 제어해 임의의 sleep이나 기계 성능에 의존하지 않는다. */
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test("real first-page history overlaps branch preparation and adopted containment matches native Git", async t => {
  const f = await safetyFixture(t, "graph-first-page-native");
  await git(f.root, "branch", "topic");
  const head = await commitText(f.root, "next\n", "next");
  const service = new GitLogService(f.root), branchesEntered = gate(), releaseBranches = gate(), historyReady = gate();
  let historyStarted = false;
  const readHistory = service.readUnindexedCommitPageSnapshot.bind(service), readBranches = service.getLocalBranchSnapshot.bind(service);
  t.mock.method(service, "readUnindexedCommitPageSnapshot", async (...args: Parameters<typeof readHistory>) => {
    historyStarted = true; const result = await readHistory(...args); historyReady.resolve(); return result;
  });
  t.mock.method(service, "getLocalBranchSnapshot", async (...args: Parameters<typeof readBranches>) => {
    branchesEntered.resolve(); await releaseBranches.promise; return readBranches(...args);
  });
  const { panel } = createOperationGraphPanel(t, service);
  t.after(async () => { releaseBranches.resolve(); panel.dispose(); await disposeWorkingTreeSnapshots(); await gitProcesses.dispose(); });
  const commands: string[] = [], stop = setGitExecutionObserver(value => commands.push(value.command)); t.after(stop);
  const loading = panel.runDirectGraph("ready");
  await branchesEntered.promise;
  assert.equal(historyStarted, true, "Real git log waited for branch preparation");
  await historyReady.promise; await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(panel.commits.find((commit: { refs: string[] }) => commit.refs.includes("HEAD"))?.hash, head);
  assert.equal(panel.branchDetails.state?.loading, true, "Real history still waits for gated branch details");
  releaseBranches.resolve(); assert.equal(await loading, true);
  stop(); assert.equal(commands.filter(command => command === "log").length, 1);
  const signature = (commits: typeof panel.commits) => commits.map(({ hash, parents, refs, authorName, authorEmail, dateIso, subject }: import("../src/graph/graphTypes").Commit) =>
    ({ hash, parents, refs, authorName, authorEmail, dateIso, subject }));
  assert.deepEqual(signature(panel.commits), signature(await new GitLogService(f.root).getCommitPage(300, 0, [], false)));
  assert.equal(panel.commits.find((commit: { refs: string[] }) => commit.refs.includes("HEAD"))?.hash, head);
  let containsReads = 0; const spawn = cp.spawn;
  t.mock.method(cp, "spawn", (...args: Parameters<typeof cp.spawn>) => {
    if (Array.isArray(args[1]) && args[1].some(arg => arg === "--contains" || arg.startsWith("--contains="))) containsReads++;
    return Reflect.apply(spawn, cp, args);
  });
  const detail = await service.getCommitDetail(f.head);
  assert.equal(containsReads, 0, "Adoption lost the complete containment index and needed an extra Git walk");
  const expected = (await git(f.root, "for-each-ref", `--contains=${f.head}`, "--format=%(refname:short)", "refs/heads", "refs/remotes")).split("\n").filter(Boolean).sort();
  assert.deepEqual(detail.branches.map(branch => branch.name).sort(), expected);
});

test("a corrupt local ref discards the failed all-ref preparation and retains the healthy filtered graph", async t => {
  const f = await safetyFixture(t, "graph-first-page-corrupt");
  await writeFile(join(f.root, ".git/refs/heads/broken"), "b".repeat(40) + "\n");
  const service = new GitLogService(f.root), { panel } = createOperationGraphPanel(t, service);
  t.after(async () => { panel.dispose(); await disposeWorkingTreeSnapshots(); await gitProcesses.dispose(); });
  assert.equal(await panel.runDirectGraph("ready"), true);
  assert.equal(panel.invalidLocalRefs.length, 1);
  assert.deepEqual(panel.commits.map((value: { hash: string }) => value.hash), [f.head]);
  assert.equal(panel.commits[0].refs.includes("HEAD"), true);
  const commands: string[] = [], stop = setGitExecutionObserver(value => commands.push(value.command));
  try { assert.equal(await panel.runDirectGraph("manual"), true); } finally { stop(); }
  assert.equal(commands.filter(command => command === "log").length, 1, "Known corrupt refs must not start another unusable all-ref read");
  assert.equal(panel.invalidLocalRefs.length, 1);
});
