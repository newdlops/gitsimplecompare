import assert from "node:assert/strict";
import test from "node:test";
import {
  PullRequestSuggestionApplyError,
  createPullRequestSuggestionApplyPreview,
  matchesPullRequestSuggestionDocument,
} from "../src/git/pullRequestSuggestionApplyPlan";

test("suggestion preview는 exact head range를 CRLF working document EOL로 바꾸고 CAS hash를 만든다", () => {
  const preview = createPullRequestSuggestionApplyPreview(
    "one\ntwo\nthree\n",
    "one\r\ntwo\r\nthree\r\n",
    { startLine: 2, endLine: 2 },
    "better\nline",
    "\r\n"
  );

  assert.equal(preview.before, "two\r\n");
  assert.equal(preview.after, "better\r\nline");
  assert.equal(matchesPullRequestSuggestionDocument("one\r\ntwo\r\nthree\r\n", preview.documentHash), true);
  assert.equal(matchesPullRequestSuggestionDocument("one\r\nchanged\r\nthree\r\n", preview.documentHash), false);
});

test("suggestion preview는 target range가 dirty worktree와 다르거나 존재하지 않으면 안전하게 거부한다", () => {
  assert.throws(
    () => createPullRequestSuggestionApplyPreview("one\ntwo\n", "one\nlocal\n", { startLine: 2, endLine: 2 }, "better"),
    (error: unknown) => error instanceof PullRequestSuggestionApplyError && error.code === "SOURCE_MISMATCH"
  );
  assert.throws(
    () => createPullRequestSuggestionApplyPreview("one\n", "one\n", { startLine: 3, endLine: 3 }, "better"),
    (error: unknown) => error instanceof PullRequestSuggestionApplyError && error.code === "INVALID_RANGE"
  );
});

test("suggestion preview는 빈 replacement로 선택 line을 삭제하되 나머지 document를 보존한다", () => {
  const preview = createPullRequestSuggestionApplyPreview("one\ntwo\nthree\n", "one\ntwo\nthree\n", { startLine: 2, endLine: 2 }, "");

  assert.equal(preview.before, "two\n");
  assert.equal(preview.after, "");
  assert.equal(matchesPullRequestSuggestionDocument("one\nthree\n", preview.appliedHash), true);
});
