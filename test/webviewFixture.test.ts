// PR-00 webview fixture schema의 대표 상태와 경로 안전성을 검증한다.
import assert from "node:assert/strict";
import test from "node:test";
import { loadWebviewFixture } from "./helpers/webviewFixture";

test("webview fixture는 small/large/error/Korean 대표 상태를 명시한다", async () => {
  const [small, large, error, korean] = await Promise.all([
    loadWebviewFixture("changes.small.en.json"),
    loadWebviewFixture("reviews.large.en.json"),
    loadWebviewFixture("review-workspace.error.en.json"),
    loadWebviewFixture("reviews.management.ko.json"),
  ]);

  assert.equal(small.surface, "changes");
  assert.equal(small.state, "small");
  assert.equal(large.state, "large");
  assert.equal(error.state, "error");
  assert.equal(korean.locale, "ko");
  assert.ok(korean.viewport.width >= 320);
});

test("webview fixture loader는 경로 탐색 이름을 거부한다", async () => {
  await assert.rejects(loadWebviewFixture("../package.json"), /Unsafe webview fixture name/);
});
