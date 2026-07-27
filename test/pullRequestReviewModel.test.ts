import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRequestedReviewers,
  normalizeNamedNodes,
  normalizeReviewQueuePullRequests,
} from "../src/git/pullRequestReviewModel";

test("리뷰 큐 정규화는 팀과 사용자 reviewer를 중복 없이 최신 PR 순서로 만든다", () => {
  const pullRequests = normalizeReviewQueuePullRequests([
    {
      number: 18,
      title: "Older",
      url: "https://github.com/acme/demo/pull/18",
      updatedAt: "2026-07-20T01:00:00Z",
      reviewRequests: { nodes: [{ requestedReviewer: { login: "octo" } }] },
    },
    {
      number: 19,
      repository: { nameWithOwner: "acme/other" },
      title: "Newer",
      url: "https://github.com/acme/demo/pull/19",
      updatedAt: "2026-07-21T01:00:00Z",
      reviewRequests: {
        nodes: [
          { requestedReviewer: { slug: "platform", organization: { login: "acme" } } },
          { requestedReviewer: { login: "octo" } },
          { requestedReviewer: { login: "octo" } },
        ],
      },
    },
  ]);

  assert.deepEqual(pullRequests.map((pullRequest) => pullRequest.number), [19, 18]);
  assert.deepEqual(pullRequests[0]?.requestedReviewers, ["acme/platform", "octo"]);
  assert.equal(pullRequests[0]?.repository, "acme/other");
});

test("리뷰 큐 정규화는 URL 또는 유효 번호가 없는 GraphQL node를 제거한다", () => {
  const pullRequests = normalizeReviewQueuePullRequests([
    { number: 0, url: "https://github.com/acme/demo/pull/0" },
    { number: 22, title: "Missing URL" },
  ]);

  assert.deepEqual(pullRequests, []);
});

test("교차 저장소 관리 큐는 같은 번호의 PR을 저장소별로 모두 유지한다", () => {
  const pullRequests = normalizeReviewQueuePullRequests([
    { number: 7, repository: { nameWithOwner: "acme/api" }, title: "API", updatedAt: "2026-07-20T01:00:00Z", url: "https://github.com/acme/api/pull/7" },
    { number: 7, repository: { nameWithOwner: "acme/web" }, title: "Web", updatedAt: "2026-07-21T01:00:00Z", url: "https://github.com/acme/web/pull/7" },
  ]);

  assert.deepEqual(pullRequests.map((pullRequest) => [pullRequest.repository, pullRequest.number]), [
    ["acme/web", 7], ["acme/api", 7],
  ]);
});

test("요청 reviewer 정규화는 사용자 login을 팀 slug보다 우선한다", () => {
  assert.deepEqual(
    normalizeRequestedReviewers([
      { requestedReviewer: { login: "alice", slug: "ignored" } },
      { requestedReviewer: { slug: "design" } },
      null,
    ]),
    ["alice", "design"]
  );
});

test("관리 metadata 정규화는 assignee와 label의 공백·중복을 제거한다", () => {
  assert.deepEqual(normalizeNamedNodes([{ login: "alice" }, { login: " alice " }, null], "login"), ["alice"]);
  assert.deepEqual(normalizeNamedNodes([{ name: "bug" }, { name: "priority" }, { name: "bug" }], "name"), ["bug", "priority"]);
});
