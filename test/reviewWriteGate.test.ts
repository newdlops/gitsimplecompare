// release 기본값에서 review write message가 host 경계에서 차단되는지 확인한다.
import assert from "node:assert/strict";
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
