import * as vscode from "vscode";
import { resourceVersion, withVersion } from "./webviewResourceVersion";

/** 모든 웹뷰가 공유하는 즉시 tooltip 스타일/스크립트 URI 묶음. */
export type InstantTooltipResources = {
  styleUri: vscode.Uri;
  scriptUri: vscode.Uri;
};

/**
 * 확장 media/shared 아래 공용 tooltip 리소스를 대상 웹뷰에서 읽을 수 있는 URI로 변환한다.
 * @param webview 리소스 URI를 발급할 VS Code 웹뷰
 * @param extensionUri Git Simple Compare 확장 루트 URI
 * @returns HTML의 link/script 태그에 넣을 스타일과 스크립트 URI
 */
export function instantTooltipResources(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): InstantTooltipResources {
  const sharedRoot = vscode.Uri.joinPath(extensionUri, "media", "shared");
  const styleFile = vscode.Uri.joinPath(sharedRoot, "instantTooltip.css");
  const scriptFile = vscode.Uri.joinPath(sharedRoot, "instantTooltip.js");
  const version = resourceVersion([styleFile, scriptFile]);
  return {
    styleUri: webview.asWebviewUri(withVersion(styleFile, version)),
    scriptUri: webview.asWebviewUri(withVersion(scriptFile, version)),
  };
}
