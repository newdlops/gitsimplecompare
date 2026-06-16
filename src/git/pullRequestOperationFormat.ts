// PR 작업에서 쓰는 순수 문자열/목록 조립 함수.
// - git 상태를 바꾸지 않는 계산만 모아 PullRequestOperationService 의 책임을 줄인다.
import type { PullRequestInfo } from "./pullRequestService";

/**
 * PR commit hash 를 중복 없이 cherry-pick 순서로 반환한다.
 * @param pr 작업 대상 PR 정보
 * @returns cherry-pick/rebase 에 사용할 commit hash 목록
 */
export function pullRequestCommitHashes(pr: PullRequestInfo): string[] {
  return Array.from(new Set([...(pr.commitHashes || []), pr.headHash || ""].filter(Boolean)));
}

/**
 * PR commit hash 를 revert 적용 순서(최신→오래된 순)로 반환한다.
 * @param pr 작업 대상 PR 정보
 * @returns revert 에 사용할 commit hash 목록
 */
export function pullRequestRevertCommitHashes(pr: PullRequestInfo): string[] {
  return [...pullRequestCommitHashes(pr)].reverse();
}

/**
 * squash commit 제목을 만든다.
 * @param pr 작업 대상 PR 정보
 * @returns squash commit subject
 */
export function squashTitle(pr: PullRequestInfo): string {
  return `Cherry-Pick "${singleLineTitle(pr.title || pr.headRefName || `PR #${pr.number}`)}"`;
}

/**
 * squash commit 본문을 만든다.
 * @param pr 작업 대상 PR 정보
 * @returns squash commit body
 */
export function squashBody(pr: PullRequestInfo): string {
  return [
    `Cherry-picked pull request #${pr.number} as a squash commit.`,
    pr.url ? `Original PR: ${pr.url}` : "",
    pr.headRefName && pr.baseRefName ? `Source: ${pr.headRefName} -> ${pr.baseRefName}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * PR squash revert commit 제목을 만든다.
 * @param pr 작업 대상 PR 정보
 * @returns squash revert commit subject
 */
export function squashRevertTitle(pr: PullRequestInfo): string {
  return `Revert "${singleLineTitle(pr.title || pr.headRefName || `PR #${pr.number}`)}"`;
}

/**
 * PR squash revert commit 본문을 만든다.
 * @param pr 작업 대상 PR 정보
 * @returns squash revert commit body
 */
export function squashRevertBody(pr: PullRequestInfo): string {
  return [
    `Reverted pull request #${pr.number} as a squash commit.`,
    pr.url ? `Original PR: ${pr.url}` : "",
    pr.headRefName && pr.baseRefName ? `Source: ${pr.headRefName} -> ${pr.baseRefName}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * 브랜치별 undo snapshot ref 이름을 만든다.
 * @param branch snapshot 을 저장할 브랜치 이름
 * @returns git refs 아래에 저장할 snapshot ref
 */
export function snapshotRefForBranch(branch: string): string {
  return `refs/gitsimplecompare/pr-operations/${Buffer.from(branch).toString("hex")}`;
}

/**
 * commit subject 에 들어갈 PR 제목을 한 줄로 정리한다.
 * @param title 원본 제목
 * @returns 줄바꿈과 큰따옴표를 정리한 제목
 */
function singleLineTitle(title: string): string {
  return title.replace(/\s+/g, " ").replace(/"/g, "'").trim() || "changes";
}
