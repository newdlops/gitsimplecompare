// 실제 Commit Plan HTML·리소스·지역화를 Chromium에 연결하는 테스트 전용 VS Code 경계 대역.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { dispatchWebviewMessage } from "./webviewHarness";

const root = process.cwd();
const origin = "https://gsc.test";
let builder: Promise<any> | undefined;

/** 실제 HTML 생성기를 작은 VS Code URI·l10n 대역과 번들링해 마크업을 복제하지 않는다. */
function htmlBuilder(): Promise<any> {
  return builder ??= build({
    stdin: { contents: 'export {buildCommitPlanHtml} from "./src/webview/commitPlanHtml"; export {Uri, setLocale} from "vscode";', resolveDir: root },
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{ name: "vscode-html-fixture", setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        import {readFileSync} from 'node:fs'; import {join, relative} from 'node:path';
        const root=process.cwd(); const ko=JSON.parse(readFileSync(join(root,'l10n/bundle.l10n.ko.json'),'utf8'));
        export const env={language:'en'}; export function setLocale(locale){env.language=locale;}
        export const l10n={t:(value,...args)=>(env.language==='ko' ? ko[value] || value : value).replace(/\\{(\\d+)\\}/g,(match,index)=>args[Number(index)] === undefined ? match : String(args[Number(index)]))};
        function uri(fsPath,query=''){return {fsPath,query,with:({query})=>uri(fsPath,query),toString:()=> 'https://gsc.test/' + relative(root,fsPath).split('\\\\').join('/') + (query?'?'+query:'')};}
        export const Uri={file:uri,joinPath:(parent,...parts)=>uri(join(parent.fsPath,...parts))};
      ` }));
    } }],
  }).then(result => {
    const module = { exports: {} };
    new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(join(root, "package.json")), module, module.exports);
    return module.exports;
  });
}

/** VS Code가 주입하는 테마 변수만 재현하며 제품의 레이아웃·컨트롤 CSS는 실제 파일을 사용한다. */
function themeCss(light: boolean): string {
  const background = light ? "#ffffff" : "#1e1e1e";
  const surface = light ? "#f3f3f3" : "#252526";
  const foreground = light ? "#333333" : "#cccccc";
  return `:root{--vscode-font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--vscode-font-size:13px;
    --vscode-editor-font-family:Menlo,monospace;--vscode-editor-font-size:12px;--vscode-foreground:${foreground};
    --vscode-editor-foreground:${foreground};--vscode-editor-background:${background};--vscode-sideBar-background:${surface};
    --vscode-editorWidget-background:${surface};--vscode-descriptionForeground:${light ? "#616161" : "#adadad"};
    --vscode-panel-border:${light ? "#cecece" : "#454545"};--vscode-widget-border:${light ? "#cecece" : "#454545"};
    --vscode-focusBorder:#007fd4;--vscode-button-background:#0e639c;--vscode-button-foreground:#ffffff;
    --vscode-button-hoverBackground:#1177bb;--vscode-button-secondaryBackground:${light ? "#e5e5e5" : "#3a3d41"};
    --vscode-button-secondaryForeground:${foreground};--vscode-input-background:${background};--vscode-input-foreground:${foreground};
    --vscode-input-border:${light ? "#cecece" : "#454545"};--vscode-badge-background:${light ? "#e5e5e5" : "#454545"};
    --vscode-badge-foreground:${foreground};--vscode-errorForeground:${light ? "#a1260d" : "#f48771"};
    --vscode-inputValidation-errorBorder:${light ? "#be1100" : "#be1100"};
    --vscode-inputValidation-errorForeground:${foreground};--vscode-inputValidation-errorBackground:${surface};
    --vscode-progressBar-background:#0e639c;--vscode-testing-iconPassed:${light ? "#237b2c" : "#89d185"};}`;
}

/** 실제 HTML의 CSP와 리소스 순서를 유지해 locale·폭별 기능/화면 테스트를 시작한다. */
export async function mountCommitPlan(page: Page, locale: "en" | "ko", light = false): Promise<void> {
  const module = await htmlBuilder();
  module.setLocale(locale);
  const html = module.buildCommitPlanHtml(module.Uri.file(root), {
    cspSource: origin, asWebviewUri: (uri: unknown) => uri,
  }).replace("</head>", '<link rel="stylesheet" href="https://gsc.test/theme.css"></head>');
  await page.addInitScript(() => {
    const w = window as any;
    w.__gscFixtureMessages = [];
    let acquired = false;
    w.acquireVsCodeApi = () => {
      if (acquired) throw new Error("VS Code API acquired twice");
      acquired = true;
      return { postMessage: (message: unknown) => w.__gscFixtureMessages.push(message), getState: () => ({}), setState: () => {} };
    };
  });
  await page.route(`${origin}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
    if (pathname === "/theme.css") return route.fulfill({ contentType: "text/css", body: themeCss(light) });
    if (!pathname.startsWith("/media/") || pathname.includes("..")) return route.abort();
    await route.fulfill({ body: await readFile(join(root, pathname.slice(1))),
      contentType: pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "font/ttf" });
  });
  await page.goto(origin);
  const context = { repoRoot: "/fixture", branch: "feature/commit-log", scope: "staged", files: [
    { path: "src/first.ts", status: "M", staged: true }, { path: "src/second.ts", status: "M", staged: true },
  ] };
  await dispatchWebviewMessage(page, { type: "context", context, prompt: "" });
  await dispatchWebviewMessage(page, { type: "plan", context, result: { groups: [
    { message: "feat: prepare first change", paths: ["src/first.ts"] },
    { message: "fix: validate second change", paths: ["src/second.ts"] },
  ], warnings: [] } });
}

/** 첫 그룹 준비 후 두 번째 그룹에서 실패하는 production protocol 메시지를 전달한다. */
export async function failSecondCommit(page: Page, log: Record<string, unknown>): Promise<void> {
  await dispatchWebviewMessage(page, { type: "executionStarted", total: 2 });
  await dispatchWebviewMessage(page, { type: "executionProgress", progress: { phase: "commit", current: 1, total: 2, step: "completed" } });
  await dispatchWebviewMessage(page, { type: "executionProgress", progress: { phase: "commit", current: 1, total: 2, step: "started" } });
  await dispatchWebviewMessage(page, { type: "error", operation: "execute", message: "pre-commit failed", log,
    failure: { likelyHook: true, hookName: "pre-commit", checkName: "eslint", summary: "Check the second commit's validation output.",
      items: [{ path: "src/second.ts", line: 12, message: "Unexpected value", severity: "error" }], truncated: false } });
}
