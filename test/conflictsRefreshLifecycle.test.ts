import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ConflictService, type MergeOperation } from "../src/git/conflictService";
import { PullService } from "../src/git/pullService";
import type { GitServiceRegistry } from "../src/git/serviceRegistry";
import { ConflictsController, type ConflictsRefreshSnapshot } from "../src/providers/conflictsController";
import type { ConflictsTreeProvider } from "../src/providers/conflictsTreeProvider";
import * as vscode from "./helpers/vscodeMock";

/**
 * 읽기/컨텍스트 적용 완료를 테스트가 직접 제어한다.
 * @returns 순서 경합을 만들 Promise와 성공/실패 완료 함수
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

/** 현재 event loop에서 시작한 비동기 요청만 진행해 wall-clock 대기 없이 상태를 검사한다. */
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * 공유 VS Code 대역의 속성을 테스트 동안만 교체한다.
 * @param t 원래 속성의 복원을 등록할 테스트
 * @param target 속성을 교체할 window/workspace 객체
 * @param key 테스트에 필요한 API 속성명
 * @param value 해당 테스트에서 사용할 값
 */
function install(t: TestContext, target: object, key: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  });
}

/**
 * 실제 ConflictsController를 서비스/API 경계 대역과 연결한다.
 * - 조회 결과, 트리 적용, context 적용, 구독자 알림을 따로 기록한다.
 * - service를 읽기 완료 전에 공개하거나 오래된 결과를 게시하는 오류도 관찰한다.
 * @param t 대역과 controller 수명을 정리할 테스트
 * @returns 조회 결과를 제어하는 상태와 실제 controller
 */
function fixture(t: TestContext) {
  const state = {
    root: "/repo/a" as string | undefined,
    operation: "rebase" as MergeOperation,
    resolves: 0,
    reads: [] as string[],
    trees: [] as Array<{ root: string; conflicts: string[] }>,
    notifications: [] as ConflictsRefreshSnapshot[],
    contexts: [] as unknown[][],
    list: async (_root: string): Promise<string[]> => ["conflict.txt"],
    setContext: async (_key: string, _value: boolean): Promise<void> => {},
    notify: (_snapshot: ConflictsRefreshSnapshot): void => {},
  };
  install(t, vscode.window, "activeTextEditor", { document: { uri: vscode.Uri.file("/repo/active.txt") } });
  install(t, vscode.workspace, "workspaceFolders", []);
  t.mock.method(ConflictService.prototype, "listConflicts", async function () {
    state.reads.push(this.repoRoot);
    return state.list(this.repoRoot);
  });
  t.mock.method(ConflictService.prototype, "getOperation", async () => state.operation);
  t.mock.method(PullService.prototype, "findLatestPullRollbackSnapshot", async () => undefined);
  t.mock.method(vscode.commands, "executeCommand", async (id: string, ...args: unknown[]) => {
    assert.equal(id, "setContext");
    state.contexts.push(args);
    return state.setContext(String(args[0]), Boolean(args[1]));
  });
  t.mock.method(vscode.EventEmitter.prototype, "fire", (snapshot: ConflictsRefreshSnapshot) => {
    state.notifications.push(snapshot);
    state.notify(snapshot);
  });
  const registry = {
    resolve: async () => {
      state.resolves++;
      return state.root ? { repoRoot: state.root } : undefined;
    },
  } as unknown as GitServiceRegistry;
  const provider = {
    setState(root: string, conflicts: string[]) { state.trees.push({ root, conflicts: [...conflicts] }); },
  } as unknown as ConflictsTreeProvider;
  const controller = new ConflictsController(registry, provider);
  t.after(() => controller.dispose());
  return { state, controller };
}

test("all callers in a refresh burst wait for the latest state and obsolete results stay unpublished", async t => {
  const { state, controller } = fixture(t);
  const old = deferred<string[]>();
  const latest = deferred<string[]>();
  state.list = async () => state.reads.length === 1 ? old.promise : latest.promise;
  const first = controller.refresh();
  await settle();
  const burst = Array.from({ length: 30 }, () => controller.refresh());
  let finished = false;
  void Promise.all(burst).then(() => { finished = true; });
  await settle();
  assert.equal(finished, false, "A coalesced caller must await the shared refresh");
  old.resolve(["old.txt"]);
  await settle();
  assert.equal(state.reads.length, 2);
  assert.equal(state.trees.length, 0, "Superseded conflict lists must not flash on screen");
  latest.resolve(["latest.txt"]);
  await Promise.all([first, ...burst]);
  assert.equal(finished, true);
  assert.deepEqual(state.trees, [{ root: "/repo/a", conflicts: ["latest.txt"] }]);
  assert.deepEqual(state.notifications.map(value => value.conflicts), [["latest.txt"]]);
});

test("switching repositories during a read publishes only the new repository service and state", async t => {
  const { state, controller } = fixture(t);
  const pending = deferred<string[]>();
  state.list = async root => root === "/repo/a" ? pending.promise : ["b.txt"];
  const first = controller.refresh();
  await settle();
  assert.equal(controller.current, undefined, "An unfinished read must not become the command target");
  state.root = "/repo/b";
  const second = controller.refresh();
  pending.resolve(["a.txt"]);
  await Promise.all([first, second]);
  assert.equal(controller.current?.repoRoot, "/repo/b");
  assert.deepEqual(state.trees, [{ root: "/repo/b", conflicts: ["b.txt"] }]);
});

test("a failed obsolete lookup still drains the queued latest refresh", async t => {
  const { state, controller } = fixture(t);
  const old = deferred<string[]>();
  state.list = async () => state.reads.length === 1 ? old.promise : ["recovered.txt"];
  const first = controller.refresh();
  const firstOutcome = first.then(() => undefined, error => error);
  await settle();
  const next = controller.refresh();
  old.reject(new Error("old repository disappeared"));
  await next;
  assert.equal(await firstOutcome, undefined);
  assert.equal(state.reads.length, 2);
  assert.deepEqual(state.trees, [{ root: "/repo/a", conflicts: ["recovered.txt"] }]);
});

test("a current lookup failure keeps the last complete state and a later refresh can recover", async t => {
  const { state, controller } = fixture(t);
  await controller.refresh();
  const originalService = controller.current;
  state.root = "/repo/b";
  state.list = async () => { throw new Error("index temporarily unavailable"); };
  await assert.rejects(controller.refresh(), /index temporarily unavailable/);
  assert.equal(controller.current, originalService);
  assert.equal(controller.currentOperation, "rebase");
  assert.equal(state.trees.length, 1);
  state.operation = "merge";
  state.list = async () => ["b.txt"];
  await controller.refresh();
  assert.equal(controller.current?.repoRoot, "/repo/b");
  assert.equal(controller.currentOperation, "merge");
});

test("dispose discards pending reads and prevents new refresh work", async t => {
  const { state, controller } = fixture(t);
  const pending = deferred<string[]>();
  state.list = async () => pending.promise;
  const first = controller.refresh();
  await settle();
  controller.dispose();
  pending.resolve(["stale.txt"]);
  await first;
  await controller.refresh();
  assert.equal(state.reads.length, 1);
  assert.equal(state.trees.length, 0);
  assert.equal(state.contexts.length, 0);
  assert.equal(state.notifications.length, 0);
});

test("identical lists avoid tree and context churn while still notifying content subscribers", async t => {
  const { state, controller } = fixture(t);
  await controller.refresh();
  const originalService = controller.current;
  await controller.refresh();
  assert.equal(state.reads.length, 2, "Changed index stages must still be inspected");
  assert.equal(state.notifications.length, 2, "Same paths may have different conflict blobs");
  assert.equal(state.trees.length, 1);
  assert.equal(state.contexts.length, 4);
  assert.equal(controller.current, originalService, "Reuse the same repository service");
});

test("refresh completion and subscriber notification wait for context commands", async t => {
  const { state, controller } = fixture(t);
  const context = deferred<void>();
  state.setContext = () => context.promise;
  let finished = false;
  const refresh = controller.refresh().then(() => { finished = true; });
  await settle();
  assert.equal(state.contexts.length, 4);
  assert.equal(finished, false);
  assert.equal(state.notifications.length, 0);
  context.resolve();
  await refresh;
  assert.equal(finished, true);
  assert.equal(state.notifications.length, 1);
});

test("leaving the repository clears state once and does not keep old conflict commands enabled", async t => {
  const { state, controller } = fixture(t);
  await controller.refresh();
  state.root = undefined;
  await controller.refresh();
  assert.equal(controller.current, undefined);
  assert.equal(controller.currentOperation, "none");
  assert.deepEqual(state.trees.at(-1), { root: "", conflicts: [] });
  assert.ok(state.contexts.slice(-4).every(([, value]) => value === false));
  const treeCount = state.trees.length;
  const contextCount = state.contexts.length;
  await controller.refresh();
  assert.equal(state.trees.length, treeCount);
  assert.equal(state.contexts.length, contextCount);
});

test("a changed conflict list with the same count still updates the tree", async t => {
  const { state, controller } = fixture(t);
  await controller.refresh();
  state.list = async () => ["renamed.txt"];
  await controller.refresh();
  assert.deepEqual(state.trees.at(-1), { root: "/repo/a", conflicts: ["renamed.txt"] });
  assert.equal(state.contexts.length, 4, "Context booleans did not change");
});

test("a superseded context update is restored even when the latest tree matches the original", async t => {
  const { state, controller } = fixture(t);
  await controller.refresh();
  const originalContexts = state.contexts.slice();
  const context = deferred<void>();
  state.root = undefined;
  state.setContext = () => context.promise;
  const obsolete = controller.refresh();
  await settle();
  assert.ok(state.contexts.slice(-4).every(([, value]) => value === false));
  state.root = "/repo/a";
  state.setContext = async () => {};
  const latest = controller.refresh();
  context.resolve();
  await Promise.all([obsolete, latest]);
  assert.deepEqual(state.contexts.slice(-4), originalContexts);
  assert.equal(state.trees.length, 1, "The obsolete empty tree must never be published");
  assert.equal(state.notifications.length, 2);
  assert.equal(controller.current?.repoRoot, "/repo/a");
});

test("a partial context failure settles every command before failing and retry restores all keys", async t => {
  const { state, controller } = fixture(t);
  await controller.refresh();
  const originalService = controller.current;
  const originalContexts = state.contexts.slice();
  const context = deferred<void>();
  state.root = undefined;
  state.setContext = async key => {
    if (key.endsWith(".hasConflicts")) throw new Error("context temporarily unavailable");
    await context.promise;
  };
  let finished = false;
  const failed = controller.refresh();
  void failed.then(() => { finished = true; }, () => { finished = true; });
  await settle();
  assert.equal(finished, false, "Unfinished old commands must not run after a new refresh");
  assert.equal(controller.current, originalService);
  context.resolve();
  await assert.rejects(failed, /context temporarily unavailable/);
  assert.equal(state.trees.length, 1);
  state.root = "/repo/a";
  state.setContext = async () => {};
  await controller.refresh();
  assert.deepEqual(state.contexts.slice(-4), originalContexts);
  assert.equal(state.contexts.length, 12, "A partial failure invalidates the complete context cache");
  assert.equal(state.trees.length, 1);
  assert.equal(state.notifications.length, 2);
});

test("a subscriber refresh at publication is drained before the shared promise completes", async t => {
  const { state, controller } = fixture(t);
  let followup: Promise<void> | undefined;
  state.notify = () => {
    if (state.notifications.length !== 1) return;
    state.list = async () => ["next-conflict.txt"];
    followup = controller.refresh();
  };
  const first = controller.refresh();
  await first;
  assert.equal(followup, first);
  assert.equal(state.reads.length, 2);
  assert.deepEqual(state.trees.at(-1), { root: "/repo/a", conflicts: ["next-conflict.txt"] });
  assert.equal(state.notifications.length, 2);
});
