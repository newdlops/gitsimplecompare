// GitHub Pull Request 목록/검색 응답의 공통 타입과 정규화 규칙.
// - 목록과 검색 서비스가 같은 GraphQL selection 및 commit 의미를 공유하도록 분리한다.
// - PR 자체 commit 과 merge 결과 commit 을 구분해 git 작업에는 원래 commit 만 사용하게 한다.
import {
  PULL_REQUEST_COMMENT_COUNTS_QUERY,
  totalPullRequestCommentCount,
} from "./pullRequestCommentCounts";
import type { GhPullRequestCommentCounts } from "./pullRequestCommentCounts";
import {
  PULL_REQUEST_LABELS_QUERY,
  normalizePullRequestLabels,
} from "./pullRequestLabels";
import type {
  GhPullRequestLabels,
  PullRequestLabelInfo,
} from "./pullRequestLabels";

/** graph 에 표시하고 PR 작업에 전달할 Pull Request 한 건 */
export interface PullRequestInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  headRefName: string;
  /** GitHub가 보고한 PR head commit OID */
  headHash?: string;
  baseRefName: string;
  /** GitHub가 보고한 base branch tip commit OID */
  baseHash?: string;
  /** merge/squash/rebase 뒤 base branch에 반영된 결과 commit OID */
  mergeHash?: string;
  author: string;
  isDraft: boolean;
  reviewDecision?: string;
  updatedAt?: string;
  commentCount: number;
  fileCount: number;
  /** PR head branch에 포함된 원래 commit OID 목록. PR git 작업에서 사용한다. */
  commitHashes: string[];
  labels?: PullRequestLabelInfo[];
}

/** GitHub GraphQL connection 의 pagination 최소 형태 */
export interface GhPageInfo {
  hasNextPage?: boolean;
  endCursor?: string;
}

/** 목록/검색 GraphQL 쿼리가 공통으로 받는 PullRequest node 형태 */
export interface GhPullRequestNode extends GhPullRequestCommentCounts {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  baseRefOid?: string;
  mergeCommit?: { oid?: string } | null;
  author?: { login?: string };
  isDraft?: boolean;
  reviewDecision?: string;
  updatedAt?: string;
  labels?: GhPullRequestLabels;
  files?: { totalCount?: number };
  commits?: {
    nodes?: Array<{ commit?: { oid?: string } }>;
    pageInfo?: GhPageInfo;
  };
}

/** 목록/번호/커밋 검색에서 재사용하는 PullRequest GraphQL selection */
export const PULL_REQUEST_INFO_QUERY = `
        number
        title
        state
        url
        headRefName
        headRefOid
        baseRefName
        baseRefOid
        mergeCommit { oid }
        author { login }
        isDraft
        reviewDecision
        updatedAt
${PULL_REQUEST_LABELS_QUERY}
${PULL_REQUEST_COMMENT_COUNTS_QUERY}
        files(first: 1) { totalCount }
        commits(first: 100) {
          nodes { commit { oid } }
          pageInfo { hasNextPage endCursor }
        }`;

/**
 * GitHub GraphQL PullRequest node 를 확장 내부 공통 타입으로 정규화한다.
 * - `mergeHash`는 graph 매칭에만 쓰도록 `commitHashes`와 분리한다. 이를 섞으면
 *   squash/rebase 결과 commit이 PR cherry-pick/revert 대상에 잘못 포함될 수 있다.
 * @param pr GitHub GraphQL PullRequest node
 * @param extraReviewCommentCount 첫 reviewThreads 페이지 뒤에서 추가 집계한 댓글 수
 * @returns UI 표시와 PR 작업에 공통으로 사용할 PullRequestInfo
 */
export function pullRequestInfoFromGraphQl(
  pr: GhPullRequestNode,
  extraReviewCommentCount = 0
): PullRequestInfo {
  return {
    number: Number(pr.number) || 0,
    title: pr.title || "",
    state: pr.state || "",
    url: pr.url || "",
    headRefName: pr.headRefName || "",
    headHash: pr.headRefOid,
    baseRefName: pr.baseRefName || "",
    baseHash: pr.baseRefOid,
    mergeHash: pr.mergeCommit?.oid,
    author: pr.author?.login || "",
    isDraft: Boolean(pr.isDraft),
    reviewDecision: pr.reviewDecision,
    updatedAt: pr.updatedAt,
    commentCount: totalPullRequestCommentCount(pr, extraReviewCommentCount),
    fileCount: pr.files?.totalCount ?? 0,
    commitHashes: normalizePullRequestCommitHashes(pr),
    labels: normalizePullRequestLabels(pr.labels),
  };
}

/**
 * PR commit connection과 head OID를 실제 PR 작업용 commit 목록으로 정규화한다.
 * - API가 빈 목록을 반환해도 head commit을 fallback으로 남기며 입력 순서와 중복 제거를 보존한다.
 * @param pr commit connection과 head OID를 가진 GitHub PullRequest node
 * @returns 중복이 제거된 PR 원래 commit OID 목록
 */
function normalizePullRequestCommitHashes(pr: GhPullRequestNode): string[] {
  return Array.from(new Set([
    ...(pr.commits?.nodes || []).map((node) => node.commit?.oid || ""),
    pr.headRefOid || "",
  ].filter(Boolean)));
}
