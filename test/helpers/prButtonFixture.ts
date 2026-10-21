// PR 실행의 Git은 그대로 두고 외부 GitHub 목록 응답만 임시 저장소의 실제 OID로 대체한다.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { PullRequestService } from "../../src/git/pullRequestService";
import type { PullRequestInfo } from "../../src/git/pullRequestInfo";
import { runGit } from "../../src/git/gitExec";

interface PrFixture { root: string; main: string; pr: string; prCommits: string[] }

/** ready/refresh 모두 같은 완전한 PR 원본 목록을 반환해 실제 pager와 rendered action을 연결한다. */
export function installPrButtonFixture(f: PrFixture): void {
  const pr: PullRequestInfo = { number: 42, title: "Local operation benchmark", state: "OPEN",
    url: "https://example.invalid/pull/42", headRefName: "pr-source", headHash: f.pr,
    baseRefName: "main", author: "fixture", isDraft: false, commentCount: 0, fileCount: 3,
    commitHashes: f.prCommits, commitHashesComplete: true };
  mock.method(PullRequestService.prototype, "getOverview", async () => ({
    available: true, defaultBranch: "main", pullRequests: [pr], hasMore: false,
  }));
}

/** 실제 작업 뒤 source tree·시작 parent·커밋 개수를 Native Git으로 읽어 버튼의 성공 알림만 믿지 않는다. */
export async function verifyPrButtonResult(f: PrFixture, squash: boolean): Promise<void> {
  const git = async (args: string[]) => (await runGit(args, f.root)).trim();
  assert.equal(await git(["rev-parse", "HEAD^{tree}"]), await git(["rev-parse", `${f.pr}^{tree}`]));
  assert.equal(await git(["rev-list", "--count", `${f.main}..HEAD`]), squash ? "1" : "3");
  const first = (await git(["rev-list", "--reverse", `${f.main}..HEAD`])).split("\n")[0];
  assert.equal(await git(["rev-parse", `${first}^`]), f.main);
  if (!squash) assert.deepEqual((await git(["log", "--reverse", "--format=%s", `${f.main}..HEAD`])).split("\n"), ["PR 0", "PR 1", "PR 2"]);
}
