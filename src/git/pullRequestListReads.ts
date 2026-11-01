// 목록 identity 뒤의 20개 metadata 조회와 immutable 재사용 검증을 독립적으로 조립한다.
import type { GhExecute } from "./ghRunner";
import { graphQLRequest } from "./githubReadRequest";
import { buildPullRequestInfoQuery, type GhPullRequestNode } from "./pullRequestInfo";
import { canReuseStableConnections, type StablePullRequestSnapshot } from "./githubCommitSnapshots";

export const PULL_REQUEST_METADATA_BATCH_SIZE = 20;

/** identity를 먼저 표시하는 root query는 warm/cold 모두 중첩 가변 연결을 펼치지 않는다. */
export function buildPullRequestListIdentityQuery(summary: string, anchors: boolean): string {
  return `query($owner: String!, $name: String!, $limit: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) { nameWithOwner url defaultBranchRef { name }
      pullRequests(first: $limit, after: $cursor, states: [OPEN, CLOSED, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes { id ${summary} ${anchors ? "headRefOid baseRefOid" : ""} } pageInfo { hasNextPage endCursor }
      }
    }
  }`;
}

/**
 * 작은 metadata 묶음을 조회해 최신 가변 연결과 검증된 불변 연결을 같은 node로 반환한다.
 * @param references 최신 root identity, known 현재 인증에서 검증한 commit/file snapshot
 * @param onBatch 완료 묶음을 먼저 알려 다른 느린 metadata와 독립적으로 pagination을 시작한다.
 * @returns root 순서대로 완전한 connection을 가진 node. 앵커 변화는 한 번만 보완한다.
 */
export async function readPullRequestNodes(root: string, references: Array<GhPullRequestNode | null>, controller: AbortController,
  runner: GhExecute, onBatch: (nodes: GhPullRequestNode[], offset: number) => void,
  known: ReadonlyMap<number, StablePullRequestSnapshot> = new Map()): Promise<GhPullRequestNode[]> {
  const ids = references.map(node => node?.id);
  if (ids.some(id => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error("GitHub pull request identities are not available.");
  }
  const output = new Array<GhPullRequestNode>(references.length);
  let failure: { error: unknown } | undefined;
  const tasks: Promise<void>[] = [];
  for (let offset = 0; offset < references.length; offset += PULL_REQUEST_METADATA_BATCH_SIZE) {
    const batch = references.slice(offset, offset + PULL_REQUEST_METADATA_BATCH_SIZE) as GhPullRequestNode[];
    tasks.push((async () => {
      const reusable = batch.filter(node => canReuseStableConnections(node, known.get(node.number!)));
      let current: GhPullRequestNode[];
      if (reusable.length && reusable.length < batch.length) {
        current = await readMixedNodeBatch(root, batch, reusable, controller.signal, runner);
      } else current = await readNodeBatch(root, batch, controller.signal, runner, !reusable.length);
      for (let index = 0; index < batch.length; index++) {
        let node = current[index];
        if (canReuseStableConnections(batch[index], known.get(batch[index].number!))) {
          if (!hasMutableNodeConnections(node)) throw incomplete();
          if (sameAnchor(node, batch[index])) node = withStableConnections(node, known.get(node.number!)!);
          else {
            // 앵커가 바뀐 해당 PR만 새 연결을 한 번 읽는다. 다시 바뀌면 혼합 snapshot을 게시하지 않는다.
            const [repaired] = await readNodeBatch(root, [node], controller.signal, runner, true);
            if (!sameAnchor(repaired, node)) throw new Error("Pull request head/base changed again while loading metadata. Refresh to try again.");
            node = repaired;
          }
        }
        if (!hasPullRequestNodeConnections(node)) throw incomplete();
        current[index] = node; output[offset + index] = node;
      }
      controller.signal.throwIfAborted(); onBatch(current, offset);
    })().catch(error => { failure ??= { error }; controller.abort(); }));
  }
  await Promise.allSettled(tasks);
  if (failure) throw failure.error;
  controller.signal.throwIfAborted(); return output;
}

/** global ID·PR 번호를 검증하며 기존 CLI 인자 순서를 유지한 typed query를 만든다. */
async function readNodeBatch(root: string, references: readonly GhPullRequestNode[], signal: AbortSignal,
  runner: GhExecute, stable: boolean): Promise<GhPullRequestNode[]> {
  signal.throwIfAborted();
  const ids = references.map(node => node.id!);
  const query = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest { id ${buildPullRequestInfoQuery(100, 100, stable)} } } }`;
  const output = await runner(["api", "graphql", ...ids.flatMap(id => ["-F", `ids[]=${id}`]), "-f", `query=${query}`], root,
    { signal, operation: "graph-pr-list-nodes", request: graphQLRequest(query, { ids }) });
  signal.throwIfAborted();
  const response = JSON.parse(output) as { errors?: unknown[]; data?: { nodes?: Array<GhPullRequestNode | null> } };
  if (response.errors?.length) throw new Error("GitHub pull request information is not available.");
  return validateNodeBatch(response.data?.nodes, references);
}

/**
 * 한 HTTP query에서 warm/cold 필드를 분리해 안정 연결은 필요한 PR에만 요청한다.
 * @param references 원래 순서의 묶음, warm 현재 인증에서 재사용 가능한 항목
 * @returns 두 alias의 identity를 각각 검증한 뒤 원래 순서로 합친 metadata
 */
async function readMixedNodeBatch(root: string, references: readonly GhPullRequestNode[], warm: readonly GhPullRequestNode[],
  signal: AbortSignal, runner: GhExecute): Promise<GhPullRequestNode[]> {
  signal.throwIfAborted();
  const warmIds = warm.map(node => node.id!), warmSet = new Set(warmIds);
  const cold = references.filter(node => !warmSet.has(node.id!)), coldIds = cold.map(node => node.id!);
  const query = `query($warmIds: [ID!]!, $coldIds: [ID!]!) {
    warm: nodes(ids: $warmIds) { ... on PullRequest { id ${buildPullRequestInfoQuery(100, 100, false)} } }
    cold: nodes(ids: $coldIds) { ... on PullRequest { id ${buildPullRequestInfoQuery(100, 100, true)} } }
  }`;
  const output = await runner(["api", "graphql", ...warmIds.flatMap(id => ["-F", `warmIds[]=${id}`]),
    ...coldIds.flatMap(id => ["-F", `coldIds[]=${id}`]), "-f", `query=${query}`], root,
    { signal, operation: "graph-pr-list-nodes", request: graphQLRequest(query, { warmIds, coldIds }) });
  signal.throwIfAborted();
  const response = JSON.parse(output);
  if (response.errors?.length) throw new Error("GitHub pull request information is not available.");
  const values = new Map([...validateNodeBatch(response.data?.warm, warm), ...validateNodeBatch(response.data?.cold, cold)]
    .map(node => [node.id, node]));
  return references.map(node => values.get(node.id)!);
}

/** 원격 배열의 순서에 의존하지 않고 요청한 ID/PR 번호와 완전성을 검사한다. alias 간 교환도 거절한다. */
function validateNodeBatch(nodes: unknown, references: readonly GhPullRequestNode[]): GhPullRequestNode[] {
  const ids = references.map(node => node.id!);
  if (!Array.isArray(nodes) || nodes.length !== ids.length) {
    throw new Error("GitHub pull request information is not available.");
  }
  const byId = new Map<string, GhPullRequestNode>(), numbers = new Map(references.map(node => [node.id, node.number]));
  for (const node of nodes) {
    if (!node?.id || !ids.includes(node.id) || byId.has(node.id) || !Number.isSafeInteger(node.number) || Number(node.number) <= 0
      || node.number !== numbers.get(node.id)) throw new Error("GitHub pull request identity is incomplete.");
    byId.set(node.id, node);
  }
  return ids.map(id => byId.get(id)!);
}

/** 최신 node에 같은 앵커의 원래 commit 요약/파일 수만 합치며 가변 metadata는 덮어쓰지 않는다. */
export function withStableConnections(node: GhPullRequestNode, known: StablePullRequestSnapshot): GhPullRequestNode {
  const summaries = new Map(known.commitSummaries?.map(summary => [summary.hash, summary]));
  return { ...node, files: { totalCount: known.fileCount }, commits: {
    nodes: known.commitHashes.map(oid => { const summary = summaries.get(oid)!;
      return { commit: { oid, messageHeadline: summary.title, committedDate: summary.dateIso,
        author: summary.author ? { name: summary.author } : undefined } }; }), pageInfo: { hasNextPage: false } } };
}

/** metadata를 받은 뒤에도 완전한 commit/review/file 연결을 확인한다. */
export function hasPullRequestNodeConnections(node: GhPullRequestNode): boolean {
  return Array.isArray(node.commits?.nodes) && typeof node.commits?.pageInfo?.hasNextPage === "boolean"
    && hasMutableNodeConnections(node) && Number.isSafeInteger(node.files?.totalCount) && Number(node.files?.totalCount) >= 0;
}
/** 댓글·리뷰 합계는 과거 snapshot을 사용하지 않고 현재 응답에서 실제로 받아야 한다. */
export function hasMutableNodeConnections(node: GhPullRequestNode): boolean {
  return Array.isArray(node.reviewThreads?.nodes) && typeof node.reviewThreads?.pageInfo?.hasNextPage === "boolean"
    && Number.isSafeInteger(node.comments?.totalCount) && Number(node.comments?.totalCount) >= 0;
}
/** 재사용 판단에 필요한 head/base/대상 branch를 동시에 비교한다. */
export function sameAnchor(left: GhPullRequestNode, right: GhPullRequestNode): boolean {
  return left.headRefOid === right.headRefOid && left.baseRefOid === right.baseRefOid && left.baseRefName === right.baseRefName;
}
/** 원문을 포함하지 않는 재시도 가능한 연결 누락 오류다. */
function incomplete(): Error { return new Error("GitHub pull request information is incomplete."); }
