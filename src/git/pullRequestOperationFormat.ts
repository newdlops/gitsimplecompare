// PR 작업에서 쓰는 순수 문자열/목록 조립 함수.
// - git 상태를 바꾸지 않는 계산만 모아 PullRequestOperationService 의 책임을 줄인다.
import { randomBytes } from "node:crypto";
import type { PullRequestInfo } from "./pullRequestService";

const SNAPSHOT_REF_PREFIX = "refs/gitsimplecompare/pr-operation-index";
const LEGACY_SNAPSHOT_REF_PREFIX = "refs/gitsimplecompare/pr-operations";

export const PULL_REQUEST_OPERATION_COMMANDS = [
  "squash",
  "rebase",
  "squashRevert",
  "rebaseRevert",
] as const;

export type PullRequestOperationCommand = typeof PULL_REQUEST_OPERATION_COMMANDS[number];

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
 * 브랜치별 최신 PR 작업 undo snapshot ref 이름을 만든다.
 * @param branch snapshot 을 저장할 브랜치 이름
 * @returns git refs 아래에 저장할 최신 snapshot 포인터 ref
 */
export function snapshotRefForBranch(branch: string): string {
  return `${SNAPSHOT_REF_PREFIX}/${branchIndex(branch)}/latest`;
}

/**
 * command 별 최신 PR 작업 undo snapshot ref 이름을 만든다.
 * @param branch snapshot 을 저장할 브랜치 이름
 * @param command snapshot 을 만든 PR 작업 command
 * @returns git refs 아래에 저장할 command 최신 snapshot 포인터 ref
 */
export function snapshotRefForCommand(
  branch: string,
  command: PullRequestOperationCommand
): string {
  return `${SNAPSHOT_REF_PREFIX}/${branchIndex(branch)}/${commandIndex(command)}/latest`;
}

/**
 * command 별 snowflake PR 작업 undo snapshot ref 이름을 만든다.
 * @param branch snapshot 을 저장할 브랜치 이름
 * @param command snapshot 을 만든 PR 작업 command
 * @param snowflake 같은 command 안에서 snapshot 을 구분할 snowflake id
 * @returns git refs 아래에 저장할 고정 snapshot ref
 */
export function snapshotRefForCommandSnowflake(
  branch: string,
  command: PullRequestOperationCommand,
  snowflake: string
): string {
  return `${SNAPSHOT_REF_PREFIX}/${branchIndex(branch)}/${commandIndex(command)}/snapshots/${snowflake}`;
}

/**
 * 예전 브랜치 단위 undo snapshot ref 이름을 만든다.
 * @param branch snapshot 을 저장한 브랜치 이름
 * @returns 이전 버전에서 사용한 flat snapshot ref
 */
export function legacySnapshotRefForBranch(branch: string): string {
  return `${LEGACY_SNAPSHOT_REF_PREFIX}/${branchIndex(branch)}`;
}

/**
 * 최신순 정렬 가능한 snowflake id 를 만든다.
 * @returns 시간 prefix 와 random suffix 를 가진 snapshot id
 */
export function createSnapshotSnowflake(): string {
  const time = Date.now().toString(36).padStart(10, "0");
  const pid = process.pid.toString(36);
  const random = randomBytes(4).toString("hex");
  return `${time}-${pid}-${random}`;
}

/**
 * commit subject 에 들어갈 PR 제목을 한 줄로 정리한다.
 * @param title 원본 제목
 * @returns 줄바꿈과 큰따옴표를 정리한 제목
 */
function singleLineTitle(title: string): string {
  return title.replace(/\s+/g, " ").replace(/"/g, "'").trim() || "changes";
}

/**
 * 브랜치명을 git ref path 에 안전한 index 로 변환한다.
 * @param branch 원본 브랜치 이름
 * @returns 브랜치명의 hex index
 */
function branchIndex(branch: string): string {
  return Buffer.from(branch).toString("hex");
}

/**
 * command 이름을 ref path component 로 변환한다.
 * @param command PR 작업 command
 * @returns git ref path 에 넣을 command index
 */
function commandIndex(command: PullRequestOperationCommand): string {
  switch (command) {
    case "squash":
      return "squash";
    case "rebase":
      return "rebase";
    case "squashRevert":
      return "squash-revert";
    case "rebaseRevert":
      return "rebase-revert";
  }
}
