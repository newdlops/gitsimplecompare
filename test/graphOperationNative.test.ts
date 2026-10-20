import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { GitLogService } from "../src/git/gitLogService";
import { runGit, runGitWithInput } from "../src/git/gitExec";
import { gitProcesses } from "../src/git/gitProcessRegistry";
import { disposeWorkingTreeSnapshots } from "../src/git/workingTreeSnapshot";
import { createOperationGraphPanel } from "./helpers/graphOperationPanel";
import type { Commit } from "../src/graph/graphTypes";

/** status만 보류하고 취소된 소비자는 즉시 해제해 오래된 결과가 다음 작업을 붙잡지 않게 한다. */
function statusGate() {
  let open = false;
  const pending = new Set<() => void>();
  return {
    wait(signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (open) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const finish = () => { pending.delete(finish); signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => { pending.delete(finish); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
        pending.add(finish); signal?.addEventListener("abort", abort, { once: true });
      });
    },
    release() { open = true; for (const finish of [...pending]) finish(); },
  };
}

test("native checkout, rebase, merge, push, fetch and patch publish accurate history while status is suspended", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-graph-operation-")), root = path.join(directory, "repo");
  const remote = path.join(directory, "origin.git"), producer = path.join(directory, "producer");
  await mkdir(root);
  const git = (args: string[], cwd = root) => runGit(args, cwd);
  const gate = statusGate();
  let panel: any;
  t.after(async () => { gate.release(); panel?.dispose(); await disposeWorkingTreeSnapshots(); await gitProcesses.dispose(); await rm(directory, { recursive: true, force: true }); });
  await git(["init", "-q", "--initial-branch=main"]);
  for (const [key, value] of [["user.name", "Fixture"], ["user.email", "fixture@example.invalid"], ["core.fsmonitor", "false"], ["commit.gpgSign", "false"]]) await git(["config", key, value]);
  /** 충돌 없는 독립 파일을 커밋해 실제 DAG 변경과 HEAD 이동을 만든다. */
  const commit = async (file: string, content: string, cwd = root) => {
    await writeFile(path.join(cwd, file), content); await git(["add", file], cwd); await git(["commit", "-qm", file], cwd);
    return (await git(["rev-parse", "HEAD"], cwd)).trim();
  };
  await commit("base.txt", "base\n");
  await git(["init", "-q", "--bare", "--initial-branch=main", remote]);
  await git(["remote", "add", "origin", remote]); await git(["push", "-qu", "origin", "main"]);
  await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await git(["switch", "-qc", "topic"]); await commit("topic.txt", "topic\n");
  await git(["switch", "-q", "main"]); await commit("main.txt", "main\n");
  const service = new GitLogService(root), f = createOperationGraphPanel(t, service); panel = f.panel;
  let pageReads = 0;
  const readPage = service.getCommitPage.bind(service);
  t.mock.method(service, "getCommitPage", async (...args) => { pageReads++; return readPage(...args); });
  assert.equal(await panel.runDirectGraph("ready"), true);
  const actualStatus = service.getVirtualCommits.bind(service);
  t.mock.method(service, "getVirtualCommits", async signal => { await gate.wait(signal); return actualStatus(signal); });
  const results: unknown[] = [];
  /** 첫 변경 payload와 모든 행의 값이 실제 최신 Git과 일치하는지 보조 status 완료 전에 대조한다. */
  const refresh = async (operation: string, action: () => Promise<void>, expectedReads: number) => {
    const before = pageReads, count = f.messages.length, start = performance.now();
    await action();
    const elapsedMs = Math.round(performance.now() - start);
    assert.equal(pageReads - before, expectedReads, operation);
    assert.ok(f.messages.slice(count).some(message => message.type === "graph" || message.type === "graphDelta"), operation);
    assert.equal(panel.workingTree.state?.loading, true, `${operation} must publish while status is still pending`);
    const head = (await git(["rev-parse", "HEAD"])).trim();
    assert.equal(panel.commits.find((commit: Commit) => commit.refs.includes("HEAD"))?.hash, head, operation);
    const native = await new GitLogService(root).getCommitPage(300, 0, [], false);
    const values = (commits: Commit[]) => new Map(commits.map(commit => [commit.hash, { parents: commit.parents, refs: [...new Set(commit.refs)].sort() }]));
    assert.deepEqual(values(panel.commits), values(native), operation);
    results.push({ operation, elapsedMs, historyReads: pageReads - before, historyExact: true, statusStillPending: true });
  };
  await service.checkoutLocalBranch("topic");
  await refresh("checkout", () => panel.refreshAfterCheckoutAction(), 0);
  await git(["rebase", "main"]);
  await refresh("rebase", () => panel.refreshAfterGraphAction(), 1);
  await service.checkoutLocalBranch("main"); await panel.refreshAfterCheckoutAction();
  await git(["merge", "--no-ff", "-qm", "fixture merge", "topic"]);
  await refresh("merge", () => panel.refreshAfterGraphAction(), 1);
  await git(["push", "-q", "origin", "main"]);
  await refresh("push", () => panel.refreshAfterGraphAction("references"), 0);
  await git(["clone", "-q", remote, producer]);
  await git(["config", "user.name", "Fixture"], producer); await git(["config", "user.email", "fixture@example.invalid"], producer);
  await git(["config", "core.fsmonitor", "false"], producer); await git(["config", "commit.gpgSign", "false"], producer);
  await commit("fetched.txt", "fetched\n", producer); await git(["push", "-q", "origin", "HEAD:refs/heads/fetched"], producer);
  await git(["fetch", "-q", "--no-tags", "origin"]);
  await refresh("fetch", () => panel.refreshAfterGraphAction(), 1);
  await runGitWithInput(["apply"], root, "diff --git a/base.txt b/base.txt\n--- a/base.txt\n+++ b/base.txt\n@@ -1 +1 @@\n-base\n+patched\n");
  await refresh("patch", () => panel.refreshAfterGraphAction(), 0);
  await refresh("no-op fetch", async () => { await service.fetchAll(); await panel.refreshAfterFetchAction(); }, 0);
  gate.release();
  const deadline = Date.now() + 10000;
  while (panel.workingTree.state?.loading && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(panel.workingTree.state, undefined);
  assert.equal(panel.virtualCommits.length, 2, "the patched working tree must replace its loading state with actual virtual rows");
  assert.deepEqual(panel.virtualCommits[1].parents, [(await git(["rev-parse", "HEAD"])).trim()]);
  t.diagnostic(JSON.stringify(results));
});
