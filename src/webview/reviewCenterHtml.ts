// Review Center 편집기 웹뷰의 보안 HTML 셸.
// - CSP/공유 토큰/정적 resource URI를 panel lifecycle 코드와 분리한다.
import * as vscode from "vscode";
import {
  sharedWebviewResources,
  sharedWebviewScriptTags,
  sharedWebviewStyleTags,
} from "./sharedWebviewResources";
import { reviewCenterI18n } from "./reviewCenterI18n";
import { makeNonce, resourceVersion, withVersion } from "./webviewResourceVersion";

/**
 * Review Center가 표시할 HTML 문서를 만든다.
 * @param extensionUri 확장 media 경로의 기준 URI
 * @param webview      CSP source와 resource URI를 제공하는 대상 웹뷰
 * @returns strict CSP가 적용된 완성 HTML
 */
export function buildReviewCenterHtml(
  extensionUri: vscode.Uri,
  webview: vscode.Webview,
  reviewWritesEnabled = false
): string {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media", "review-center");
  const files = [
    vscode.Uri.joinPath(mediaRoot, "reviewCenter.css"),
    vscode.Uri.joinPath(mediaRoot, "reviewCenterDraft.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewCenterFileComment.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewCenterLineComment.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewCenterThreadReply.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewCenterCommentActions.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewCenterSuggestionApply.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewCenterCommits.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewCenterChecks.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewCenterManagement.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewCenterActivity.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewCenterKeyboard.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewCenterFormat.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewCenterFiles.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewCenter.js"),
  ];
  const version = resourceVersion(files);
  const styleUri = webview.asWebviewUri(withVersion(files[0], version));
  const draftScriptUri = webview.asWebviewUri(withVersion(files[1], version));
  const fileCommentScriptUri = webview.asWebviewUri(withVersion(files[2], version));
  const lineCommentScriptUri = webview.asWebviewUri(withVersion(files[3], version));
  const threadReplyScriptUri = webview.asWebviewUri(withVersion(files[4], version));
  const commentActionsScriptUri = webview.asWebviewUri(withVersion(files[5], version));
  const suggestionApplyScriptUri = webview.asWebviewUri(withVersion(files[6], version));
  const commitsScriptUri = webview.asWebviewUri(withVersion(files[7], version));
  const checksScriptUri = webview.asWebviewUri(withVersion(files[8], version));
  const managementScriptUri = webview.asWebviewUri(withVersion(files[9], version));
  const activityScriptUri = webview.asWebviewUri(withVersion(files[10], version));
  const keyboardScriptUri = webview.asWebviewUri(withVersion(files[11], version));
  const formatScriptUri = webview.asWebviewUri(withVersion(files[12], version));
  const filesScriptUri = webview.asWebviewUri(withVersion(files[13], version));
  const scriptUri = webview.asWebviewUri(withVersion(files[14], version));
  const shared = sharedWebviewResources(webview, extensionUri);
  const nonce = makeNonce();
  const csp = ["default-src 'none'", `style-src ${webview.cspSource}`, `script-src 'nonce-${nonce}'`].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  ${sharedWebviewStyleTags(shared)}
  <link href="${styleUri}" rel="stylesheet" />
  <title>Review Center</title>
</head>
<body class="gsc-surface">
  <main id="root" class="review-center"></main>
  <script nonce="${nonce}">window.__gscReviewCenterI18n=${JSON.stringify(reviewCenterI18n())};window.__gscReviewWritesEnabled=${JSON.stringify(reviewWritesEnabled)};</script>
  ${sharedWebviewScriptTags(shared, nonce)}
  <script nonce="${nonce}" src="${draftScriptUri}"></script>
  <script nonce="${nonce}" src="${fileCommentScriptUri}"></script>
  <script nonce="${nonce}" src="${lineCommentScriptUri}"></script>
  <script nonce="${nonce}" src="${threadReplyScriptUri}"></script>
  <script nonce="${nonce}" src="${commentActionsScriptUri}"></script>
  <script nonce="${nonce}" src="${suggestionApplyScriptUri}"></script>
  <script nonce="${nonce}" src="${commitsScriptUri}"></script>
  <script nonce="${nonce}" src="${checksScriptUri}"></script>
  <script nonce="${nonce}" src="${managementScriptUri}"></script>
  <script nonce="${nonce}" src="${activityScriptUri}"></script>
  <script nonce="${nonce}" src="${keyboardScriptUri}"></script>
  <script nonce="${nonce}" src="${formatScriptUri}"></script>
  <script nonce="${nonce}" src="${filesScriptUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
