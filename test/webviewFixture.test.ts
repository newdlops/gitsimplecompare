import assert from "node:assert/strict";
import test from "node:test";
import { loadWebviewFixture, parseWebviewFixture } from "./helpers/webviewFixture";

test("Changes와 staged Preview fixture를 읽는다", async () => {
  assert.equal((await loadWebviewFixture("changes.small.en.json")).surface, "changes");
  assert.equal((await loadWebviewFixture("pr-preview.populated.en.json")).surface, "pr-preview");
});
test("fixture traversal과 지원하지 않는 surface를 거부한다", async () => {
  await assert.rejects(() => loadWebviewFixture("../package.json"), /Unsafe/);
  const valid = { schemaVersion: 1, surface: "changes", state: "small", locale: "en", viewport: { width: 1, height: 1 }, payload: {} };
  assert.throws(() => parseWebviewFixture({ ...valid, surface: "reviews" }, "inline"), /metadata/);
  assert.throws(() => parseWebviewFixture({ ...valid, schemaVersion: 2 }, "inline"), /metadata/);
  assert.throws(() => parseWebviewFixture({ ...valid, state: "cached" }, "inline"), /metadata/);
  assert.throws(() => parseWebviewFixture({ ...valid, locale: "ja" }, "inline"), /metadata/);
  assert.throws(() => parseWebviewFixture({ ...valid, viewport: { width: 0, height: 1 } }, "inline"), /viewport/);
  assert.throws(() => parseWebviewFixture({ ...valid, payload: [] }, "inline"), /payload/);
});
