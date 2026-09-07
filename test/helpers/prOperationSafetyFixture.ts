import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { PullRequestInfo } from "../../src/git/pullRequestInfo";
import { PullRequestOperationService } from "../../src/git/pullRequestOperationService";
import { commitText, git, safetyFixture } from "./gitSafetyFixture";

/** Git 관련 필드가 실제 커밋을 가리키는 최소 PR 입력을 만든다. */
export function safetyPullRequest(hash: string): PullRequestInfo {
  return {
    number: 42, title: "Safety fixture", state: "OPEN", url: "https://example.invalid/pull/42",
    headRefName: "source", headHash: hash, baseRefName: "main", author: "tester",
    isDraft: false, commentCount: 0, fileCount: 1, commitHashes: [hash],
  };
}

/** PR 적용 대상 main, 원본 커밋 source와 별도 사용자 편집용 파일을 실제 Git으로 만든다. */
export async function prSafetyFixture(t: TestContext, conflict = false) {
  const fixture = await safetyFixture(t, "pr-undo-safety");
  const { root } = fixture;
  await writeFile(join(root, "other.txt"), "other base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "other base");
  const base = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "-qc", "source");
  const source = await commitText(root, "PR content\n", "PR source");
  await git(root, "switch", "main");
  if (conflict) await commitText(root, "local content\n", "local");
  return { ...fixture, base, source, pr: safetyPullRequest(source), service: new PullRequestOperationService(root) };
}
