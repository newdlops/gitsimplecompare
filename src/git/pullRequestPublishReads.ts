// 게시 전 중복 확인과 생성 후 metadata 조회를 서로 다른 최신 읽기 세션으로 실행한다.
import type { GhExecute } from "./ghRunner";
import { createGitHubReadSession, completeGitHubReadSession } from "./githubReadSession";
import { graphQLRequest } from "./githubReadRequest";

/** 생성 직후 공통 DTO를 보완하는 GitHub metadata. 쓰기 결과의 fallback 값은 호출부가 소유한다. */
export interface PublishedPullRequestMetadata {
  number?: number; title?: string; state?: string; url?: string;
  headRefName?: string; headRefOid?: string; baseRefName?: string; baseRefOid?: string;
  author?: { login?: string }; isDraft?: boolean; reviewDecision?: string; updatedAt?: string;
}
interface OpenPullRequest { number?: number; url?: string; }

/**
 * 현재 head의 열린 PR을 새 인증 세션으로 확인한다. 완료 결과를 다음 게시에 캐시하지 않는다.
 * @param root 게시할 저장소, head gh --head와 같은 source branch, execute 읽기 transport
 * @returns 중복 PR의 번호/URL 또는 없음. 조회 오류는 중복 없음으로 숨기지 않는다.
 */
export async function readOpenPublishPullRequest(root: string, head: string, execute: GhExecute): Promise<OpenPullRequest | undefined> {
  const runner = createGitHubReadSession(root, execute);
  const query = `query($owner: String!, $name: String!, $head: String!) {
    repository(owner: $owner, name: $name) { pullRequests(first: 1, states: OPEN, headRefName: $head) { nodes { number url } } }
  }`;
  const output = await runner(["pr", "list", "--state", "open", "--head", head,
    "--json", "number,url", "--limit", "1"], root, { operation: "pr-publish-preflight",
    request: graphQLRequest(query, { owner: "{owner}", name: "{repo}", head }) });
  const value = JSON.parse(output);
  const nodes = Array.isArray(value) ? value : value.data?.repository?.pullRequests?.nodes;
  if (value.errors?.length || !Array.isArray(nodes) || nodes.some(node => !node || !Number.isSafeInteger(node.number) || node.number < 1)) {
    throw new Error("GitHub pull request duplicate check is incomplete.");
  }
  await completeGitHubReadSession(runner);
  return nodes[0];
}

/**
 * 생성 결과 URL이 가리키는 정확한 PR을 읽는다. Enterprise/비표준 URL은 기존 CLI 해석을 보존한다.
 * @param root 게시 저장소, head URL 해석이 불가능할 때의 기존 branch 힌트, createdUrl 쓰기 결과 URL
 * @returns GraphQL/CLI 공통 metadata. 후속 실패의 게시 성공 fallback은 호출부에서 처리한다.
 */
export async function readCreatedPullRequest(root: string, head: string, createdUrl: string, execute: GhExecute): Promise<PublishedPullRequestMetadata> {
  const runner = createGitHubReadSession(root, execute);
  const identity = createdIdentity(createdUrl);
  const fields = "number title state url headRefName headRefOid baseRefName baseRefOid author { login } isDraft reviewDecision updatedAt";
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${fields} } }
  }`;
  const output = await runner(["pr", "view", identity ? createdUrl : head, "--json",
    "number,title,state,url,headRefName,headRefOid,baseRefName,baseRefOid,author,isDraft,reviewDecision,updatedAt"], root,
    { operation: "pr-publish-created", ...(identity ? { request: graphQLRequest(query, identity) } : {}) });
  const response = JSON.parse(output);
  const value = response.data ? response.data.repository?.pullRequest : response;
  if (response.errors?.length || !value || !Number.isSafeInteger(value.number) || value.number < 1
    || identity && (value.number !== identity.number || value.url !== createdUrl)) {
    throw new Error("Created GitHub pull request metadata is incomplete.");
  }
  await completeGitHubReadSession(runner);
  return value;
}

/** GitHub.com 표준 생성 URL만 typed query로 바꾸며 다른 host를 github.com API로 보내지 않는다. */
function createdIdentity(value: string): { owner: string; name: string; number: number } | undefined {
  try {
    const url = new URL(value), match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password
      || url.search || url.hash || !match || !Number.isSafeInteger(Number(match[3]))) return undefined;
    return { owner: match[1], name: match[2], number: Number(match[3]) };
  } catch { return undefined; }
}
