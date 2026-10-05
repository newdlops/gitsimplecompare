import assert from "node:assert/strict";
import test from "node:test";
import { IncrementalGraphLayout } from "../src/graph/graphIncrementalLayout";
import { layoutGraph } from "../src/graph/graphLayout";
import type { Commit, GraphData } from "../src/graph/graphTypes";
import { layoutGraphData } from "../src/webview/graphLayoutData";
import { GraphRenderCache } from "../src/webview/graphRenderCache";
import type { GraphRenderRequest } from "../src/webview/graphPanelRendering";
import type { ToWebviewMessage } from "../src/webview/graphProtocol";

/** 실제 topo 순서의 선형 이력과 페이지 밖의 merge 부모를 포함한 DAG를 만든다. */
function history(count: number, merges = false): Commit[] {
  return Array.from({ length: count }, (_, i) => ({ hash: `c${i}`,
    parents: i === count - 1 ? [] : [`c${i + 1}`, ...(merges && i % 37 === 0 && i + 83 < count ? [`c${i + 83}`] : [])],
    authorName: "Author", authorEmail: "a@example.test", dateIso: "2026-01-01T00:00:00Z",
    refs: i === 0 ? ["HEAD", "main"] : [], subject: `Commit ${i}` }));
}

test("append checkpoints preserve every row and edge while calculating only the new suffix", () => {
  const input = history(4096), incremental = new IncrementalGraphLayout();
  let previous: GraphData | undefined;
  for (const length of [512, 1024, 1536, 2048, 4096]) {
    const before = previous && JSON.stringify(previous);
    const actual = incremental.update(input.slice(0, length));
    assert.deepEqual(actual.data, layoutGraph(input.slice(0, length)));
    if (previous) {
      assert.equal(JSON.stringify(previous), before, "a posted snapshot must remain immutable");
      assert.ok(actual.calculatedRows <= length - previous.rows.length + 128);
      assert.strictEqual(actual.data.rows[0], previous.rows[0], "unchanged text rows retain identity");
    }
    previous = actual.data;
  }
  const unchanged = incremental.update(structuredClone(input));
  assert.equal(unchanged.calculatedRows, 0);
  assert.strictEqual(unchanged.data.rows[2000], previous!.rows[2000]);
});

test("newly visible secondary merge parents, octopus merges and dense lanes match a full layout", () => {
  const input = history(800, true);
  input[280].parents.push("c450", "c510", "c780");
  const incremental = new IncrementalGraphLayout();
  for (const length of [64, 129, 250, 281, 451, 600, 800]) {
    assert.deepEqual(incremental.update(input.slice(0, length)).data, layoutGraph(input.slice(0, length)));
  }
});

test("metadata refresh, HEAD moves, reorder, shrinking history and virtual rows retain canonical output", () => {
  const original = history(700), incremental = new IncrementalGraphLayout();
  const before = incremental.update(original).data;
  const metadata = structuredClone(original);
  metadata[400].subject = "edited title"; metadata[400].refs = ["tag: v1"];
  metadata[400].localOnlyBranches = ["feature"];
  const updated = incremental.update(metadata);
  assert.equal(updated.calculatedRows, 0);
  assert.strictEqual(before.rows[399], updated.data.rows[399]);
  assert.notStrictEqual(before.rows[400], updated.data.rows[400]);
  assert.equal(before.rows[400].subject, "Commit 400");
  const virtual: Commit = { ...original[0], hash: "working", parents: [original[200].hash], refs: [], kind: "ongoing" };
  for (const input of [metadata.slice(0, 530), [virtual, ...metadata], metadata.slice(10), original]) {
    assert.deepEqual(incremental.update(input).data, layoutGraph(input));
  }
  incremental.clear();
  assert.deepEqual(incremental.update(original).data, layoutGraph(original));
});

/** host protocol를 소비자처럼 누적해 증분 transport로 빠진 데이터가 없는지 확인한다. */
function consume(message: ToWebviewMessage, previous?: GraphData): GraphData {
  if (message.type === "graph") return structuredClone(message.data);
  assert.equal(message.type, "graphDelta");
  if (message.type !== "graphDelta" || !previous) throw new Error("Missing graph base");
  const d = message.delta;
  assert.equal(previous.rows.length, d.rowStart); assert.equal(previous.edges.length, d.edgeStart);
  const data = { rows: [...previous.rows, ...d.rows], edges: [...previous.edges, ...d.edges], laneCount: d.laneCount };
  for (const { index, row } of d.rowUpdates) data.rows[index] = row;
  for (const { index, edge } of d.edgeUpdates) data.edges[index] = edge;
  return structuredClone(data);
}

/** transport 테스트의 상태는 실제 panel의 append/reset 조건과 같은 필드로 구성한다. */
function request(commits: Commit[], reset = false, compact = false): GraphRenderRequest {
  return { commits, virtualCommits: [], compact, kind: reset ? "initial" : "pagination",
    state: { reset, loading: false, hasMore: true, loadedCount: commits.length } };
}

test("append sends only new rows and changed dangling edges; resync needs no repository read", () => {
  const input = history(4200), cache = new GraphRenderCache();
  const messages: ToWebviewMessage[] = [];
  cache.publish(request(input.slice(0, 4000), true), message => messages.push(message));
  let model = consume(messages[0]);
  cache.publish(request(input), message => messages.push(message));
  const next = messages[1]; assert.equal(next.type, "graphDelta");
  if (next.type !== "graphDelta") return;
  assert.equal(next.delta.rows.length, 200); assert.equal(next.delta.rowUpdates.length, 0);
  assert.ok(JSON.stringify(next).length < JSON.stringify({ type: "graph", data: layoutGraph(input) }).length / 8);
  model = consume(next, model); assert.deepEqual(model, layoutGraph(input));
  cache.resetTransport(); cache.publish(request(input), message => messages.push(message));
  assert.equal(messages[2].type, "graph"); assert.deepEqual(consume(messages[2]), model);
});

test("compact toggles and virtual HEAD placement reconstruct exact complete layout data", () => {
  const input = history(900, true);
  input[0].parents = Array.from({ length: 24 }, (_, i) => `c${100 + i * 20}`);
  const virtual = { ...input[0], hash: "__gsc_virtual_staged__", parents: [input[0].hash], refs: [], kind: "staged" as const };
  const cache = new GraphRenderCache(); let model: GraphData | undefined;
  for (const compact of [false, true, false, true]) {
    const req = { ...request(input, !model, compact), virtualCommits: [virtual] };
    cache.publish(req, message => { model = consume(message, model); });
    assert.deepEqual(model, layoutGraphData(input, [virtual], compact));
  }
});
