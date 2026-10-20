// 실제 VS Code 웹뷰 paint 응답으로 느린 status가 첫 Graph를 막지 않는지 확인한다.
// - 격리 runner의 fixture만 사용하며 사용자 저장소·설정·기존 창에는 접근하지 않는다.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import * as vscode from "vscode";
import { GitLogService } from "../../src/git/gitLogService";
import { disposeWorkingTreeSnapshots } from "../../src/git/workingTreeSnapshot";
import { GitGraphPanel } from "../../src/webview/graphPanel";
import type { FromWebviewMessage } from "../../src/webview/graphProtocol";
import { operationPaintRecorder, verifyGraphOperationPaints } from "./graphOperationPaint";
import { IsolatedTestWindow } from "../helpers/isolatedTestWindow";

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
  const ownedWindow = new IsolatedTestWindow(Number(process.env.GSC_TEST_MAIN_INSPECTOR_PORT), process.env.GSC_EXTENSION_TEST_PROFILE!);
  await ownedWindow.connect();
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, "sample.txt"));
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
  /** macOS의 앱 활성화 직후 다른 focus 이벤트가 도착해도 검증한 전용 창만 재요청한다. */
  const ensureFocused = async () => {
    const deadline = Date.now() + 15000;
    while (!vscode.window.state.focused && Date.now() < deadline) { await ownedWindow.focus(); await new Promise(resolve => setTimeout(resolve, 250)); }
    assert.equal(vscode.window.state.focused, true, "Only the isolated test window must be focused before measuring.");
  };
  await ensureFocused();
  /** renderer 대기 중 발생한 실제 focus 해제는 전용 창만 복구하고 원래 paint promise를 계속 기다린다. */
  const focusedPaint = async <T>(promise: Promise<T>): Promise<T> => {
    let settled = false;
    void promise.then(() => { settled = true; }, () => { settled = true; });
    while (!settled) { await ensureFocused(); if (!settled) await new Promise(resolve => setTimeout(resolve, 25)); }
    return promise;
  };
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
  const operationPaints = operationPaintRecorder();
  GitGraphPanel.createOrShow(extension.extensionUri, service);
  const graph = (GitGraphPanel as any).current;
  assert.ok(graph);
  const handle = graph.messages.handle.bind(graph.messages);
  graph.messages.handle = (message: FromWebviewMessage) => {
    operationPaints.observe(message);
    if (message.type === "graphRendered" && message.performance.kind === "initial") initial.resolve(message);
    if (message.type === "graphRendered" && message.performance.kind === "workingTree") hydrated.resolve(message);
    const result = handle(message);
    if (message.type === "ready") void Promise.resolve(result).then(() => ready.resolve());
    return result;
  };
  try {
    await focusedPaint(ready.promise);
    // test-electron이 창을 배경에 열면 자동 remote 조회는 의도적으로 보류된다. 실제 paging/paint 경계는 그대로 검사한다.
    const backgroundPaging = !vscode.window.state.focused && !graph.commits.length && !graph.loading;
    if (backgroundPaging) await graph.loadNextPage(true);
    const paint = await focusedPaint(initial.promise);
    assert.equal(statusStarted, true);
    assert.equal(statusFinished, false, "First paint must precede working-tree status completion.");
    assert.equal(graph.commits.length, 1);
    assert.equal(graph.loading, false);
    assert.equal(graph.workingTree.state.loading, true);
    const firstPaintMs = paint.paintedAt - paint.performance.extensionStartedAt;
    console.log(JSON.stringify({ check: "initialGraphPaint", firstPaintMs, openToPaintMs: paint.paintedAt - openedAt,
      commitCount: graph.commits.length, workingTreeStillPending: !statusFinished, backgroundPaging }));
    releaseStatus();
    const complete = await focusedPaint(hydrated.promise);
    assert.equal(statusFinished, true);
    assert.equal(graph.commits.length, 1);
    assert.equal(graph.virtualCommits.length, 2);
    assert.equal(graph.workingTree.state, undefined);
    console.log(JSON.stringify({ check: "workingTreeHydrated", totalMs: complete.paintedAt - openedAt,
      commitCount: graph.commits.length, virtualRows: graph.virtualCommits.length }));
    await verifyGraphOperationPaints(graph, service, operationPaints, ensureFocused);
    await writeFile("/private/tmp/gsc-operation-native-final.png", await ownedWindow.screenshot());
  } finally {
    releaseStatus(); initial.cancel(); hydrated.cancel(); ready.cancel(); operationPaints.dispose();
    graph.dispose();
    ownedWindow.close();
    await disposeWorkingTreeSnapshots();
  }
}
