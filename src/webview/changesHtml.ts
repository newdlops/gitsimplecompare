// Changes 웹뷰 HTML 셸을 만드는 모듈.
// - CSP/nonce/정적 리소스 URI/주입 데이터를 provider 에서 분리해 provider 는 상태 관리에 집중한다.
import * as vscode from "vscode";
import { buildCommitMenu, buildScmMenu } from "../commands/scmActions";
import { changesWebviewI18n } from "./changesI18n";
import {
  makeNonce,
  resourceVersion,
  withVersion,
} from "./webviewResourceVersion";

/**
 * Changes 웹뷰 HTML 을 만든다.
 * @param extensionUri 확장 루트 URI. media/codicons 리소스 경로 계산에 사용한다.
 * @param webview      리소스 URI 변환과 CSP source 를 제공하는 웹뷰 객체
 * @returns CSP 와 초기 데이터가 포함된 완성 HTML
 */
export function buildChangesHtml(
  extensionUri: vscode.Uri,
  webview: vscode.Webview
): string {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media", "changes");
  const version = resourceVersion([
    vscode.Uri.joinPath(mediaRoot, "changes.js"),
    vscode.Uri.joinPath(mediaRoot, "changesCompare.js"),
    vscode.Uri.joinPath(mediaRoot, "changesAi.js"),
    vscode.Uri.joinPath(mediaRoot, "changesCommitBox.js"),
    vscode.Uri.joinPath(mediaRoot, "changesWorktrees.js"),
    vscode.Uri.joinPath(mediaRoot, "changesWorkingOperation.js"),
    vscode.Uri.joinPath(mediaRoot, "changesCommitBox.css"),
    vscode.Uri.joinPath(mediaRoot, "changesCompare.css"),
    vscode.Uri.joinPath(mediaRoot, "changesWorktrees.css"),
    vscode.Uri.joinPath(mediaRoot, "changes.css"),
  ]);
  const scriptUri = webview.asWebviewUri(
    withVersion(vscode.Uri.joinPath(mediaRoot, "changes.js"), version)
  );
  const aiScriptUri = webview.asWebviewUri(
    withVersion(vscode.Uri.joinPath(mediaRoot, "changesAi.js"), version)
  );
  const compareScriptUri = webview.asWebviewUri(
    withVersion(vscode.Uri.joinPath(mediaRoot, "changesCompare.js"), version)
  );
  const commitBoxScriptUri = webview.asWebviewUri(
    withVersion(vscode.Uri.joinPath(mediaRoot, "changesCommitBox.js"), version)
  );
  const operationScriptUri = webview.asWebviewUri(
    withVersion(
      vscode.Uri.joinPath(mediaRoot, "changesWorkingOperation.js"),
      version
    )
  );
  const worktreesScriptUri = webview.asWebviewUri(
    withVersion(vscode.Uri.joinPath(mediaRoot, "changesWorktrees.js"), version)
  );
  const styleUri = webview.asWebviewUri(
    withVersion(vscode.Uri.joinPath(mediaRoot, "changes.css"), version)
  );
  const compareStyleUri = webview.asWebviewUri(
    withVersion(vscode.Uri.joinPath(mediaRoot, "changesCompare.css"), version)
  );
  const worktreesStyleUri = webview.asWebviewUri(
    withVersion(vscode.Uri.joinPath(mediaRoot, "changesWorktrees.css"), version)
  );
  const commitBoxStyleUri = webview.asWebviewUri(
    withVersion(vscode.Uri.joinPath(mediaRoot, "changesCommitBox.css"), version)
  );
  const codiconUri = webview.asWebviewUri(
    withVersion(
      vscode.Uri.joinPath(extensionUri, "media", "codicons", "codicon.css"),
      version
    )
  );
  const nonce = makeNonce();
  const csp = [
    `default-src 'none'`,
    `img-src data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const i18n = changesWebviewI18n();
  const menu = buildScmMenu();
  const commitMenu = buildCommitMenu();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link href="${codiconUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <link href="${compareStyleUri}" rel="stylesheet" />
  <link href="${commitBoxStyleUri}" rel="stylesheet" />
  <link href="${worktreesStyleUri}" rel="stylesheet" />
  <title>Changes</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__gscI18n=${JSON.stringify(
    i18n
  )};window.__gscMenu=${JSON.stringify(
    menu
  )};window.__gscCommitMenu=${JSON.stringify(commitMenu)};</script>
  <script nonce="${nonce}" src="${operationScriptUri}"></script>
  <script nonce="${nonce}" src="${worktreesScriptUri}"></script>
  <script nonce="${nonce}" src="${compareScriptUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
  <script nonce="${nonce}" src="${commitBoxScriptUri}"></script>
  <script nonce="${nonce}" src="${aiScriptUri}"></script>
</body>
</html>`;
}
