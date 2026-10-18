import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import type { Commit } from "../src/graph/graphTypes";
import { IncrementalGraphLayout } from "../src/graph/graphIncrementalLayout";
import { layoutGraph } from "../src/graph/graphLayout";
import { GraphRenderCache } from "../src/webview/graphRenderCache";
import type { ToWebviewMessage } from "../src/webview/graphProtocol";

/** @param count topo 순서의 행 수 @returns HEAD가 첫 커밋에 있는 독립적인 선형 이력 */
function history(count: number): Commit[] {
  return Array.from({ length: count }, (_, index) => ({ hash: `commit-${index}`, parents: index + 1 < count ? [`commit-${index + 1}`] : [],
    refs: index === 0 ? ["HEAD", "main"] : index === 1 ? ["topic"] : [], subject: `Commit ${index}`,
    authorName: "Fixture", authorEmail: "fixture@example.test", dateIso: "2026-10-17T00:00:00Z" }));
}

test("a clean checkout moving only HEAD reuses the entire lane sweep and unchanged edges", t => {
  const commits = history(5000), layout = new IncrementalGraphLayout();
  const before = layout.update(commits).data, serialized = JSON.stringify(before);
  const next = structuredClone(commits); next[0].refs = ["main"]; next[1].refs = ["HEAD", "topic"];
  const start = performance.now(), result = layout.update(next);
  t.diagnostic(JSON.stringify({ rows: commits.length, calculatedRows: result.calculatedRows, reusedRows: result.reusedRows,
    elapsedMs: +(performance.now() - start).toFixed(1) }));
  assert.deepEqual(result.data, layoutGraph(next));
  assert.equal(JSON.stringify(before), serialized);
  assert.equal(result.calculatedRows, 0);
  assert.strictEqual(result.data.edges, before.edges);
  assert.strictEqual(result.data.rows[2500], before.rows[2500]);
  assert.deepEqual(result.data.rows[1].refs, ["HEAD", "topic"]);
});

test("HEAD beside a staged row still invalidates virtual incoming lane placement", () => {
  const commits = history(300), staged: Commit = { ...commits[0], hash: "staged", parents: [commits[0].hash], refs: [], kind: "staged" };
  const layout = new IncrementalGraphLayout();
  layout.update([staged, ...commits]);
  const next = structuredClone(commits); next[0].refs = ["main"]; next[1].refs = ["HEAD", "topic"];
  const result = layout.update([staged, ...next]);
  assert.deepEqual(result.data, layoutGraph([staged, ...next]));
  assert.ok(result.calculatedRows > 0);
});

test("checkout transport updates only the two HEAD rows without sending unchanged history or edges", () => {
  const commits = history(5000), cache = new GraphRenderCache(), messages: ToWebviewMessage[] = [];
  const state = { loadedCount: commits.length, loading: false, hasMore: false, reset: true };
  cache.publish({ commits, virtualCommits: [], compact: false, kind: "initial", state }, message => messages.push(message));
  const next = structuredClone(commits); next[0].refs = ["main"]; next[1].refs = ["HEAD", "topic"];
  cache.publish({ commits: next, virtualCommits: [], compact: false, kind: "checkout", state: { ...state, reset: false } }, message => messages.push(message));
  const message = messages[1]; assert.equal(message.type, "graphDelta");
  if (message.type !== "graphDelta") return;
  assert.deepEqual(message.delta.rowUpdates.map(item => item.index), [0, 1]);
  assert.equal(message.delta.rows.length, 0); assert.equal(message.delta.edges.length, 0); assert.equal(message.delta.edgeUpdates.length, 0);
});
