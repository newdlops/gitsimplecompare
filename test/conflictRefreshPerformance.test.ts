import assert from "node:assert/strict";
import test from "node:test";
import { takeCurrent } from "../src/commands/conflicts";
import type { ConflictsController } from "../src/providers/conflictsController";
import { isConflictMutationActive, tryAcquireConflictMutation } from "../src/git/conflictMutationCoordinator";
import { conflictOverlayInjectionExpression } from "../src/providers/nativeConflictOverlayPatch";
import type { ConflictOverlaySnapshot } from "../src/providers/conflictOverlayProtocol";
import { safetyFixture } from "./helpers/gitSafetyFixture";
import { commands } from "./helpers/vscodeMock";

/** Changes 표시가 늦어도 실제 mutation/복구 정리가 끝난 저장소는 다음 해결을 허용한다. */
test("a slow Changes refresh cannot retain the conflict mutation lease", async t => {
  const { root } = await safetyFixture(t, "conflict-ui-lease");
  let mutation = false, refreshed = false, completed = false;
  let showStarted!: () => void, finishShowing!: () => void;
  const started = new Promise<void>(resolve => { showStarted = resolve; });
  const showing = new Promise<void>(resolve => { finishShowing = resolve; });
  const service = { repoRoot: root, acceptCurrent: async () => {
    assert.equal(isConflictMutationActive(root), true); mutation = true;
  } };
  const controller = { current: service, refresh: async () => {
    assert.equal(mutation, true); assert.equal(isConflictMutationActive(root), true); refreshed = true;
  } } as unknown as ConflictsController;
  t.mock.method(commands, "executeCommand", async (id: string, options: any) => {
    if (id !== "gitSimpleCompare.refreshChanges" || options?.reason !== "conflictFileAction") return;
    assert.equal(refreshed, true); assert.equal(isConflictMutationActive(root), false);
    showStarted(); await showing;
  });
  const action = takeCurrent(controller, "tracked.txt").then(() => { completed = true; });
  try {
    await started;
    assert.equal(completed, false);
    const next = tryAcquireConflictMutation(root); assert.ok(next); next();
  } finally { finishShowing(); }
  await action;
  assert.equal(isConflictMutationActive(root), false);
});

/** 수천 CodeLens block은 host에 남기고 whole-file overlay에는 표시와 최신 action token만 전송한다. */
test("native context injection omits marker blocks while preserving immutable click tokens", () => {
  const snapshot = { uri: "conflict:file", sessionId: "session", revision: 104, editorVersion: 82,
    blocks: Array.from({ length: 10_000 }, (_, index) => ({ id: `block-${index}`, startLine: index * 5, separatorLine: index * 5 + 2, endLine: index * 5 + 4 })),
    presentation: { title: "Resolve Conflict" } } as unknown as ConflictOverlaySnapshot;
  const expression = conflictOverlayInjectionExpression("'renderer'", snapshot, { paths: ["/repo"], names: ["repo"] });
  assert.equal(expression.includes("block-9999"), false);
  assert.match(expression, /"editorVersion":82/); assert.match(expression, /"revision":104/);
  assert.ok(expression.length < JSON.stringify(snapshot).length / 20);
  assert.equal(snapshot.blocks.length, 10_000);
  assert.doesNotThrow(() => new Function(expression));
});
