import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

/** DOM을 만들지 않고 공개 viewport helper의 geometry 접근 계약만 검증한다. */
function load(rows: any[]) {
  const window: any = {};
  vm.runInNewContext(readFileSync(resolve("media/graph/graphViewport.js"), "utf8"), { window });
  const root = { querySelectorAll: () => rows, querySelector: (selector: string) =>
    rows.find(row => selector.includes(`data-hash="${row.dataset.hash}"`)) };
  const graph = { scrollTop: 0, scrollLeft: 50, clientHeight: 900, clientWidth: 1440, scrollHeight: 200000, scrollWidth: 4000 };
  return { viewport: window.GscGraphViewport, root, graph };
}

test("known row geometry captures and restores a distant anchor without laying out unseen rows", () => {
  const rows = Array.from({ length: 5000 }, (_, index) => ({ dataset: { hash: `hash-${index}` }, style: { top: `${index * 30}px` },
    get offsetTop(): number { throw new Error("Unexpected layout top read"); },
    get offsetHeight(): number { throw new Error("Unexpected layout height read"); } }));
  const { viewport, root, graph } = load(rows); graph.scrollTop = 90005;
  const anchor = viewport.capture(graph, root, 30);
  assert.equal(anchor.hash, "hash-3000"); assert.equal(anchor.offset, -5);
  rows.forEach((row, index) => { row.style.top = `${index * 30 + 60}px`; });
  assert.equal(viewport.restore(graph, root, anchor, 30), true);
  assert.equal(graph.scrollTop, 90065); assert.equal(graph.scrollLeft, 50);
});

test("legacy callers keep Native geometry when fixed renderer coordinates were not supplied", () => {
  const rows = [{ dataset: { hash: "first" }, style: { top: "0px" }, offsetTop: 0, offsetHeight: 25 },
    { dataset: { hash: "second" }, style: { top: "5px" }, offsetTop: 120, offsetHeight: 25 }];
  const { viewport, root, graph } = load(rows); graph.scrollTop = 125;
  const anchor = viewport.capture(graph, root);
  assert.equal(anchor.hash, "second"); assert.equal(anchor.offset, -5);
  rows[1].offsetTop = 200; viewport.restore(graph, root, anchor);
  assert.equal(graph.scrollTop, 205);
});

test("an unknown inline position falls back to Native top even with a known row height", () => {
  const row = { dataset: { hash: "calculated" }, style: { top: "calc(30px + 2px)" }, offsetTop: 32,
    get offsetHeight(): number { throw new Error("Known row height should avoid a height read"); } };
  const { viewport, root, graph } = load([row]); graph.scrollTop = 35;
  const anchor = viewport.capture(graph, root, 30);
  assert.equal(anchor.offset, -3); row.offsetTop = 62;
  viewport.restore(graph, root, anchor, 30); assert.equal(graph.scrollTop, 65);
});
