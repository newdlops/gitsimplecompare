// 전용 Development Host의 실제 renderer ACK로 Git 작업 뒤 최신 Graph paint를 검증한다.
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { writeFile } from "node:fs/promises";
import * as vscode from "vscode";
import { runGit } from "../../src/git/gitExec";
import type { GitLogService } from "../../src/git/gitLogService";
import { BranchOperationService } from "../../src/git/branchOperationService";
import { PullRequestOperationService } from "../../src/git/pullRequestOperationService";
import { PullService } from "../../src/git/pullService";
import { getCurrentPushPlan, pushCurrentWithAutoUpstream } from "../../src/git/pushService";
import type { PullRequestInfo } from "../../src/git/pullRequestInfo";
import type { FromWebviewMessage } from "../../src/webview/graphProtocol";

type Paint = Extract<FromWebviewMessage, { type: "graphRendered" }>;

/**
 * renderer가 실제 2번째 animation frame 뒤 돌려준 trace별 첫 ACK를 보관한다.
 * @returns 메시지 관찰 함수·특정 세대의 첫 paint 조회·테스트 종료 시 기록 해제 경계
 */
export function operationPaintRecorder() {
  const first = new Map<string, Paint>();
  return {
    observe(message: FromWebviewMessage) {
      if (message.type !== "graphRendered") return;
      const id = message.performance.traceId;
      if (!first.has(id)) first.set(id, message);
    },
    peek(id: string): Paint | undefined { return first.get(id); },
    dispose() { first.clear(); },
  };
}

/**
 * 로컬 저장소와 bare origin만 사용해 ref 재사용·HEAD 이동·새 DAG·fetch의 실제 paint를 검사한다.
 * @param graph 전용 Host에서 만든 실제 panel @param service fixture의 실제 Git 서비스 @param paints 같은 웹뷰의 ACK 기록기
 * @returns 모든 최신 HEAD/branch/paint가 검증된 뒤 완료한다. 사용자의 다른 창·프로필·원격에는 접근하지 않는다.
 */
export async function verifyGraphOperationPaints(graph: any, service: GitLogService, paints: ReturnType<typeof operationPaintRecorder>, ensureFocused: () => Promise<void>,
  readPaintedRows: () => Promise<Array<{ hash: string; refs: string[]; branches: string[]; head: boolean }>>): Promise<void> {
  const root = service.repoRoot, git = (args: string[], cwd = root) => runGit(args, cwd);
  const base = (await git(["rev-parse", "HEAD"])).trim();
  await git(["add", "sample.txt"]); await git(["commit", "-qm", "saved fixture edits"]);
  const main = (await git(["rev-parse", "HEAD"])).trim();
  await ensureFocused();
  await graph.runDirectGraph("ready");
  const preparedDeadline = Date.now() + 20000;
  while (graph.commits.find((commit: any) => commit.refs.includes("HEAD"))?.hash !== main && Date.now() < preparedDeadline) {
    await ensureFocused(); await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(graph.commits.find((commit: any) => commit.refs.includes("HEAD"))?.hash, main, "Foreground reconcile must finish fixture setup before measuring.");
  const originalPage = service.getCommitPage.bind(service), originalStatus = service.getVirtualCommits.bind(service);
  let pageReads = 0;
  const results: unknown[] = [];
  service.getCommitPage = async (...args) => { pageReads++; return originalPage(...args); };
  /** 느린 status를 보류해 최신 이력의 paint가 보조 조회 완료를 기다리지 않는지 확인한다. */
  const measure = async (operation: string, mutate: () => Promise<unknown>, refresh: () => Promise<unknown>, expectedReads: number) => {
    await ensureFocused();
    const before = pageReads, previousTrace = graph.activePerformance?.id;
    await mutate();
    const completedAt = Date.now();
    let focusInterruptions = vscode.window.state.focused ? 0 : 1;
    const focusListener = vscode.window.onDidChangeWindowState(state => { if (!state.focused) focusInterruptions++; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    service.getVirtualCommits = async signal => { await gate; signal?.throwIfAborted(); return originalStatus(signal); };
    try {
      await refresh();
      const head = (await git(["rev-parse", "HEAD"])).trim(), deadline = Date.now() + 20000;
      let paint: Paint | undefined;
      // 실제 focus 해제로 취소됐다면 mutation을 반복하지 않고 같은 panel의 자동 reconcile paint를 기다린다.
      while (Date.now() < deadline) {
        if (!vscode.window.state.focused) await ensureFocused();
        const trace = graph.activePerformance;
        if (trace?.id !== previousTrace && graph.commits.find((commit: any) => commit.refs.includes("HEAD"))?.hash === head) paint = paints.peek(trace.id);
        if (paint) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(paint, `${operation}: latest Git state was never painted after focus reconciliation`);
      if (!focusInterruptions) assert.equal(pageReads - before, expectedReads, `${operation}: expected only necessary history reads`);
      else assert.ok(pageReads - before >= expectedReads, `${operation}: changed DAG must still be read after focus reconciliation`);
      assert.equal(graph.commits.find((commit: any) => commit.refs.includes("HEAD"))?.hash, head);
      const rendered = await readPaintedRows(), headRow = rendered.find(row => row.head);
      assert.equal(headRow?.hash, head, `${operation}: the painted HEAD badge must match actual Git`);
      assert.ok(headRow);
      const branch = (await git(["branch", "--show-current"])).trim();
      assert.ok(headRow.branches.includes(branch), `${operation}: current branch chip must be on the painted HEAD`);
      for (const row of rendered.filter(row => /^[0-9a-f]{40,64}$/.test(row.hash))) {
        const commit = graph.commits.find((item: any) => item.hash === row.hash);
        assert.ok(commit, `${operation}: renderer retained a stale commit row`);
        assert.deepEqual([...row.refs].sort(), [...commit.refs].sort(), `${operation}: stale painted ref badges at ${row.hash}`);
      }
      const result = { check: "operationGraphPaint", operation, completedToPaintMs: paint.paintedAt - completedAt,
        historyReads: pageReads - before, kind: paint.performance.kind, windowFocused: vscode.window.state.focused, focusInterruptions,
        paintedHead: head, renderedRowsChecked: rendered.length, paintedRefsMatch: true };
      results.push(result); console.log(JSON.stringify(result));
    } finally { focusListener.dispose(); release(); service.getVirtualCommits = originalStatus; }
  };
  try {
    await measure("create-branch", () => git(["branch", "paint-topic", base]), () => graph.refreshAfterGraphAction("references"), 0);
    await measure("checkout", () => service.checkoutLocalBranch("paint-topic"), () => graph.refreshAfterCheckoutAction(), 0);
    assert.equal(graph.lastLocalBranches.find((branch: any) => branch.current)?.name, "paint-topic");
    await measure("new-commit", () => git(["commit", "--allow-empty", "-qm", "new graph root"]), () => graph.refreshAfterGraphAction(), 1);
    const remote = join(dirname(root), "paint-origin.git");
    await git(["-c", "init.templateDir=", "init", "--bare", "-q", remote]);
    await git(["remote", "add", "origin", remote]); await git(["push", "-q", "origin", "main"]);
    await git(["update-ref", "refs/heads/fetched-known", main], remote);
    await measure("fetch-known-history", () => service.fetchAll(), () => graph.refreshAfterFetchAction(), 0);
    assert.ok(graph.commits.find((commit: any) => commit.hash === main)?.refs.includes("origin/fetched-known"));
    await measure("push", async () => { await pushCurrentWithAutoUpstream(root, await getCurrentPushPlan(root)); }, () => graph.refreshAfterGraphAction("references"), 0);
    const remoteHead = (await git(["rev-parse", "HEAD"])).trim(), tree = (await git(["rev-parse", "HEAD^{tree}"])).trim();
    const incoming = (await git(["-c", "user.name=Paint Fixture", "-c", "user.email=paint@example.invalid", "commit-tree", tree,
      "-p", remoteHead, "-m", "remote pull fixture"], remote)).trim();
    await git(["update-ref", "refs/heads/paint-topic", incoming], remote); await git(["config", "pull.ff", "only"]);
    await measure("pull", async () => { assert.equal((await new PullService(root).pullCurrent()).status, "completed"); }, () => graph.refreshAfterGraphAction(), 1);
    const fetched = (await git(["-c", "user.name=Paint Fixture", "-c", "user.email=paint@example.invalid", "commit-tree", tree,
      "-p", main, "-m", "previously unknown fetched fixture"], remote)).trim();
    await git(["update-ref", "refs/heads/fetched-new", fetched], remote);
    await measure("fetch-new-history", () => service.fetchAll(), () => graph.refreshAfterFetchAction(), 1);

    /** 새 source 이력을 fixture에서 준비하고 원래 branch로 돌아와 관측 기준선을 확정한다. */
    const source = async (name: string, file: string) => {
      const current = (await git(["branch", "--show-current"])).trim();
      await git(["switch", "-qc", name]); await writeFile(join(root, file), `${name}\n`); await git(["add", file]);
      await runGit(["commit", "-qm", name], root, { env: { GIT_AUTHOR_DATE: "1700000000 +0000", GIT_COMMITTER_DATE: "1700000000 +0000" } });
      const hash = (await git(["rev-parse", "HEAD"])).trim();
      await git(["switch", "-q", current]); await ensureFocused(); await graph.runDirectGraph("ready");
      return hash;
    };
    const cherry = await source("paint-cherry-source", "cherry-file.txt");
    await measure("cherry-pick", () => service.cherryPick(cherry), () => graph.refreshAfterGraphAction(), 1);
    await source("paint-merge-source", "merge-file.txt");
    await measure("merge", () => git(["merge", "--no-ff", "-qm", "native merge paint", "paint-merge-source"]), () => graph.refreshAfterGraphAction(), 1);
    await source("paint-squash-source", "squash-file.txt");
    await measure("branch-squash-merge", async () => { assert.equal((await new BranchOperationService(root).squashMerge("paint-squash-source")).status, "completed"); }, () => graph.refreshAfterGraphAction(), 1);
    await source("paint-rebase-target", "rebase-target.txt");
    await writeFile(join(root, "rebase-own.txt"), "own replay\n"); await git(["add", "rebase-own.txt"]); await git(["commit", "-qm", "own replay"]);
    await ensureFocused(); await graph.runDirectGraph("ready");
    await measure("rebase", async () => { assert.equal((await new BranchOperationService(root).rebaseMerge("paint-rebase-target")).status, "completed"); }, () => graph.refreshAfterGraphAction(), 1);
    const prBase = (await git(["rev-parse", "HEAD"])).trim();
    await git(["branch", "paint-pr-replay", prBase]);
    const prHead = await source("paint-pr-source", "pr-file.txt");
    const pr: PullRequestInfo = { number: 4242, title: "Native operation paint", state: "OPEN", url: "https://example.invalid/pull/4242",
      headRefName: "paint-pr-source", headHash: prHead, baseRefName: "paint-topic", baseHash: prBase, author: "fixture", isDraft: false,
      commentCount: 0, fileCount: 1, commitHashes: [prHead], commitHashesComplete: true };
    await measure("pr-squash-cherry-pick", async () => { assert.equal((await new PullRequestOperationService(root).squashCherryPick(pr)).status, "completed"); }, () => graph.refreshAfterGraphAction(), 1);
    await service.checkoutLocalBranch("paint-pr-replay"); await ensureFocused(); await graph.refreshAfterCheckoutAction();
    await measure("pr-cherry-pick", async () => { assert.equal((await new PullRequestOperationService(root).rebasePullRequest(pr)).status, "completed"); }, () => graph.refreshAfterGraphAction(), 1);
    await writeFile("/private/tmp/gsc-native-operations-72112.json", JSON.stringify({ measuredAt: new Date().toISOString(), fixture: "isolated-profile/local-bare", operations: results }, null, 2) + "\n");
  } finally { service.getCommitPage = originalPage; service.getVirtualCommits = originalStatus; }
}
