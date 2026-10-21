// PR 실행의 Git은 그대로 두고 외부 GitHub 목록 응답만 임시 저장소의 실제 OID로 대체한다.
import assert from "node:assert/strict";
import { benchmarkOverrides as mock } from "./benchmarkOverrides";
import { PullRequestService } from "../../src/git/pullRequestService";
import type { PullRequestInfo } from "../../src/git/pullRequestInfo";
import { runGit } from "../../src/git/gitExec";

interface PrFixture { root: string; main: string; pr: string; prCommits: string[]; mainBranch?: string; prBranch?: string }

/**
 * ready/refresh에 같은 완전한 PR 목록을 주어 실제 pager와 렌더된 action을 연결한다.
 * @param f 테스트가 소유한 저장소와 적용할 PR 원본 @param count 1~80개의 목록 크기
 * @returns 실제 준비한 PR 수. 추가 항목은 같은 fixture의 기존 Native branch/OID만 사용한다.
 */
export async function installPrButtonFixture(f: PrFixture, count = 1): Promise<number> {
  assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 80);
  const pr: PullRequestInfo = { number: 42, title: "Local operation benchmark", state: "OPEN",
    url: "https://example.invalid/pull/42", headRefName: f.prBranch ?? "pr-source", headHash: f.pr,
    baseRefName: f.mainBranch ?? "main", author: "fixture", isDraft: false, commentCount: 0, fileCount: 3,
    commitHashes: f.prCommits, commitHashesComplete: true };
  const pullRequests = [pr];
  if (count > 1) {
    // 추가 PR도 임시 저장소에 이미 있는 Native branch/OID만 사용한다. 원격 조회나 새 ref는 만들지 않는다.
    const tips = (await runGit(["for-each-ref", `--count=${count - 1}`, "--sort=refname",
      "--format=%(refname:short)%00%(objectname)", "refs/heads/"], f.root)).trim().split("\n");
    assert.equal(tips.length, count - 1, "Dense PR fixture needs enough actual local branches");
    for (const [index, line] of tips.entries()) {
      const [name, hash] = line.split("\0"); assert.ok(name && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash));
      pullRequests.push({ ...pr, number: 43 + index, title: `Native branch fixture ${index + 1}: ${name}`,
        url: `https://example.invalid/pull/${43 + index}`, headRefName: name, headHash: hash,
        commitHashes: [hash], fileCount: 1 });
    }
  }
  mock.method(PullRequestService.prototype, "getOverview", async () => ({
    available: true, defaultBranch: f.mainBranch ?? "main", pullRequests, hasMore: false,
  }));
  return pullRequests.length;
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
