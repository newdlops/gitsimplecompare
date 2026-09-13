// 실제 로컬 브랜치 현황 HTML을 브라우저에 연결한다. VS Code URI·l10n 경계만 대체한다.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { InspectedLocalBranch, StaleBranchInspection } from "../../src/git/staleBranchService";
import { themeCss } from "./commitPlanHarness";

const root = process.cwd();
let builder: Promise<any> | undefined;

/** 제품 HTML 생성기를 번들링하되 Git·네이티브 창 생성 없이 현재 번역과 리소스를 그대로 쓴다. */
function htmlBuilder(): Promise<any> {
  return builder ??= build({
    stdin: { contents: 'export {buildStaleBranchHtml} from "./src/webview/staleBranchHtml"; export {Uri,setLocale} from "vscode";', resolveDir: root },
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{ name: "stale-branch-vscode-fixture", setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        import {readFileSync} from 'node:fs'; import {join,relative} from 'node:path';
        const root=process.cwd(); const ko=JSON.parse(readFileSync(join(root,'l10n/bundle.l10n.ko.json'),'utf8'));
        export const env={language:'en'}; export function setLocale(locale){env.language=locale;}
        export const l10n={t:(value,...args)=>(env.language==='ko' ? ko[value] || value : value).replace(/\\{(\\d+)\\}/g,(match,index)=>args[Number(index)] === undefined ? match : String(args[Number(index)]))};
        function uri(fsPath,query=''){return {fsPath,query,with:({query})=>uri(fsPath,query),toString:()=> 'https://gsc.test/'+relative(root,fsPath).split('\\\\').join('/')+(query?'?'+query:'')};}
        export const Uri={file:uri,joinPath:(parent,...parts)=>uri(join(parent.fsPath,...parts))};
      ` }));
    } }],
  }).then(result => {
    const module = { exports: {} };
    new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(join(root, "package.json")), module, module.exports);
    return module.exports;
  });
}

/** 로컬 이름·원격 대응·보호·긴 이름을 한 화면에 넣는 예시 스냅샷을 만든다. */
export function branchInspection(): StaleBranchInspection {
  const base = { hash: "a".repeat(40), subject: "Keep this local commit title", merged: true, inUse: false, current: false, matchingRemotes: [], worktreePaths: [] };
  const localBranches: InspectedLocalBranch[] = [
    { ...base, name: "feature/finished-local", remoteState: "absent" },
    { ...base, name: "feature/unmerged-local", remoteState: "absent", merged: false },
    { ...base, name: "feature/in-worktree", remoteState: "absent", inUse: true, worktreePaths: ["/worktrees/active feature"] },
    { ...base, name: "main", remoteState: "present", current: true, inUse: true, matchingRemotes: ["origin"], worktreePaths: ["/fixture"] },
    { ...base, name: "feature/on-both-remotes", remoteState: "present", matchingRemotes: ["origin", "upstream"] },
    { ...base, name: "feature/" + "아주-긴-로컬-브랜치-이름-".repeat(8), remoteState: "absent", subject: "</script><img src=x onerror=alert(1)>" },
  ];
  return { repoRoot: "/fixture/local-branch-status", remotes: ["origin", "upstream"], remoteConfigHash: "fixture",
    localBranches, branches: localBranches.filter(branch => branch.remoteState === "absent") };
}

/** 실제 CSP·마크업·CSS·JS를 locale별 Chromium 페이지에 전달하고 host 메시지만 기록한다. */
export async function mountStaleBranches(page: Page, locale: "en" | "ko", inspection = branchInspection(), light = locale === "ko"): Promise<void> {
  const module = await htmlBuilder();
  module.setLocale(locale);
  const html = module.buildStaleBranchHtml(module.Uri.file(root), { cspSource: "https://gsc.test", asWebviewUri: (uri: unknown) => uri }, inspection)
    .replace("</head>", '<link rel="stylesheet" href="https://gsc.test/theme.css"></head>');
  await page.addInitScript(() => {
    const w = window as any;
    w.__gscFixtureMessages = [];
    w.acquireVsCodeApi = () => ({ postMessage: (value: unknown) => w.__gscFixtureMessages.push(value) });
  });
  await page.route("https://gsc.test/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: html });
    if (path === "/theme.css") return route.fulfill({ contentType: "text/css", body: themeCss(light) });
    if (!path.startsWith("/media/") || path.includes("..")) return route.abort();
    await route.fulfill({ body: await readFile(join(root, path.slice(1))), contentType: path.endsWith(".js") ? "text/javascript" : "text/css" });
  });
  await page.goto("https://gsc.test");
}
