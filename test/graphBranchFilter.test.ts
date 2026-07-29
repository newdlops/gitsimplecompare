import assert from "node:assert/strict";
import test from "node:test";
import { parseRemoteBranches } from "../src/git/graphBranchCatalog";
import {
  buildBranchFilterSnapshot,
  normalizeBranchFilterState,
  resolveBranchFilter,
} from "../src/webview/graphBranchFilter";

test("pending all filter reads only known local refs and ready restores all semantics", () => {
  const refs = [{ name: "main", kind: "local" as const }, { name: "origin/main", kind: "remote" as const }];
  const state = normalizeBranchFilterState("all");
  assert.deepEqual(resolveBranchFilter(state, refs, "pending").refs, ["main"]);
  assert.deepEqual(resolveBranchFilter(state, refs, "ready").refs, []);
});

test("custom hidden remote selection survives pending snapshot and activates after hydration", () => {
  const state = normalizeBranchFilterState("custom", ["origin/feature"]);
  const pending = buildBranchFilterSnapshot([{ name: "main", kind: "local" }], [], state, "pending");
  assert.deepEqual(pending.selected, ["origin/feature"]);
  const ready = resolveBranchFilter(state, [{ name: "main", kind: "local" }, { name: "origin/feature", kind: "remote" }], "ready");
  assert.deepEqual(ready.refs, ["origin/feature"]);
});

test("remote catalog parser excludes symbolic remote HEAD refs", () => {
  assert.deepEqual(parseRemoteBranches("origin/HEAD\x1frefs/remotes/origin/HEAD\norigin/main\x1frefs/remotes/origin/main\n"), [{ name: "origin/main", kind: "remote" }]);
});
