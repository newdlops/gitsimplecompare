import assert from "node:assert/strict";
import test from "node:test";
import {
  SidebarModeController,
  type SidebarModeCommandExecutor,
} from "../src/ui/sidebarModeController";
import {
  SIDEBAR_MODE_STATE_KEY,
  type SidebarModeStateV1,
} from "../src/ui/sidebarModeState";

/** sidebar controller의 workspaceState 의존성을 재현하는 작은 메모리 저장소. */
class MemoryMemento {
  public readonly values = new Map<string, unknown>();
  public readonly updates: Array<[string, unknown]> = [];

  /** key가 없을 때 defaultValue를 돌려주는 Memento get 동작을 재현한다. */
  public get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
  }

  /** update 순서와 최종 값을 관찰할 수 있게 한다. */
  public async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    this.updates.push([key, value]);
  }
}

/** command 호출 순서를 기록하는 fake VS Code command API를 만든다. */
function commandRecorder(calls: unknown[][]): SidebarModeCommandExecutor {
  return {
    executeCommand: async (...args: unknown[]) => {
      calls.push(args);
      return undefined;
    },
  } as SidebarModeCommandExecutor;
}

test("sidebar mode initializes missing workspace state as Changes without focusing a view", async () => {
  const state = new MemoryMemento();
  const calls: unknown[][] = [];
  const controller = new SidebarModeController(state as never, commandRecorder(calls));

  await controller.initialize();

  assert.equal(controller.currentMode, "changes");
  assert.deepEqual(state.values.get(SIDEBAR_MODE_STATE_KEY), { version: 1, mode: "changes" });
  assert.deepEqual(calls, [["setContext", SIDEBAR_MODE_STATE_KEY, "changes"]]);
});

test("sidebar mode serializes rapid switches so the final persisted context and focus are current", async () => {
  const state = new MemoryMemento();
  const calls: unknown[][] = [];
  const controller = new SidebarModeController(state as never, commandRecorder(calls));

  await Promise.all([controller.select("reviews"), controller.select("changes")]);

  assert.deepEqual(state.updates.map(([, value]) => value), [
    { version: 1, mode: "reviews" },
    { version: 1, mode: "changes" },
  ] satisfies SidebarModeStateV1[]);
  assert.deepEqual(calls, [
    ["setContext", SIDEBAR_MODE_STATE_KEY, "reviews"],
    ["gitSimpleCompare.reviews.focus"],
    ["setContext", SIDEBAR_MODE_STATE_KEY, "changes"],
    ["gitSimpleCompare.changes.focus"],
  ]);
  assert.equal(controller.currentMode, "changes");
  assert.deepEqual(state.values.get(SIDEBAR_MODE_STATE_KEY), { version: 1, mode: "changes" });
});
