// PR-01 shared webview primitive의 versioning·stale guard·focus/window 계약을 DOM 없이 검증한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

/** 공유 browser script 하나를 VM context에 넣고 window export를 반환한다. */
function sharedModule(fileName: string): Record<string, unknown> {
  const context = { window: {} as Record<string, unknown> };
  vm.runInNewContext(readFileSync(path.join(process.cwd(), "media", "shared", fileName), "utf8"), context);
  return context.window;
}

/** live region과 focus 대상을 흉내 낼 최소 document를 만든다. */
function fakeDocument(): { document: Record<string, unknown>; nodes: Map<string, Record<string, unknown>> } {
  const nodes = new Map<string, Record<string, unknown>>();
  const document = {
    getElementById: (id: string) => nodes.get(id) || null,
    createElement: () => {
      const attributes = new Map<string, string>();
      return {
        id: "",
        className: "",
        textContent: "",
        isConnected: true,
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        getAttribute: (name: string) => attributes.get(name),
      };
    },
    body: { append: (node: Record<string, unknown>) => nodes.set(String(node.id), node) },
  };
  return { document, nodes };
}

test("request state는 최신 revision만 response callback을 적용한다", () => {
  const factory = sharedModule("requestState.js").__gscRequestState as (revision?: number) => { begin(): number; applyIfCurrent(revision: number, callback: () => void): boolean };
  const state = factory();
  const first = state.begin();
  const second = state.begin();
  let applied = 0;

  assert.equal(state.applyIfCurrent(first, () => { applied += 1; }), false);
  assert.equal(state.applyIfCurrent(second, () => { applied += 1; }), true);
  assert.equal(applied, 1);
});

test("persisted state는 older version을 migrate하고 future version을 default로 버린다", () => {
  const factory = sharedModule("persistedState.js").__gscPersistedState as (options: object) => { read(): Record<string, unknown>; write(data: Record<string, unknown>): Record<string, unknown> };
  let stored: Record<string, unknown> = { version: 1, data: { tab: "files" } };
  const state = factory({
    version: 2,
    defaults: { tab: "overview", filter: "" },
    migrate: (version: number, data: Record<string, unknown>) => version === 1 ? { ...data, filter: "" } : undefined,
    api: { getState: () => stored, setState: (next: Record<string, unknown>) => { stored = next; } },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(state.read())), { tab: "files", filter: "" });
  assert.deepEqual(JSON.parse(JSON.stringify(state.write({ filter: "fixture" }))), { tab: "overview", filter: "fixture" });
  stored = { version: 3, data: { tab: "activity" } };
  assert.deepEqual(JSON.parse(JSON.stringify(state.read())), { tab: "overview", filter: "" });
});

test("virtual list는 focused row를 visible window 밖에서도 pin한다", () => {
  const factory = sharedModule("virtualList.js").__gscVirtualList as (options: object) => { totalHeight(): number; windowFor(viewport: number, scrollTop: number, focus?: number): { start: number; end: number; pinned: number[] } };
  const list = factory({ itemCount: 200, rowHeight: 24, overscan: 2 });
  assert.equal(list.totalHeight(), 4800);
  assert.deepEqual(JSON.parse(JSON.stringify(list.windowFor(120, 1200))), { start: 48, end: 57, pinned: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(list.windowFor(120, 1200, 10))), { start: 48, end: 57, pinned: [10] });
});

test("a11y primitive는 live region과 연결된 fallback focus를 사용한다", () => {
  const context = fakeDocument();
  const window = { document: context.document, matchMedia: () => ({ matches: true }) } as Record<string, unknown>;
  vm.runInNewContext(readFileSync(path.join(process.cwd(), "media", "shared", "a11y.js"), "utf8"), { window });
  const api = window.__gscA11y as { announce(message: string, options: object): void; prefersReducedMotion(): boolean; restoreFocus(target: object, fallback: object): object };
  api.announce("Saved", { document: context.document });
  assert.equal(context.nodes.get("gsc-live-region")?.textContent, "Saved");
  assert.equal(api.prefersReducedMotion(), true);
  let focused = false;
  const fallback = { isConnected: true, focus: () => { focused = true; } };
  assert.equal(api.restoreFocus({ isConnected: false }, fallback), fallback);
  assert.equal(focused, true);
});

test("keyboard primitive는 roving tabindex와 Home·End 이동을 일관되게 적용한다", () => {
  const factory = sharedModule("keyboard.js").__gscKeyboard as {
    createRovingTabIndex(options: object): { apply(): object; handleKeydown(event: { key: string; target: object; preventDefault(): void }): boolean };
  };
  let focused = "";
  const items = ["files", "commits", "activity"].map((id) => ({
    id,
    tabIndex: -1,
    focus: () => { focused = id; },
    setAttribute: () => {},
  }));
  const roving = factory.createRovingTabIndex({ getItems: () => items, selected: true });
  roving.apply();
  let prevented = false;
  assert.equal(roving.handleKeydown({ key: "End", target: items[0], preventDefault: () => { prevented = true; } }), true);
  assert.equal(prevented, true);
  assert.equal(focused, "activity");
  assert.deepEqual(items.map((item) => item.tabIndex), [-1, -1, 0]);
});

test("splitter primitive는 허용 범위로 값과 keyboard step을 제한한다", () => {
  const api = sharedModule("splitter.js").__gscSplitter as {
    clamp(value: number, min: number, max: number): number;
    createSplitter(options: object): { getValue(): number; setValue(value: number): number };
  };
  assert.equal(api.clamp(201, 100, 200), 200);
  const splitter = api.createSplitter({ min: 100, max: 200, value: 140 });
  assert.equal(splitter.setValue(10), 100);
  assert.equal(splitter.setValue(185.6), 186);
  assert.equal(splitter.getValue(), 186);
});
