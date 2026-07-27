// GitHub PR 리뷰 fixture 기반을 검증한다.
// - 이후 queue, comment, management 서비스 테스트가 같은 synthetic response 계약을 공유한다.
import assert from "node:assert/strict";
import test from "node:test";
import { loadGitHubReviewFixture } from "./helpers/githubReviewFixture";

test("GitHub review viewer fixture는 상태·헤더·GraphQL body를 보존한다", async () => {
  const fixture = await loadGitHubReviewFixture<{
    data: { viewer: { login: string; id: string } };
  }>("viewer.github-com.json");

  assert.equal(fixture.source, "gh api graphql");
  assert.equal(fixture.operation, "viewer");
  assert.equal(fixture.response.status, 200);
  assert.equal(fixture.response.headers["x-ratelimit-remaining"], "4999");
  assert.equal(fixture.response.body?.data.viewer.login, "fixture-reviewer");
});

test("GitHub review rate limit fixture는 재시도 헤더를 보존한다", async () => {
  const fixture = await loadGitHubReviewFixture<{ message: string }>("errors.rate-limit.json");

  assert.equal(fixture.response.status, 429);
  assert.equal(fixture.response.headers["retry-after"], "60");
  assert.equal(fixture.response.body?.message, "API rate limit exceeded");
});

test("GitHub review fixture loader는 경로 탐색 이름을 거부한다", async () => {
  await assert.rejects(loadGitHubReviewFixture("../package.json"), /Unsafe GitHub review fixture name/);
});
