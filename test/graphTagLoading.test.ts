import assert from "node:assert/strict";
import test from "node:test";
import { GraphTagStatusLoading } from "../src/webview/graphTagStatus";
import { GitTagService } from "../src/git/gitTagService";
import { GitLogService } from "../src/git/gitLogService";
import { createOperationGraphPanel } from "./helpers/graphOperationPanel";

/** timer 지연 없이 조회와 취소 listener를 진행시킨다. */
async function settle(): Promise<void> { for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setImmediate(resolve)); }

test("superseded tag requests wait for close, skip queued generations and publish only the latest repository", async () => {
  const requests: { root: string; signal: AbortSignal; force?: boolean }[] = [], posts: string[] = [];
  let close!: () => void;
  const stopped = new Promise<void>(resolve => { close = resolve; });
  const loading = new GraphTagStatusLoading(async (root, options) => {
    requests.push({ root, signal: options.signal!, force: options.forceRemote });
    if (root === "/old") await stopped;
    return [{ name: root, remoteTargets: [] }];
  });
  const old = loading.start("/old", () => posts.push("old")); await settle();
  const queued = Array.from({ length: 20 }, (_, i) => loading.start(`/queued-${i}`, () => posts.push("queued")));
  const latest = loading.start("/latest", () => posts.push("latest"), { forceRemote: true });
  await settle(); assert.equal(requests.length, 1); assert.equal(requests[0].signal.aborted, true);
  close(); await Promise.all([old, ...queued, latest]);
  assert.deepEqual(requests.map(read => read.root), ["/old", "/latest"]);
  assert.equal(requests[1].signal.aborted, false); assert.equal(requests[1].force, true);
  assert.deepEqual(posts, ["latest"]);
});

for (const reason of ["hidden", "windowUnfocused", "repositoryChanged", "dispose", "branchFilter", "commitWindow"] as const) {
  test(`actual Graph panel ${reason} cancels tag work without a late publication`, async t => {
    let signal!: AbortSignal;
    t.mock.method(GitTagService.prototype, "getTagStatuses", async (options: { signal: AbortSignal }) => {
      signal = options.signal;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return [{ name: "late", remoteTargets: [] }];
    });
    const { panel, surface, messages } = createOperationGraphPanel(t, new GitLogService("/tag-panel"));
    t.after(() => panel.dispose());
    const pending = panel.tagLoading.start("/tag-panel", (message: any) => messages.push(message));
    await settle(); assert.equal(signal.aborted, false);
    if (reason === "hidden") { surface.visible = false; panel.handleViewStateChange({ webviewPanel: surface }); }
    else if (reason === "windowUnfocused") panel.handleWindowFocusChange(false);
    else if (reason === "repositoryChanged") panel.refreshCoordinator.setRepository("/tag-other");
    else if (reason === "dispose") panel.dispose();
    else if (reason === "branchFilter") panel.resetLoadedGraph();
    else await panel.showCommitWindow("commitWindow", async () => undefined);
    assert.equal(signal.aborted, true); await pending;
    assert.equal(messages.filter(message => message.type === "tagStatus").length, 0);
  });
}

test("tag failures settle without publishing an empty replacement or poisoning the next request", async () => {
  let calls = 0; const posts: unknown[] = [];
  const loading = new GraphTagStatusLoading(async () => {
    if (++calls === 1) throw new Error("read failed");
    return [{ name: "recovered", remoteTargets: [] }];
  });
  await loading.start("/fixture", message => posts.push(message)); assert.equal(posts.length, 0);
  await loading.start("/fixture", message => posts.push(message)); assert.equal(posts.length, 1);
});

for (const reason of ["hidden", "windowUnfocused"] as const) {
  test(`a loaded Graph resumes cancelled tag work once after ${reason} without reloading history`, async t => {
    let calls = 0; const signals: AbortSignal[] = [];
    t.mock.method(GitTagService.prototype, "getTagStatuses", async (options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      if (++calls === 1) await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
      return [{ name: calls === 1 ? "old" : "latest", remoteTargets: [] }];
    });
    const { panel, surface, messages } = createOperationGraphPanel(t, new GitLogService("/tag-resume"));
    t.after(() => panel.dispose()); panel.commits = [{ hash: "loaded" }];
    t.mock.method(panel.messages, "synchronizeRebaseSession", async () => undefined);
    t.mock.method(panel.workingTree, "resume", () => undefined);
    t.mock.method(panel, "resumeBranchLoading", () => { throw new Error("Tag resume must not reload history"); });
    const first = panel.tagLoading.start("/tag-resume", (message: any) => messages.push(message)); await settle();
    if (reason === "hidden") { surface.visible = false; panel.handleViewStateChange({ webviewPanel: surface }); }
    else panel.handleWindowFocusChange(false);
    await first;
    if (reason === "hidden") { surface.visible = true; panel.handleViewStateChange({ webviewPanel: surface }); }
    else panel.handleWindowFocusChange(true);
    await settle();
    assert.equal(calls, 2); assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
    assert.deepEqual(messages.filter(message => message.type === "tagStatus").map((message: any) => message.tags[0].name), ["latest"]);
    if (reason === "hidden") panel.handleViewStateChange({ webviewPanel: surface }); else panel.handleWindowFocusChange(true);
    await settle(); assert.equal(calls, 2, "completed tag work must not repeat on another reveal");
  });
}

for (const reason of ["dispose", "repositoryChanged"] as const) {
  test(`${reason} discards a previously paused tag intent`, async () => {
    let calls = 0;
    const loading = new GraphTagStatusLoading(async (_root, options) => {
      calls++; await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true })); return [];
    });
    const first = loading.start("/original", () => {}); await settle();
    loading.cancel("hidden"); await first; loading.cancel(reason);
    assert.equal(loading.resume("/original", () => {}), false); assert.equal(calls, 1);
  });
}

test("a paused tag read never carries an old empty-tag proof into its resumed read",async()=>{
  const hints:Array<true|undefined>=[];
  const loading=new GraphTagStatusLoading(async(_root,options)=>{
    hints.push(options.localTagsAbsent);
    if(hints.length===1)await new Promise<void>(resolve=>options.signal!.addEventListener("abort",()=>resolve(),{once:true}));
    return [];
  });
  const first=loading.start("/snapshot",()=>{}, {localTagsAbsent:true});await settle();
  loading.cancel("hidden");await first;
  assert.equal(loading.resume("/snapshot",()=>{}),true);await settle();
  assert.deepEqual(hints,[true,undefined]);
});
