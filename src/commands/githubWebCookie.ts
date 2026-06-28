// GitHub PR suggested changeset 표시용 웹 쿠키 설정 명령.
// - 실제 suggested changeset 데이터는 GitHub 웹 HTML 에만 있으므로, private PR 에서는 웹 세션 쿠키가 필요할 수 있다.
// - 명령 레이어는 입력/삭제 UI 만 담당하고, 값 보관은 ui/githubWebCookieSecret 에 위임한다.
import { CommandDeps } from "./shared";
import { clearStoredGitHubWebCookie } from "../ui/githubWebCookieSecret";
import { GitHubWebSessionPanel } from "../webview/githubWebSessionPanel";

/**
 * GitHub 웹 세션 설정 패널을 연다.
 * - 사용자가 명시적으로 붙여넣거나 클립보드 사용 버튼을 누른 값만 SecretStorage 에 저장한다.
 * @param deps 명령 공통 의존성
 */
export function setGitHubWebCookie(deps: CommandDeps): void {
  GitHubWebSessionPanel.createOrShow(
    deps.secrets,
    (reason) => deps.refreshPullRequestComments(reason)
  );
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
