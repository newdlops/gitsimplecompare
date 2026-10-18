import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import test from "node:test";

/** 실제 웹뷰 상태 모듈을 DOM 없이 실행하고 표시 색상 변경을 제어할 경계를 반환한다. */
function fixture() {
  let color = "initial";
  const window: any = { GscGraphColors: { branchColor: (name: string) => `${color}:${name}` } };
  vm.runInNewContext(readFileSync(resolve("media/graph/graphReferenceState.js"), "utf8"), { window, structuredClone });
  return { state: window.GscGraphReferenceState(), setColor: (next: string) => { color = next; } };
}

test("first empty snapshots initialize the display and subsequent identical snapshots are no-ops", () => {
  const { state } = fixture();
  assert.equal(state.setLocalBranches([]), true); assert.equal(state.setLocalBranches([]), false);
  assert.equal(state.setTagStatus([]), true); assert.equal(state.setTagStatus([]), false);
});

test("record and field reordering do not redraw unchanged branch facts but every changed field does", () => {
  const { state } = fixture();
  const first = { name: "first", current: true, hash: "a", ahead: 0, behind: 1, extra: { label: "old" } };
  const second = { name: "second", current: false, hash: "b" };
  assert.equal(state.setLocalBranches([first, second]), true);
  assert.equal(state.setLocalBranches([second, { extra: { label: "old" }, behind: 1, ahead: 0, hash: "a", current: true, name: "first" }]), false);
  for (const patch of [{ current: false }, { hash: "new" }, { ahead: 2 }, { extra: { label: "new" } }]) {
    assert.equal(state.setLocalBranches([{ ...first, ...patch }, second]), true);
    assert.equal(state.setLocalBranches([first, second]), true);
  }
  assert.equal(state.setLocalBranches([second]), true); assert.equal(state.branches.has("first"), false);
});

test("caller mutation cannot change the prior branch or nested tag comparison snapshot", () => {
  const { state } = fixture(), branch = { name: "main", current: true };
  state.setLocalBranches([branch]); branch.current = false;
  assert.equal(state.branches.get("main").current, true);
  assert.equal(state.setLocalBranches([branch]), true);
  const tag = { name: "v1", localHash: "a", remoteTargets: [{ remote: "origin", hash: "a" }] };
  state.setTagStatus([tag]); tag.remoteTargets[0].hash = "b";
  assert.equal(state.tags.get("v1").remoteTargets[0].hash, "a");
  assert.equal(state.setTagStatus([tag]), true);
  assert.equal(state.remoteTags.has("a"), false); assert.equal(state.remoteTags.get("b")[0].name, "v1");
});

test("actual palette changes invalidate identical records and clearing tags removes old remote badges", () => {
  const { state, setColor } = fixture(), branch = { name: "main" };
  state.setLocalBranches([branch]); setColor("new");
  assert.equal(state.setLocalBranches([branch]), true); assert.equal(state.colors.get("main"), "new:main");
  state.setTagStatus([{ name: "v1", remoteTargets: [{ remote: "origin", hash: "a" }] }]);
  assert.equal(state.setTagStatus([]), true); assert.equal(state.remoteTags.size, 0);
});

test("remote badge order and sparse array length remain meaningful display changes", () => {
  const { state } = fixture();
  const tags = ["first", "second"].map(name => ({ name, remoteTargets: [{ remote: "origin", hash: "a" }] }));
  state.setTagStatus(tags);
  assert.equal(state.setTagStatus([...tags].reverse()), true);
  assert.equal(state.remoteTags.get("a")[0].name, "second");
  assert.equal(state.setTagStatus([...tags].reverse()), false);
  state.setTagStatus([{ name: "sparse", remoteTargets: [] }]);
  assert.equal(state.setTagStatus([{ name: "sparse", remoteTargets: new Array(2) }]), true);
});

test("branch display changes target their names while initialization and palette changes require every row", () => {
  const { state, setColor } = fixture();
  const branches = [{ name: "main", current: true }, { name: "topic", current: false }];
  state.setLocalBranches(branches); assert.equal(state.changes, null);
  state.setLocalBranches(branches); assert.equal(state.changes.keys.size, 0);
  state.setLocalBranches([{ ...branches[0], current: false }, { ...branches[1], current: true }]);
  assert.deepEqual([...state.changes.keys].sort(), ["branch:main", "branch:topic"]);
  assert.equal(state.changes.hashes.size, 0);
  state.setLocalBranches([...branches, { name: "new", current: false }]); assert.equal(state.changes, null);
  state.setLocalBranches(branches); assert.equal(state.changes, null);
  setColor("changed"); state.setLocalBranches(branches); assert.equal(state.changes, null);
});

test("tag scopes include changed names and both previous and next remote badge locations", () => {
  const { state } = fixture();
  const tag = { name: "release/v1", localHash: "local", remoteTargets: [{ remote: "origin", hash: "old" }] };
  state.setTagStatus([tag]); assert.equal(state.changes, null);
  state.setTagStatus([{ ...tag, remoteTargets: [{ remote: "origin", hash: "new" }] }]);
  assert.deepEqual([...state.changes.keys], ["tag:release/v1"]);
  assert.deepEqual([...state.changes.hashes].sort(), ["new", "old"]);
  state.setTagStatus([]);
  assert.deepEqual([...state.changes.keys], ["tag:release/v1"]);
  assert.deepEqual([...state.changes.hashes], ["new"]);
});

test("reordering remote badges targets their shared hash even with unchanged individual tag records", () => {
  const { state } = fixture();
  const tags = ["first", "second"].map(name => ({ name, remoteTargets: [{ remote: "origin", hash: "shared" }] }));
  state.setTagStatus(tags); state.setTagStatus([...tags].reverse());
  assert.equal(state.changes.keys.size, 0);
  assert.deepEqual([...state.changes.hashes], ["shared"]);
});
