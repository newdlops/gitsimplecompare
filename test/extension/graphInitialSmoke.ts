// 실제 VS Code 웹뷰 paint 응답으로 느린 status가 첫 Graph를 막지 않는지 확인한다.
// - 격리 runner의 fixture만 사용하며 사용자 저장소·설정·기존 창에는 접근하지 않는다.
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { GitLogService } from "../../src/git/gitLogService";
import { disposeWorkingTreeSnapshots } from "../../src/git/workingTreeSnapshot";
import { GitGraphPanel } from "../../src/webview/graphPanel";
import type { FromWebviewMessage } from "../../src/webview/graphProtocol";

/** 단계 진입을 실제 웹뷰 메시지로 확인하고 정해진 상한 뒤 원인을 명확히 보고한다. */
function deferred<T>(label: string) {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  const timer = setTimeout(() => reject(new Error(`${label} did not finish within 20 seconds.`)), 20000);
  return { promise, resolve: (value: T) => { clearTimeout(timer); resolve(value); }, cancel: () => clearTimeout(timer) };
}

/**
 * 실제 Git 이력과 production renderer가 status 완료 전 paint되고 나중에 가상 행을 추가하는지 검사한다.
 * @returns 첫 paint·status hydration·공유 상태 정리를 모두 검증한 뒤 완료된다.
 */
export async function run(): Promise<void> {
  const root = process.env.GSC_EXTENSION_TEST_FIXTURE;
  assert.ok(root && vscode.workspace.workspaceFolders?.[0].uri.fsPath === root, "An isolated fixture is required.");
  const extension = vscode.extensions.getExtension("newdlops.gitsimplecompare");
  assert.ok(extension);
  const service = new GitLogService(root);
  const readStatus = service.getVirtualCommits.bind(service);
  let releaseStatus!: () => void;
  const gate = new Promise<void>(resolve => { releaseStatus = resolve; });
  let statusFinished = false, statusStarted = false;
  service.getVirtualCommits = async signal => {
    statusStarted = true;
    await gate;
    signal?.throwIfAborted();
    const result = await readStatus(signal);
    statusFinished = true;
    return result;
  };
  const initial = deferred<Extract<FromWebviewMessage, { type: "graphRendered" }>>("Initial graph paint");
  const hydrated = deferred<Extract<FromWebviewMessage, { type: "graphRendered" }>>("Working-tree graph paint");
  const ready = deferred<void>("Webview readiness");
  const openedAt = Date.now();
  GitGraphPanel.createOrShow(extension.extensionUri, service);
  const graph = (GitGraphPanel as any).current;
  assert.ok(graph);
  const handle = graph.messages.handle.bind(graph.messages);
  graph.messages.handle = (message: FromWebviewMessage) => {
    if (message.type === "graphRendered" && message.performance.kind === "initial") initial.resolve(message);
    if (message.type === "graphRendered" && message.performance.kind === "workingTree") hydrated.resolve(message);
    const result = handle(message);
    if (message.type === "ready") void Promise.resolve(result).then(() => ready.resolve());
    return result;
  };
  try {
    await ready.promise;
    // test-electron이 창을 배경에 열면 자동 remote 조회는 의도적으로 보류된다. 실제 paging/paint 경계는 그대로 검사한다.
    const backgroundPaging = !vscode.window.state.focused && !graph.commits.length && !graph.loading;
    if (backgroundPaging) await graph.loadNextPage(true);
    const paint = await initial.promise;
    assert.equal(statusStarted, true);
    assert.equal(statusFinished, false, "First paint must precede working-tree status completion.");
    assert.equal(graph.commits.length, 1);
    assert.equal(graph.loading, false);
    assert.equal(graph.workingTree.state.loading, true);
    const firstPaintMs = paint.paintedAt - paint.performance.extensionStartedAt;
    console.log(JSON.stringify({ check: "initialGraphPaint", firstPaintMs, openToPaintMs: paint.paintedAt - openedAt,
      commitCount: graph.commits.length, workingTreeStillPending: !statusFinished, backgroundPaging }));
    releaseStatus();
    const complete = await hydrated.promise;
    assert.equal(statusFinished, true);
    assert.equal(graph.commits.length, 1);
    assert.equal(graph.virtualCommits.length, 2);
    assert.equal(graph.workingTree.state, undefined);
    console.log(JSON.stringify({ check: "workingTreeHydrated", totalMs: complete.paintedAt - openedAt,
      commitCount: graph.commits.length, virtualRows: graph.virtualCommits.length }));
  } finally {
    releaseStatus(); initial.cancel(); hydrated.cancel(); ready.cancel();
    graph.dispose();
    await disposeWorkingTreeSnapshots();
  }
}
