// 웹뷰 정적 리소스 URI 에 캐시 버전과 CSP nonce 를 붙이는 공용 헬퍼.
// - provider 본문에서 파일 시스템 세부 처리를 분리해 HTML 조립 코드의 책임을 줄인다.
import * as fs from "fs";
import * as vscode from "vscode";

/**
 * 여러 정적 리소스의 최신 수정 시각을 기준으로 캐시 버전 문자열을 만든다.
 * - 하나라도 수정되면 query 값이 바뀌어 VS Code 웹뷰 캐시가 새 파일을 읽는다.
 * @param uris 버전 계산에 포함할 로컬 파일 URI 목록
 * @returns query 에 넣을 버전 문자열
 */
export function resourceVersion(uris: vscode.Uri[]): string {
  return String(Math.max(...uris.map(fileMtime)));
}

/**
 * URI 에 query 버전을 붙여 VS Code 웹뷰의 정적 리소스 캐시를 회피한다.
 * @param uri 원본 리소스 URI
 * @param version 캐시 구분용 버전 문자열
 */
export function withVersion(uri: vscode.Uri, version: string): vscode.Uri {
  return uri.with({ query: `v=${version}` });
}

/**
 * CSP 의 script nonce(1회성 난수 문자열)를 만든다.
 * @returns script-src nonce 에 사용할 임의 문자열
 */
export function makeNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * 파일 수정 시각을 읽는다. 실패하면 현재 시각을 써서 캐시에 갇히지 않게 한다.
 * @param uri 로컬 파일 URI
 * @returns mtimeMs 또는 fallback 현재 시각
 */
function fileMtime(uri: vscode.Uri): number {
  try {
    return fs.statSync(uri.fsPath).mtimeMs;
  } catch {
    return Date.now();
  }
}
