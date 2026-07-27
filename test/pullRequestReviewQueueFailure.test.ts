// Reviews failure mapper가 auth/permission/offline/rate-limit을 raw diagnostic 없이 분리하는지 검증한다.
import assert from "node:assert/strict";
import test from "node:test";
import { GhCliError } from "../src/git/ghCli";
import { ReviewQueueFailure, toReviewQueueFailure } from "../src/git/pullRequestReviewQueueFailure";

/** 특정 gh stderr를 가진 오류를 짧게 만든다. */
function ghError(stderr: string, code?: unknown): GhCliError {
  return new GhCliError("review queue request failed", ["api", "graphql"], stderr, "", code, "review.queue.identity");
}

test("review queue failure mapper는 auth·scope permission·rate limit·offline·generic을 분리한다", () => {
  const cases: Array<[unknown, ReviewQueueFailure["kind"]]> = [
    [ghError("HTTP 401: Bad credentials"), "authRequired"],
    [ghError("HTTP 403: Resource not accessible by integration"), "permissionDenied"],
    [ghError("HTTP 429: API rate limit exceeded"), "rateLimited"],
    [ghError("request failed", "ENOTFOUND"), "offline"],
    [ghError("HTTP 403: Forbidden"), "error"],
  ];
  for (const [error, kind] of cases) {
    assert.equal(toReviewQueueFailure(error).kind, kind);
  }
});

test("typed failure는 원본 stderr를 user-facing message에 복사하지 않는다", () => {
  const failure = toReviewQueueFailure(ghError("HTTP 401 bearer ghp_secret_should_not_escape"));
  assert.equal(failure.message.includes("ghp_secret_should_not_escape"), false);
  assert.equal(failure.cause instanceof GhCliError, true);
});
