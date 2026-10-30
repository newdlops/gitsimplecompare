// GitHub Pull Request 목록/검색 응답의 공통 타입과 정규화 규칙.
// - 목록과 검색 서비스가 같은 GraphQL selection 및 commit 의미를 공유하도록 분리한다.
// - PR 자체 commit 과 merge 결과 commit 을 구분해 git 작업에는 원래 commit 만 사용하게 한다.
import {
  buildPullRequestCommentCountsQuery,
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
import { normalizePullRequestReviewers, PULL_REQUEST_REVIEWERS_QUERY, type GhPullRequestReviewers, type PullRequestReviewer } from "./pullRequestReviewers";

/** 그래프 페이지와 독립적으로 PR 원래 커밋의 제목·작성자·시각을 표시할 불변 요약이다. */
export interface PullRequestCommitSummary { hash: string; title: string; author?: string; dateIso?: string; }
/** GitHub commit connection에서 요약 표시와 OID 수집이 함께 사용하는 필드다. */
export interface GhPullRequestCommit { oid?: string; messageHeadline?: string; committedDate?: string; author?: { name?: string } | null; }
/** 첫 페이지와 후속 페이지가 같은 요약 필드를 요청해 그래프 밖 커밋도 내용을 읽을 수 있게 한다. */
export const PULL_REQUEST_COMMIT_FIELDS = "oid messageHeadline committedDate author { name }";

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
  /** 머지 결과도 그래프 밖에서 읽을 수 있도록 원래 PR 커밋과 분리한 표시 요약이다. */
  mergeCommitSummary?: PullRequestCommitSummary;
  author: string;
  reviewers?: PullRequestReviewer[];
  /** false면 제한된 reviewer 연결 뒤에 더 많은 사용자가 있다. 미조회는 reviewers 자체가 undefined다. */
  reviewersComplete?: boolean;
  isDraft: boolean;
  reviewDecision?: string;
  updatedAt?: string;
  commentCount: number;
  /** false면 review thread 후속 페이지가 남아 있어 댓글 합계를 아직 확정할 수 없다. */
  commentCountComplete?: boolean;
  fileCount: number;
  /** false면 기본 목록만 받은 상태여서 파일 수를 아직 확정할 수 없다. */
  fileCountComplete?: boolean;
  /** PR head branch에 포함된 원래 commit OID 목록. PR git 작업에서 사용한다. */
  commitHashes: string[];
  /** 원래 PR 커밋의 표시 정보. 현재 Graph 페이지에 해당 OID가 없어도 제목을 보여준다. */
  commitSummaries?: PullRequestCommitSummary[];
  /** false면 후속 commit 페이지가 남아 있어 Git 쓰기 작업에 사용할 수 없다. */
  commitHashesComplete?: boolean;
  labels?: PullRequestLabelInfo[];
}

/** GitHub GraphQL connection 의 pagination 최소 형태 */
export interface GhPageInfo {
  hasNextPage?: boolean;
  endCursor?: string;
}

/** 목록/검색 GraphQL 쿼리가 공통으로 받는 PullRequest node 형태 */
export interface GhPullRequestNode extends GhPullRequestCommentCounts, GhPullRequestReviewers {
  /** 얕은 목록 응답과 직접 node 조회를 같은 PR에 연결하는 GitHub global ID */
  id?: string;
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  baseRefOid?: string;
  mergeCommit?: GhPullRequestCommit | null;
  author?: { login?: string };
  isDraft?: boolean;
  reviewDecision?: string;
  updatedAt?: string;
  labels?: GhPullRequestLabels;
  files?: { totalCount?: number };
  commits?: {
    nodes?: Array<{ commit?: GhPullRequestCommit }>;
    pageInfo?: GhPageInfo;
  };
}

/** 목록/번호/커밋 검색에서 재사용하는 기본 PullRequest GraphQL selection */
export const PULL_REQUEST_INFO_QUERY = buildPullRequestInfoQuery();

/**
 * PR 80개의 정렬 조회에서도 가벼운 기본 정보를 먼저 받는 selection이다.
 * 커밋·review connection은 포함하지 않아 상세 묶음의 네트워크 대기가 첫 목록을 막지 않는다.
 * @returns connection 집계·Git OID·review 판정 없이 바로 표시할 제목·상태·브랜치·작성자 정보
 */
export const PULL_REQUEST_SUMMARY_QUERY = `
        number title state url
        headRefName baseRefName
        author { login }
        isDraft updatedAt`;

/**
 * 목록 크기에 맞춰 중첩 connection의 첫 페이지 크기를 조절한 selection을 만든다.
 * - 작은 첫 페이지를 쓰는 호출자는 pageInfo를 따라 나머지 데이터를 반드시 보완한다.
 * @param commitPageSize PR별 첫 commit 페이지 크기. 검색 등 기존 호출은 100을 유지한다.
 * @param reviewThreadPageSize PR별 첫 review thread 페이지 크기
 * @param includeStableConnections false면 같은 head/base로 검증한 캐시에서 채울 commit/file 연결을 생략한다.
 * @returns 공통 PR 필드와 지정한 connection 크기를 포함한 GraphQL selection
 */
export function buildPullRequestInfoQuery(commitPageSize = 100, reviewThreadPageSize = 100, includeStableConnections = true): string {
  return `
        number
        title
        state
        url
        headRefName
        headRefOid
        baseRefName
        baseRefOid
        mergeCommit { ${PULL_REQUEST_COMMIT_FIELDS} }
        author { login }
        isDraft
        reviewDecision
        updatedAt
${PULL_REQUEST_LABELS_QUERY}
${PULL_REQUEST_REVIEWERS_QUERY}
${buildPullRequestCommentCountsQuery(reviewThreadPageSize)}
${includeStableConnections ? `        files(first: 1) { totalCount }
        commits(first: ${commitPageSize}) {
          nodes { commit { ${PULL_REQUEST_COMMIT_FIELDS} } }
          pageInfo { hasNextPage endCursor }
        }` : ""}`;
}

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
  extraReviewCommentCount?: number
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
    mergeCommitSummary: pullRequestCommitSummary(pr.mergeCommit ?? undefined),
    author: pr.author?.login || "",
    ...normalizePullRequestReviewers(pr),
    isDraft: Boolean(pr.isDraft),
    reviewDecision: pr.reviewDecision,
    updatedAt: pr.updatedAt,
    commentCount: totalPullRequestCommentCount(pr, extraReviewCommentCount),
    commentCountComplete: extraReviewCommentCount !== undefined || !pr.reviewThreads?.pageInfo?.hasNextPage,
    fileCount: pr.files?.totalCount ?? 0,
    fileCountComplete: Number.isSafeInteger(pr.files?.totalCount),
    commitHashes: normalizePullRequestCommitHashes(pr),
    commitSummaries: (pr.commits?.nodes || []).flatMap(node => {
      const summary = pullRequestCommitSummary(node.commit); return summary ? [summary] : [];
    }),
    commitHashesComplete: !pr.commits?.pageInfo?.hasNextPage,
    labels: normalizePullRequestLabels(pr.labels),
  };
}

/**
 * GitHub 커밋 필드를 그래프 비의존 표시 DTO로 바꾸며 OID·제목을 조회하지 않은 항목은 생성하지 않는다.
 * @param commit 첫 페이지 또는 후속 페이지에서 받은 커밋
 * @returns OID와 실제 제목·작성 정보. 빈 커밋 메시지는 빈 문자열로 보존한다.
 */
export function pullRequestCommitSummary(commit: GhPullRequestCommit | undefined): PullRequestCommitSummary | undefined {
  return commit?.oid && typeof commit.messageHeadline === "string"
    ? { hash: commit.oid, title: commit.messageHeadline, author: commit.author?.name, dateIso: commit.committedDate } : undefined;
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
