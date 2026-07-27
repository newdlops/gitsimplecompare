// release 기본값에서 review write message가 host 경계에서 차단되는지 확인한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { isReviewCenterWriteMessage, isReviewQueueWriteMessage } from "../src/ui/reviewWritePolicy";

test("Review Center의 읽기 요청은 write gate 대상이 아니다", () => {
  assert.equal(isReviewCenterWriteMessage({ type: "refresh" }), false);
  assert.equal(isReviewCenterWriteMessage({ type: "openFile" }), false);
});

test("Review Center의 원격·작업 트리 변경 요청은 write gate 대상이다", () => {
  for (const type of ["toggleViewed", "applyManagement", "submitReviewDraft", "addLineReviewComment", "applySuggestion"]) {
    assert.equal(isReviewCenterWriteMessage({ type }), true, type);
  }
});

test("Reviews queue의 bulk write 흐름만 write gate 대상이다", () => {
  assert.equal(isReviewQueueWriteMessage({ type: "selectSavedQueue" }), false);
  for (const type of ["previewBulkManagement", "applyBulkManagement", "retryFailedBulkManagement"]) {
    assert.equal(isReviewQueueWriteMessage({ type }), true, type);
  }
});

test("리뷰 쓰기는 기본 사용 가능이며 사용자가 읽기 전용으로 끌 수 있다", () => {
  const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
  };
  assert.equal(manifest.contributes.configuration.properties["gitSimpleCompare.reviewWritesEnabled"].default, true);
  assert.equal(manifest.contributes.configuration.properties["gitSimpleCompare.experimentalReviewWrites"], undefined);
});
