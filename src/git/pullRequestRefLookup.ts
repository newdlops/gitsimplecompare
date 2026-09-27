// Pull Request 하나의 head/base commit 과 표시 메타데이터만 가볍게 조회하는 GitHub 모듈.
// - Explorer PR 비교 새로고침처럼 "그 PR 이 바뀌었는가"만 알면 되는 경로가 PR 목록 80건과
//   댓글·커밋 꼬리 조회를 통째로 다시 받지 않게 한다.
import { readGitHubInteractive } from "./githubReadCache";
import type { GhExecute } from "./ghRunner";
import { pullRequestInfoFromGraphQl, type GhPullRequestNode, type PullRequestInfo } from "./pullRequestInfo";

/** head/base commit 과 목록 표시 필드만 요청하는 최소 GraphQL selection. */
const PULL_REQUEST_REFS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title state url isDraft updatedAt
      headRefName headRefOid baseRefName baseRefOid
      mergeCommit { oid }
      author { login }
    }
  }
}`;

interface PullRequestRefsResponse {
  data?: { repository?: { pullRequest?: GhPullRequestNode | null } | null };
}

/**
 * PR 번호로 head/base commit OID 와 제목·상태를 조회한다.
 * - gh 의 `{owner}`/`{repo}` 치환을 써서 `gh repo view` 없이 요청 한 번으로 끝낸다.
 * @param repoRoot 저장소 루트(gh 가 대상 GitHub 저장소를 해석할 위치)
 * @param number PR 번호
 * @param runner gh 실행 함수(기본: 시간 상한이 있는 사용자 조작용 읽기)
 * @returns PR 정보. PR 이 없으면 undefined
 */
export async function fetchPullRequestRefs(
  repoRoot: string,
  number: number,
  runner: GhExecute = readGitHubInteractive
): Promise<PullRequestInfo | undefined> {
  const output = await runner([
    "api", "graphql", "-F", "owner={owner}", "-F", "name={repo}",
    "-F", `number=${number}`, "-f", `query=${PULL_REQUEST_REFS_QUERY}`,
  ], repoRoot, { operation: "pull-request-refs" });
  const node = (JSON.parse(output) as PullRequestRefsResponse).data?.repository?.pullRequest;
  return node ? pullRequestInfoFromGraphQl(node) : undefined;
}
