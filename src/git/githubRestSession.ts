// 고정 read session의 canonical 저장소로 REST 경로와 Enterprise Link 기준 origin을 결정한다.
import type { GhExecute } from "./ghRunner";
import { gitHubReadSessionState } from "./githubReadSession";
import { GitHubRepositoryScopes, type GitHubRepositoryScope } from "./githubRepositoryScope";
import { GitHubRestPageError } from "./githubRestPages";

/**
 * 아직 전역에 게시하지 않은 같은 세션의 canonical 응답을 검증해 반환한다.
 * @param execute 고정 세션 실행기 @returns 검증된 host/owner/repository. remote URL로 추측하지 않는다.
 */
export function readSessionRepository(execute: GhExecute): GitHubRepositoryScope {
  const state = gitHubReadSessionState(execute);
  if (state?.candidate) {
    const validation = new GitHubRepositoryScopes();
    if (!validation.learn("session", "candidate", state.candidate)) throw new GitHubRestPageError("metadata");
    return validation.get("session", "candidate")!;
  }
  if (state?.scope) return state.scope;
  throw new GitHubRestPageError("metadata");
}

/**
 * gh RESTPrefix 규칙을 따라 github.com/GHE.com과 Enterprise Server의 Link base를 나눈다.
 * @param execute canonical scope가 고정된 실행기 @returns 끝 slash 없는 HTTPS API 기준 주소
 */
export function readSessionRestApiBase(execute: GhExecute): string {
  const { host } = readSessionRepository(execute);
  return host === "github.com" || host.endsWith(".ghe.com") ? `https://api.${host}` : `https://${host}/api/v3`;
}
