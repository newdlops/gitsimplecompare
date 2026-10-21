import assert from "node:assert/strict";
import test from "node:test";
import { normalizePullRequestReviewers, PULL_REQUEST_REVIEWERS_QUERY } from "../src/git/pullRequestReviewers";
import { buildPullRequestInfoQuery, PULL_REQUEST_SUMMARY_QUERY, pullRequestInfoFromGraphQl } from "../src/git/pullRequestInfo";

test("reviewer metadata keeps the first eighty-PR summary free of reviewer connections", () => {
  assert.equal(/reviewRequests|latestReviews/.test(PULL_REQUEST_SUMMARY_QUERY), false);
  assert.match(PULL_REQUEST_SUMMARY_QUERY, /author\s*\{\s*login/);
  assert.ok(buildPullRequestInfoQuery().includes(PULL_REQUEST_REVIEWERS_QUERY));
  assert.match(PULL_REQUEST_REVIEWERS_QUERY, /reviewRequests\(first: 8\)/);
  assert.match(PULL_REQUEST_REVIEWERS_QUERY, /latestReviews\(first: 8\)/);
});

test("an actual re-review request overrides the previous approval and preserves team identity", () => {
  const result = normalizePullRequestReviewers({
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "Alice" } }, { requestedReviewer: { __typename: "Team", slug: "platform", name: "Platform team" } }], pageInfo: { hasNextPage: false } },
    latestReviews: { nodes: [{ author: { login: "alice" }, state: "APPROVED" }, { author: { login: "Bob" }, state: "CHANGES_REQUESTED" }], pageInfo: { hasNextPage: false } },
  });
  assert.deepEqual(result.reviewers, [{ login: "Alice", kind: "user", state: "REQUESTED" },
    { login: "platform", name: "Platform team", kind: "team", state: "REQUESTED" }, { login: "Bob", kind: "user", state: "CHANGES_REQUESTED" }]);
  assert.equal(result.reviewersComplete, true);
});

test("unknown, completed empty, capped and deleted-reviewer data remain distinguishable", () => {
  assert.deepEqual(normalizePullRequestReviewers({}), {});
  assert.deepEqual(normalizePullRequestReviewers({ reviewRequests: { nodes: [] }, latestReviews: { nodes: [] } }), { reviewers: [], reviewersComplete: true });
  assert.deepEqual(normalizePullRequestReviewers({ reviewRequests: { nodes: [{ requestedReviewer: null }], pageInfo: { hasNextPage: true } },
    latestReviews: { nodes: [{ author: null, state: "APPROVED" }] } }), { reviewers: [], reviewersComplete: false });
});

test("GitHub PR normalization carries author, current reviewer state and completeness into the overview", () => {
  const pr = pullRequestInfoFromGraphQl({ number: 42, author: { login: "author" }, reviewRequests: { nodes: [] },
    latestReviews: { nodes: [{ author: { login: "reviewer" }, state: "APPROVED" }], pageInfo: { hasNextPage: true } } });
  assert.equal(pr.author, "author"); assert.deepEqual(pr.reviewers, [{ login: "reviewer", kind: "user", state: "APPROVED" }]);
  assert.equal(pr.reviewersComplete, false);
});
