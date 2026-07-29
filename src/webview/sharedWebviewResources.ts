// 모든 웹뷰가 같은 shared CSS/JS를 같은 순서와 cache version으로 주입하게 하는 리소스 조립기.
// - 각 panel이 개별 URI/CSP 처리를 반복하지 않아 token·tooltip·접근성 primitive의 동작을 일관되게 유지한다.
import * as vscode from "vscode";
import { instantTooltipResources } from "./instantTooltipResources";
import { resourceVersion, withVersion } from "./webviewResourceVersion";

const SHARED_STYLE_FILES = ["reset.css", "tokens.css", "controls.css", "data-display.css", "feedback.css", "layout.css"];
const SHARED_SCRIPT_FILES = [
  "a11y.js",
  "dom.js",
  "keyboard.js",
  "overlay.js",
  "persistedState.js",
  "requestState.js",
  "splitter.js",
  "virtualList.js",
];

/** 웹뷰 HTML이 link/script 태그로 사용할 공용 resource URI 묶음. */
export interface SharedWebviewResources {
  styleUris: vscode.Uri[];
  primitiveScriptUris: vscode.Uri[];
  tooltipStyleUri: vscode.Uri;
  tooltipScriptUri: vscode.Uri;
}

/** 공용 CSS와 tooltip stylesheet를 HTML head에 넣을 순서 보장 태그로 만든다. */
export function sharedWebviewStyleTags(resources: SharedWebviewResources): string {
  return [
    ...resources.styleUris.map((uri) => `<link href="${uri}" rel="stylesheet" />`),
    `<link href="${resources.tooltipStyleUri}" rel="stylesheet" />`,
  ].join("\n  ");
}

/** 공용 state/a11y primitive와 tooltip script를 nonce 적용 script 태그로 만든다. */
export function sharedWebviewScriptTags(
  resources: SharedWebviewResources,
  nonce: string
): string {
  return [
    ...resources.primitiveScriptUris.map(
      (uri) => `<script nonce="${nonce}" src="${uri}"></script>`
    ),
    `<script nonce="${nonce}" src="${resources.tooltipScriptUri}"></script>`,
  ].join("\n  ");
}

/**
 * media/shared 파일을 지정된 웹뷰에서 읽을 수 있는 versioned URI로 변환한다.
 * @param webview      대상 VS Code 웹뷰
 * @param extensionUri 확장 설치 루트
 * @returns stylesheet와 instant tooltip resource를 포함한 URI 묶음
 */
export function sharedWebviewResources(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): SharedWebviewResources {
  const sharedRoot = vscode.Uri.joinPath(extensionUri, "media", "shared");
  const styleFiles = SHARED_STYLE_FILES.map((file) =>
    vscode.Uri.joinPath(sharedRoot, file)
  );
  const scriptFiles = SHARED_SCRIPT_FILES.map((file) =>
    vscode.Uri.joinPath(sharedRoot, file)
  );
  const tooltip = instantTooltipResources(webview, extensionUri);
  const version = resourceVersion([...styleFiles, ...scriptFiles]);
  return {
    styleUris: styleFiles.map((file) => webview.asWebviewUri(withVersion(file, version))),
    primitiveScriptUris: scriptFiles.map((file) => webview.asWebviewUri(withVersion(file, version))),
    tooltipStyleUri: tooltip.styleUri,
    tooltipScriptUri: tooltip.scriptUri,
  };
}
