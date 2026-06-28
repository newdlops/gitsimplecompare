// GitHub 웹 세션 쿠키를 VS Code SecretStorage 에 보관한다.
// - GitHub suggested changeset 은 REST/GraphQL 에 없고 github.com 웹 HTML 에만 서버 렌더링된다.
// - 쿠키 값은 민감 정보이므로 설정 파일이 아니라 SecretStorage 에 저장하고 로그에는 남기지 않는다.
import * as vscode from "vscode";
import { logInfo } from "./outputLog";

const GITHUB_WEB_COOKIE_SECRET_KEY = "gitSimpleCompare.githubWebCookie";

/**
 * SecretStorage 에 저장된 GitHub 웹 Cookie 헤더 값을 읽는다.
 * - 값이 비어 있으면 undefined 로 정규화해 호출부가 환경변수 fallback 을 사용할 수 있게 한다.
 * @param secrets VS Code 가 제공하는 확장 전용 SecretStorage
 * @returns 저장된 Cookie 헤더 값 또는 undefined
 */
export async function readStoredGitHubWebCookie(
  secrets: vscode.SecretStorage
): Promise<string | undefined> {
  return normalizeCookie(await secrets.get(GITHUB_WEB_COOKIE_SECRET_KEY));
}

/**
 * 사용자에게 GitHub 웹 Cookie 헤더 값을 입력받아 SecretStorage 에 저장한다.
 * - private PR 의 suggested changeset 은 GitHub OAuth token 만으로는 열리지 않을 수 있어 웹 세션 쿠키가 필요하다.
 * @param secrets VS Code 가 제공하는 확장 전용 SecretStorage
 * @returns 값이 저장되었으면 true, 취소되었으면 false
 */
export async function promptAndStoreGitHubWebCookie(
  secrets: vscode.SecretStorage
): Promise<boolean> {
  const value = await vscode.window.showInputBox({
    title: vscode.l10n.t("Login GitHub Web Session"),
    prompt: vscode.l10n.t(
      "Paste the github.com Cookie header or a copied cURL request."
    ),
    password: true,
    ignoreFocusOut: true,
    validateInput: validateCookie,
  });
  const cookie = normalizeCookie(value);
  if (!cookie) {
    return false;
  }
  return storeGitHubWebCookie(secrets, cookie, "manual");
}

/**
 * 클립보드에 복사된 GitHub cURL/Cookie 값을 자동으로 읽어 SecretStorage 에 저장한다.
 * - 사용자가 명령을 직접 실행한 순간에만 클립보드를 읽어 예기치 않은 백그라운드 수집을 피한다.
 * - 클립보드가 GitHub 웹 세션처럼 보이지 않으면 false 를 반환해 수동 입력 fallback 으로 넘어가게 한다.
 * @param secrets VS Code 가 제공하는 확장 전용 SecretStorage
 * @returns 클립보드 값이 유효해서 저장되었으면 true
 */
export async function storeGitHubWebCookieFromClipboard(
  secrets: vscode.SecretStorage
): Promise<boolean> {
  const value = await vscode.env.clipboard.readText();
  const cookie = normalizeCookie(value);
  if (!cookie || validateCookie(cookie)) {
    logInfo("github web cookie clipboard skipped", { reason: "noValidCookie" });
    return false;
  }
  return storeGitHubWebCookie(secrets, cookie, "clipboard");
}

/**
 * Cookie 헤더 값을 SecretStorage 에 저장한다.
 * - 자동 import 와 수동 입력 경로가 같은 검증/저장 로직을 쓰도록 분리한다.
 * @param secrets VS Code 가 제공하는 확장 전용 SecretStorage
 * @param value 저장할 Cookie 헤더 또는 추출 가능한 입력값
 * @param source 저장 경로를 설명하는 로그용 문자열
 * @returns 값이 저장되었으면 true
 */
export async function storeGitHubWebCookie(
  secrets: vscode.SecretStorage,
  value: string,
  source: string
): Promise<boolean> {
  const cookie = normalizeCookie(value);
  if (!cookie || validateCookie(cookie)) {
    return false;
  }
  await secrets.store(GITHUB_WEB_COOKIE_SECRET_KEY, cookie);
  logInfo("github web cookie stored", { source });
  vscode.window.showInformationMessage(
    vscode.l10n.t("GitHub web cookie saved for suggested changesets.")
  );
  return true;
}

/**
 * GitHub 웹 Cookie 입력값을 저장 전에 검사한다.
 * - webview 처럼 저장 UI 를 직접 그리는 호출부가 같은 검증 메시지를 재사용하게 한다.
 * @param value 사용자가 붙여넣은 Cookie 헤더 또는 cURL 요청
 * @returns 문제가 있으면 오류 메시지, 저장 가능하면 undefined
 */
export function validateGitHubWebCookieInput(
  value: string | undefined
): string | undefined {
  return validateCookie(value ?? "");
}

/**
 * SecretStorage 에 저장된 GitHub 웹 Cookie 헤더 값을 삭제한다.
 * @param secrets VS Code 가 제공하는 확장 전용 SecretStorage
 * @returns 삭제를 수행했으면 true
 */
export async function clearStoredGitHubWebCookie(
  secrets: vscode.SecretStorage
): Promise<boolean> {
  await secrets.delete(GITHUB_WEB_COOKIE_SECRET_KEY);
  logInfo("github web cookie cleared", { source: "secretStorage" });
  vscode.window.showInformationMessage(
    vscode.l10n.t("GitHub web cookie cleared.")
  );
  return true;
}

/**
 * Cookie 헤더 입력값을 저장 가능한 문자열로 정규화한다.
 * @param value 사용자가 입력했거나 SecretStorage 에 저장된 값
 * @returns 공백 제거 후 남는 Cookie 헤더 값
 */
function normalizeCookie(value: string | undefined): string | undefined {
  const extracted = extractCookieHeader(value);
  const trimmed = extracted?.trim().replace(/^Cookie:\s*/i, "");
  return trimmed || undefined;
}

/**
 * Cookie 헤더, raw header, `Copy as cURL` 입력에서 Cookie 값만 추출한다.
 * - 브라우저 쿠키를 자동으로 훔쳐올 수는 없지만, DevTools 에서 복사한 요청 전체를 붙여넣는 흐름은 지원한다.
 * @param value 사용자가 붙여넣은 문자열
 * @returns Cookie 헤더 값 또는 undefined
 */
function extractCookieHeader(value: string | undefined): string | undefined {
  const input = value?.trim();
  if (!input) {
    return undefined;
  }
  const rawHeader = /(?:^|\r?\n)\s*Cookie:\s*([^\r\n]+)/i.exec(input);
  if (rawHeader) {
    return rawHeader[1];
  }
  const curlHeader = /(?:^|\s)(?:-H|--header)\s+(['"])Cookie:\s*([\s\S]*?)\1/i.exec(input);
  if (curlHeader) {
    return unescapeShellCookie(curlHeader[2]);
  }
  const curlCookie = /(?:^|\s)(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/i.exec(input);
  if (curlCookie) {
    return unescapeShellCookie(curlCookie[2]);
  }
  return input.replace(/^Cookie:\s*/i, "");
}

/**
 * shell quoting 안에서 흔한 escape 를 Cookie 헤더 문자로 되돌린다.
 * @param value cURL 명령에서 추출한 quoted 문자열
 * @returns escape 를 일부 해제한 Cookie 값
 */
function unescapeShellCookie(value: string): string {
  return value
    .replace(/\\'/g, "'")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

/**
 * GitHub 웹 Cookie 헤더처럼 보이는지 최소한으로 검사한다.
 * - 쿠키 이름은 GitHub 변경 가능성이 있어 user_session 또는 _gh_sess 중 하나만 요구한다.
 * @param value 입력값
 * @returns 문제가 있으면 오류 메시지, 저장 가능하면 undefined
 */
function validateCookie(value: string): string | undefined {
  const trimmed = normalizeCookie(value);
  if (!trimmed) {
    return vscode.l10n.t("Cookie header is required.");
  }
  if (!/(^|;\s*)(user_session|__Host-user_session_same_site|_gh_sess)=/.test(trimmed)) {
    return vscode.l10n.t("Paste a github.com Cookie header.");
  }
  return undefined;
}
