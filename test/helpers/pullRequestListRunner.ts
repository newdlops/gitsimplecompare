import { fetchPullRequestListPage, type PullRequestListOptions } from "../../src/git/pullRequestListService";
import type { GhPullRequestNode } from "../../src/git/pullRequestInfo";
import type { GhExecute } from "../../src/git/ghRunner";

/**
 * commit/comment pagination 검사에서 쓰는 축약 fixture를 실제 node 응답의 연결 형태로 보완한다.
 * - 테스트가 지정한 cursor·OID·댓글 합계는 보존하고, 생략한 빈 연결만 명시적으로 채운다.
 * @param node 기존 pagination 검사가 정의한 PR
 * @returns ID와 필수 연결을 가진 직렬화 가능한 GraphQL PR node
 */
function completeNode(node: GhPullRequestNode): GhPullRequestNode {
  return { ...node, id: node.id || `fixture-pr-${node.number}`,
    files: { totalCount: 0, ...node.files }, comments: { totalCount: 0, ...node.comments },
    commits: { ...node.commits, nodes: node.commits?.nodes || [],
      pageInfo: { hasNextPage: false, ...node.commits?.pageInfo } },
    reviewThreads: { ...node.reviewThreads, nodes: node.reviewThreads?.nodes || [],
      pageInfo: { hasNextPage: false, ...node.reviewThreads?.pageInfo } } };
}

/**
 * 기존 후속 페이지 실행기에 새 ID 조회 경계의 완전한 fake 응답을 연결한다.
 * - 실제 서비스와 공통 실행 큐는 그대로 실행하고 원격 응답만 대체한다.
 * - metadata 요청은 여기서 답하고 기존 runner는 root와 commit/comment tail만 제어한다.
 * @param runner 후속 pagination의 지연·오류·취소를 소유한 fixture 실행기
 * @returns 현재 제품의 두 단계 조회 프로토콜에 맞춘 실행기
 */
export function withPullRequestMetadata(runner: GhExecute): GhExecute {
  const nodes = new Map<string, GhPullRequestNode>();
  return async (args, root, options) => {
    if (options.operation === "graph-pr-list-nodes") {
      const ids = args.filter(arg => arg.startsWith("ids[]=")).map(arg => arg.slice(6));
      return JSON.stringify({ data: { nodes: ids.map(id => nodes.get(id) || null) } });
    }
    const output = await runner(args, root, options);
    if (options.operation !== "graph-pr-list-page") return output;
    const parsed = JSON.parse(output);
    const connection = parsed.data?.repository?.pullRequests;
    if (!Array.isArray(connection?.nodes)) return output;
    connection.nodes = connection.nodes.map((node: GhPullRequestNode) => {
      const complete = completeNode(node); nodes.set(complete.id!, complete); return complete;
    });
    connection.pageInfo ??= { hasNextPage: false };
    return JSON.stringify(parsed);
  };
}

/**
 * 기존 후속 페이지 검사를 실제 목록 서비스로 실행하되 metadata 응답만 fixture로 보완한다.
 * @param root·cursor·signal·runner·options 제품 서비스와 같은 인자이며 runner만 원격 fake다.
 * @returns 실제 목록 서비스가 검증·정규화·pagination을 마친 페이지
 */
export function fetchFixturePullRequestListPage(
  root: string, cursor?: string, signal?: AbortSignal, runner?: GhExecute, options?: PullRequestListOptions
): ReturnType<typeof fetchPullRequestListPage> {
  return fetchPullRequestListPage(root, cursor, signal, runner ? withPullRequestMetadata(runner) : undefined, options);
}
