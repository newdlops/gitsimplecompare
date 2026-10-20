// 전용 Development Host의 실제 renderer ACK로 Git 작업 뒤 최신 Graph paint를 검증한다.
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import * as vscode from "vscode";
import { runGit } from "../../src/git/gitExec";
import type { GitLogService } from "../../src/git/gitLogService";
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
export async function verifyGraphOperationPaints(graph: any, service: GitLogService, paints: ReturnType<typeof operationPaintRecorder>, ensureFocused: () => Promise<void>): Promise<void> {
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
      console.log(JSON.stringify({ check: "operationGraphPaint", operation, completedToPaintMs: paint.paintedAt - completedAt,
        historyReads: pageReads - before, kind: paint.performance.kind, windowFocused: vscode.window.state.focused, focusInterruptions }));
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
  } finally { service.getCommitPage = originalPage; service.getVirtualCommits = originalStatus; }
}
