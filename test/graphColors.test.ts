// Graph 웹뷰의 커밋 색상 고정 계약을 DOM 없이 검증한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

interface GraphColorRow {
  hash: string;
  kind?: "commit" | "ongoing" | "staged";
}

interface GraphColorsApi {
  beginStableColorFrame(scope?: string, rows?: GraphColorRow[]): void;
  stableRowColor(row: GraphColorRow, suggestedColor: string, semanticColor?: boolean): string;
}

/** 실제 graphColors browser script를 격리된 VM에서 실행해 공개 API를 반환한다. */
function loadGraphColors(): GraphColorsApi {
  const context = { window: {} as Record<string, unknown> };
  vm.runInNewContext(
    readFileSync(path.join(process.cwd(), "media", "graph", "graphColors.js"), "utf8"),
    context
  );
  return context.window.GscGraphColors as GraphColorsApi;
}

test("같은 커밋은 GraphData의 레인 색상이 바뀌어도 처음 색상을 유지한다", () => {
  const colors = loadGraphColors();
  colors.beginStableColorFrame("/repo");
  const row = { hash: "commit-a" };

  assert.equal(colors.stableRowColor(row, "#111111"), "#111111");
  assert.equal(colors.stableRowColor({ ...row }, "#222222"), "#111111");
});

test("브랜치 의미 색상은 일반 색상을 한 번만 승격하고 이후에는 고정한다", () => {
  const colors = loadGraphColors();
  colors.beginStableColorFrame("/repo");
  const row = { hash: "commit-a" };

  assert.equal(colors.stableRowColor(row, "#111111"), "#111111");
  assert.equal(colors.stableRowColor({ ...row }, "#33aa66", true), "#33aa66");
  assert.equal(colors.stableRowColor({ ...row }, "#ff00ff", true), "#33aa66");
  assert.equal(colors.stableRowColor({ ...row }, "#222222"), "#33aa66");
});

test("staged와 ongoing 가상 커밋은 현재 레인색을 따라 캐시하지 않는다", () => {
  const colors = loadGraphColors();
  colors.beginStableColorFrame("/repo");

  assert.equal(
    colors.stableRowColor({ hash: "__gsc_virtual_staged__", kind: "staged" }, "#111111"),
    "#111111"
  );
  assert.equal(
    colors.stableRowColor({ hash: "__gsc_virtual_staged__", kind: "staged" }, "#222222"),
    "#222222"
  );
});

test("저장소 색상 범위가 바뀌면 이전 저장소의 고정 색상을 비운다", () => {
  const colors = loadGraphColors();
  const row = { hash: "same-hash" };
  colors.beginStableColorFrame("/repo-a");
  assert.equal(colors.stableRowColor(row, "#111111"), "#111111");

  colors.beginStableColorFrame("/repo-b");
  assert.equal(colors.stableRowColor({ ...row }, "#222222"), "#222222");
});

test("같은 저장소라도 겹치지 않는 커밋 창은 제한 캐시를 새 화면에 양보한다", () => {
  const colors = loadGraphColors();
  colors.beginStableColorFrame("/repo", [{ hash: "commit-a" }]);
  assert.equal(colors.stableRowColor({ hash: "commit-a" }, "#111111"), "#111111");

  colors.beginStableColorFrame("/repo", [{ hash: "commit-b" }]);
  assert.equal(colors.stableRowColor({ hash: "commit-a" }, "#222222"), "#222222");
  assert.equal(colors.stableRowColor({ hash: "commit-b" }, "#333333"), "#333333");
});

test("고정 색상 캐시는 상한 뒤 새 커밋을 저장하지 않는다", () => {
  const colors = loadGraphColors();
  colors.beginStableColorFrame("/repo");
  for (let index = 0; index < 1024; index++) {
    colors.stableRowColor({ hash: `commit-${index}` }, "#111111");
  }

  assert.equal(colors.stableRowColor({ hash: "overflow" }, "#222222"), "#222222");
  assert.equal(colors.stableRowColor({ hash: "overflow" }, "#333333"), "#333333");
  assert.equal(colors.stableRowColor({ hash: "commit-0" }, "#444444"), "#111111");
});
