// PR commit connection을 동일 head의 완전한 순서 목록으로 완성한다.
import { runGh } from "./ghCli";
import type { GhExecute } from "./ghRunner";
import type { GhPullRequestNode, PullRequestInfo } from "./pullRequestInfo";

const QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    headRefOid
    commits(first: 100, after: $cursor) { nodes { commit { oid } } pageInfo { hasNextPage endCursor } }
  } }
}`;

/**
 * 첫 페이지의 head를 고정하고 후속 commit 페이지를 원래 순서로 완성한다.
 * @param node GitHub가 반환한 첫 commit connection과 head OID
 * @param result 성공 시에만 완성된 커밋 집합을 기록할 PR 정보
 * @param signal 호출 수명과 함께 취소할 신호
 * @param runner 시간 상한·동시 실행 정책이 적용된 조회 실행기
 * @returns 페이지 오류나 head 변경은 불완전한 집합을 게시하지 않고 전달한다.
 */
export async function completePullRequestCommits(
  root: string, owner: string, name: string, node: GhPullRequestNode,
  result: PullRequestInfo, signal?: AbortSignal, runner: GhExecute = runGh
): Promise<void> {
  let page = node.commits?.pageInfo;
  if (!page?.hasNextPage) return;
  if (!node.headRefOid || !Number.isInteger(node.number) || Number(node.number) <= 0) {
    throw new Error("Cannot verify the pull request commit snapshot. Refresh pull requests.");
  }
  const hashes = new Set((node.commits?.nodes || []).map(entry => entry.commit?.oid || "").filter(Boolean));
  const cursors = new Set<string>();
  while (page.hasNextPage) {
    signal?.throwIfAborted();
    const cursor = page.endCursor;
    if (!cursor || cursors.has(cursor)) throw new Error("GitHub pull request commit pagination did not advance.");
    cursors.add(cursor);
    const output = await runner(["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`,
      "-F", `number=${node.number}`, "-f", `cursor=${cursor}`, "-f", `query=${QUERY}`], root,
      { signal, operation: "graph-pr-commit-page" });
    signal?.throwIfAborted();
    const current = (JSON.parse(output) as { data?: { repository?: { pullRequest?: GhPullRequestNode } } }).data?.repository?.pullRequest;
    if (current?.headRefOid !== node.headRefOid) throw new Error(`PR #${node.number} head changed while reading commits. Refresh pull requests.`);
    const connection = current.commits;
    if (!connection?.nodes || typeof connection.pageInfo?.hasNextPage !== "boolean") {
      throw new Error("GitHub returned an incomplete pull request commit page.");
    }
    for (const entry of connection.nodes) {
      if (!entry.commit?.oid) throw new Error("GitHub returned an invalid pull request commit.");
      hashes.add(entry.commit.oid);
    }
    page = connection.pageInfo;
  }
  hashes.add(node.headRefOid);
  result.commitHashes = [...hashes];
  result.commitHashesComplete = true;
}

/** 제한된 worker로 독립 PR read를 수행하고 취소 이후 새 작업은 시작하지 않는다. */
export async function mapPullRequestReads<T, R>(values: readonly T[], read: (value: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const result: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (next < values.length) { signal?.throwIfAborted(); const index = next++; result[index] = await read(values[index]); }
  }));
  return result;
}
