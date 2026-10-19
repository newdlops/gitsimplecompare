// 충돌 이력의 commit → PR 연결과 명시된 선행 PR을 한정된 GraphQL 묶음으로 조회한다.
import { readGitHub, type GitHubReadOptions } from "./githubReadCache";
import type { GhExecute } from "./ghRunner";
import { pullRequestInfoFromGraphQl, type GhPullRequestNode, type PullRequestInfo } from "./pullRequestInfo";

interface Node extends GhPullRequestNode { body?: string }
interface LookupRepository {
  current?: Node;
  parents?: { nodes?: Node[] };
  [key: string]: unknown;
}
export interface PullRequestDependencyLookup {
  parents: PullRequestInfo[];
  associated: Map<string, PullRequestInfo[]>;
  declared: number[];
}
const BASIC = "number title state url headRefName headRefOid baseRefName baseRefOid mergeCommit { oid }";
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/**
 * 원본 이력에서 고른 최대 12개 commit과 PR base를 한 네트워크 요청으로 연결한다.
 * @param root gh가 저장소를 해석할 루트 @param pr 진단할 PR @param commits 로컬에서 검증한 전체 OID
 * @param signal 조회 취소 신호 @param execute 테스트용 읽기 실행기
 * @returns parent branch PR, commit별 관련 PR과 본문에 명시된 같은 저장소 PR 번호
 */
export async function lookupPullRequestDependencies(root: string, pr: PullRequestInfo, commits: string[],
  signal?: AbortSignal, execute: GhExecute = readGitHub): Promise<PullRequestDependencyLookup> {
  const selected = [...new Set(commits)].filter(hash => OID.test(hash)).slice(0, 12);
  const fields = selected.map((hash, index) => `c${index}: object(oid: "${hash}") {
    ... on Commit { associatedPullRequests(first: 2) { nodes { ${BASIC} } } }
  }`).join("\n");
  const query = `query($owner:String!,$name:String!,$number:Int!,$base:String!) {
    repository(owner:$owner,name:$name) {
      current:pullRequest(number:$number) { headRefOid body }
      parents:pullRequests(headRefName:$base,first:3,states:[OPEN,MERGED]) { nodes { ${BASIC} } }
      ${fields}
    }
  }`;
  const options: GitHubReadOptions = { operation: "pr-prerequisite-discovery", signal, ttlMs: 30_000,
    version: JSON.stringify([pr.headHash, pr.baseRefName, selected]) };
  const output = await execute(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}",
    "-F", `number=${pr.number}`, "-f", `base=${pr.baseRefName}`, "-f", `query=${query}`], root, options);
  const repository = parseRepository(output);
  // 새 PR 내용을 예전 OID의 진단 근거로 섞지 않는다.
  if (pr.headHash && repository.current?.headRefOid !== pr.headHash) throw new Error("PR changed during prerequisite discovery.");
  const associated = new Map<string, PullRequestInfo[]>();
  for (let index = 0; index < selected.length; index++) {
    const node = repository[`c${index}`] as { associatedPullRequests?: { nodes?: Node[] } } | undefined;
    associated.set(selected[index], normalize(node?.associatedPullRequests?.nodes));
  }
  return { associated, parents: normalize(repository.parents?.nodes),
    declared: declaredPrerequisites(repository.current?.body || "", pr.url, pr.number) };
}

/**
 * 진단 후보 최대 4개의 전체 첫 commit 페이지를 함께 읽는다. 후속 페이지는 임의로 추정하지 않는다.
 * @param numbers 명시된 선행 또는 로컬 목록에 없는 후보 번호 @returns 번호별 최신 PR 정보
 */
export async function lookupPullRequestDependencyDetails(root: string, numbers: number[], signal?: AbortSignal,
  execute: GhExecute = readGitHub): Promise<PullRequestInfo[]> {
  const selected = [...new Set(numbers)].filter(number => Number.isSafeInteger(number) && number > 0).slice(0, 4);
  if (!selected.length) return [];
  const fields = selected.map(number => `p${number}:pullRequest(number:${number}) { ${BASIC}
    commits(first:100) { nodes { commit { oid } } pageInfo { hasNextPage } }
  }`).join("\n");
  const options: GitHubReadOptions = { operation: "pr-prerequisite-details", signal, ttlMs: 30_000 };
  const output = await execute(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f",
    `query=query($owner:String!,$name:String!) { repository(owner:$owner,name:$name) { ${fields} } }`], root, options);
  const repository = parseRepository(output);
  return selected.flatMap(number => {
    const node = repository[`p${number}`] as Node | undefined;
    return node ? [pullRequestInfoFromGraphQl(node)] : [];
  });
}

/** 기본 정보만 받은 PR을 전체 commit 목록으로 잘못 간주하지 않게 표시한다. */
function normalize(nodes?: Node[]): PullRequestInfo[] {
  return (nodes || []).filter(node => Number.isSafeInteger(node.number) && node.number! > 0)
    .map(node => ({ ...pullRequestInfoFromGraphQl(node), commitHashesComplete: false }));
}

/** 부분 GraphQL 오류를 완전한 빈 결과로 숨기지 않는다. */
function parseRepository(output: string): LookupRepository {
  const response = JSON.parse(output) as { data?: { repository?: LookupRepository }; errors?: unknown[] };
  if (response.errors?.length || !response.data?.repository) throw new Error("Cannot read PR prerequisite metadata.");
  return response.data.repository;
}

/**
 * 명시적인 의존 문장만 읽고 일반 PR 링크·이슈 번호·다른 저장소 링크는 후보로 오인하지 않는다.
 * @param body GitHub 본문 @param url 현재 PR URL @param current 자기 참조를 제외할 번호
 */
export function declaredPrerequisites(body: string, url: string, current: number): number[] {
  let prefix: string;
  try { const parsed = new URL(url); prefix = `${parsed.origin}${parsed.pathname.replace(/\/pull\/\d+\/?$/, "")}/pull/`; }
  catch { return []; }
  const result = new Set<number>();
  for (const line of body.split(/\r?\n/).slice(0, 300)) {
    if (!/(?:depends[ -]+on|requires\s+(?:PR|#)|선행\s*PR|의존\s*PR)\s*[:：]?/i.test(line)) continue;
    const safe = line.replace(/https?:\/\/[^\s)<>]+/g, link => link.startsWith(prefix) ? `#${link.slice(prefix.length).match(/^\d+/)?.[0] || ""}` : "");
    for (const match of safe.matchAll(/(?:^|[\s,:;(\[])#([1-9]\d*)\b/g)) {
      const number = Number(match[1]);
      if (Number.isSafeInteger(number) && number !== current) result.add(number);
      if (result.size >= 4) return [...result];
    }
  }
  return [...result];
}
