// GitHub PR suggested changeset 표시용 웹 쿠키 설정 명령.
// - 실제 suggested changeset 데이터는 GitHub 웹 HTML 에만 있으므로, private PR 에서는 웹 세션 쿠키가 필요할 수 있다.
// - 명령 레이어는 입력/삭제 UI 만 담당하고, 값 보관은 ui/githubWebCookieSecret 에 위임한다.
import { CommandDeps } from "./shared";
import {
  clearStoredGitHubWebCookie,
  promptAndStoreGitHubWebCookie,
} from "../ui/githubWebCookieSecret";

/**
 * GitHub 웹 Cookie 헤더를 SecretStorage 에 저장한다.
 * - 저장 뒤 PR comment 캐시를 무효화해 현재 에디터에서 suggested changeset 을 즉시 다시 읽게 한다.
 * @param deps 명령 공통 의존성
 */
export async function setGitHubWebCookie(deps: CommandDeps): Promise<void> {
  const stored = await promptAndStoreGitHubWebCookie(deps.secrets);
  if (stored) {
    deps.refreshPullRequestComments("githubWebCookieStored");
  }
}

/**
 * SecretStorage 에 저장된 GitHub 웹 Cookie 헤더를 삭제한다.
 * - 삭제 뒤 PR comment 캐시를 무효화해 다음 조회가 쿠키 없이 동작하도록 한다.
 * @param deps 명령 공통 의존성
 */
export async function clearGitHubWebCookie(deps: CommandDeps): Promise<void> {
  await clearStoredGitHubWebCookie(deps.secrets);
  deps.refreshPullRequestComments("githubWebCookieCleared");
}
