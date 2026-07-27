// Reviews 사이드바의 HTML 셸 조립기.
// - CSP·공용 token·tooltip과 정적 JS/CSS URI를 provider 상태 코드에서 분리한다.
import * as vscode from "vscode";
import {
  sharedWebviewResources,
  sharedWebviewScriptTags,
  sharedWebviewStyleTags,
} from "./sharedWebviewResources";
import { reviewsI18n } from "./reviewsI18n";
import { makeNonce, resourceVersion, withVersion } from "./webviewResourceVersion";

/**
 * Reviews 웹뷰 HTML을 생성한다.
 * @param extensionUri 확장 media 루트를 계산할 URI
 * @param webview      CSP source와 webview URI 변환을 제공하는 대상
 * @returns 브라우저가 즉시 렌더할 CSP 적용 HTML
 */
export function buildReviewsHtml(
  extensionUri: vscode.Uri,
  webview: vscode.Webview,
  reviewWritesEnabled = false
): string {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media", "review-queue");
  const files = [
    vscode.Uri.joinPath(mediaRoot, "reviews.css"),
    vscode.Uri.joinPath(mediaRoot, "reviewsQueueControls.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewsQueuePagination.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewsQueueWindow.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewsCachedSummary.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewsSavedQueues.js"),
    vscode.Uri.joinPath(mediaRoot, "reviewsQueueKeyboard.js"),
    vscode.Uri.joinPath(mediaRoot, "reviews.js"),
  ];
  const version = resourceVersion(files);
  const styleUri = webview.asWebviewUri(withVersion(files[0], version));
  const controlsScriptUri = webview.asWebviewUri(withVersion(files[1], version));
  const paginationScriptUri = webview.asWebviewUri(withVersion(files[2], version));
  const windowScriptUri = webview.asWebviewUri(withVersion(files[3], version));
  const cachedSummaryScriptUri = webview.asWebviewUri(withVersion(files[4], version));
  const savedQueuesScriptUri = webview.asWebviewUri(withVersion(files[5], version));
  const keyboardScriptUri = webview.asWebviewUri(withVersion(files[6], version));
  const scriptUri = webview.asWebviewUri(withVersion(files[7], version));
  const shared = sharedWebviewResources(webview, extensionUri);
  const nonce = makeNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  ${sharedWebviewStyleTags(shared)}
  <link href="${styleUri}" rel="stylesheet" />
  <title>Reviews</title>
</head>
<body class="gsc-surface">
  <main id="root" class="reviews" aria-live="polite"></main>
  <script nonce="${nonce}">window.__gscReviewsI18n=${JSON.stringify(reviewsI18n())};window.__gscReviewWritesEnabled=${JSON.stringify(reviewWritesEnabled)};</script>
  ${sharedWebviewScriptTags(shared, nonce)}
  <script nonce="${nonce}" src="${controlsScriptUri}"></script>
  <script nonce="${nonce}" src="${paginationScriptUri}"></script>
  <script nonce="${nonce}" src="${windowScriptUri}"></script>
  <script nonce="${nonce}" src="${cachedSummaryScriptUri}"></script>
  <script nonce="${nonce}" src="${savedQueuesScriptUri}"></script>
  <script nonce="${nonce}" src="${keyboardScriptUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
