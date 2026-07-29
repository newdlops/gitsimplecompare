import * as vscode from "vscode";
import { nonceValue } from "./nonce";
import { pullRequestPreviewI18n, type PullRequestPreviewI18n } from "./pullRequestPreviewI18n";
import { pullRequestPreviewScript } from "./pullRequestPreviewScript";
import { pullRequestPreviewStyles } from "./pullRequestPreviewStyles";
import { sharedWebviewResources, sharedWebviewScriptTags, sharedWebviewStyleTags } from "./sharedWebviewResources";

/** HTML 속성과 텍스트 삽입 시 웹뷰 셸이 깨지지 않도록 값을 이스케이프한다. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
}

/**
 * PR 생성 preview의 CSP 안전 HTML 셸을 만든다.
 * @param extensionUri 확장 리소스의 기준 URI
 * @param webview 리소스 URI와 CSP source를 제공하는 웹뷰
 * @param text 테스트에서 주입하거나 로케일 기본값으로 사용할 Preview 문자열
 * @returns 웹뷰에 할당할 완성 HTML
 */
export function buildPullRequestPreviewHtml(extensionUri: vscode.Uri, webview: vscode.Webview, text: PullRequestPreviewI18n = pullRequestPreviewI18n()): string {
  const nonce = nonceValue();
  const resources = sharedWebviewResources(webview, extensionUri);
  const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "codicons", "codicon.css"));
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}`;
  const iconButton = (id: string, icon: string, label: string) => `<button id="${id}" class="gsc-icon-button" type="button" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" data-tooltip="${escapeHtml(label)}"><span class="codicon codicon-${icon}" aria-hidden="true"></span></button>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link href="${codiconUri}" rel="stylesheet">${sharedWebviewStyleTags(resources)}<style nonce="${nonce}">${pullRequestPreviewStyles()}</style><title>${escapeHtml(text.title)}</title></head><body class="gsc-surface"><header class="topbar"><div class="topbar-title"><span class="codicon codicon-git-pull-request" aria-hidden="true"></span><h1>${escapeHtml(text.title)}</h1></div><div class="actions">${iconButton("refresh", "refresh", text.refresh)}${iconButton("generate-pr-message", "comment-discussion-sparkle", text.generate)}${iconButton("configure-ai-cli", "settings-gear", text.configure)}${iconButton("copy-pr-message", "copy", text.copy)}<button id="publish-pr" class="gsc-button gsc-button--primary publish-button" type="button" title="${escapeHtml(text.create)}" aria-label="${escapeHtml(text.create)}" data-tooltip="${escapeHtml(text.create)}" disabled><span class="codicon codicon-cloud-upload" aria-hidden="true"></span><span class="publish-label">${escapeHtml(text.create)}</span></button><button id="open-pr" class="gsc-button gsc-button--primary" type="button" title="${escapeHtml(text.openGitHub)}" aria-label="${escapeHtml(text.openGitHub)}" data-tooltip="${escapeHtml(text.openGitHub)}" hidden>${escapeHtml(text.openGitHub)}</button></div></header><main id="content" aria-live="polite"><p class="placeholder">${escapeHtml(text.loading)}</p></main>${sharedWebviewScriptTags(resources, nonce)}<script nonce="${nonce}">${pullRequestPreviewScript(text)}</script></body></html>`;
}
