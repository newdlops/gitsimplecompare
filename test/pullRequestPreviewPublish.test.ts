import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import * as vscode from "vscode";
import { PullRequestPublishService } from "../src/git/pullRequestPublishService";
import { pullRequestPreviewDiffScript } from "../src/webview/pullRequestPreviewDiffRenderer";
import { pullRequestPreviewI18n } from "../src/webview/pullRequestPreviewI18n";
import { buildPullRequestPreviewHtml } from "../src/webview/pullRequestPreviewHtml";
import { pullRequestPreviewScript } from "../src/webview/pullRequestPreviewScript";
import { pullRequestPreviewStyles } from "../src/webview/pullRequestPreviewStyles";

const execFileAsync = promisify(execFile);
interface FakePullRequest { number:number; title:string; body:string; url:string; headRefName:string; baseRefName:string; state:"OPEN"; isDraft:boolean; author:{login:string}; }
interface FakeGitHubState { repository:string; pullRequests:FakePullRequest[]; }
async function git(cwd:string,...args:string[]):Promise<string>{return (await execFileAsync("git",args,{cwd,encoding:"utf8",env:{...process.env,GIT_EDITOR:"true",GIT_SEQUENCE_EDITOR:"true",HUSKY:"0"}})).stdout.trim();}
async function writeFakeGh(file:string):Promise<void>{await writeFile(file,["#!/usr/bin/env node",'const fs=require("node:fs"),args=process.argv.slice(2),p=process.env.GSC_FAKE_PR_PREVIEW_STATE,s=JSON.parse(fs.readFileSync(p,"utf8")),v=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1]},out=x=>process.stdout.write(typeof x==="string"?x:JSON.stringify(x));','if(args[0]==="pr"&&args[1]==="list"){out(s.pullRequests.filter(x=>x.state==="OPEN"&&(!v("--head")||x.headRefName===v("--head"))));process.exit()}','if(args[0]==="pr"&&args[1]==="create"){const n=Math.max(0,...s.pullRequests.map(x=>x.number))+1,x={number:n,title:v("--title"),body:v("--body")||"",url:`https://github.com/${s.repository}/pull/${n}`,headRefName:v("--head"),baseRefName:v("--base"),state:"OPEN",isDraft:args.includes("--draft"),author:{login:"test"}};s.pullRequests.push(x);fs.writeFileSync(p,JSON.stringify(s));out(x.url);process.exit()}','process.exit(2)'].join("\n"));await chmod(file,0o755);}

test("staged publish commits only staged changes, prevents duplicates, and preserves unstaged work", async()=>{const root=await mkdtemp(join(tmpdir(),"gsc-publish-")),repo=join(root,"repo"),remote=join(root,"remote.git"),gh=join(root,"gh.js"),state=join(root,"state.json");const oldGh=process.env.GITHUB_CLI_PATH,oldState=process.env.GSC_FAKE_PR_PREVIEW_STATE;try{await mkdir(repo);await git(root,"init","--bare",remote);await git(repo,"init","-b","main");await git(repo,"config","user.name","test");await git(repo,"config","user.email","test@example.com");await writeFile(join(repo,"base"),"base\n");await git(repo,"add",".");await git(repo,"commit","-m","base");await git(repo,"remote","add","origin",remote);await git(repo,"push","-u","origin","main");await git(repo,"switch","-c","feature");await writeFakeGh(gh);await writeFile(state,JSON.stringify({repository:"x/y",pullRequests:[]}));process.env.GITHUB_CLI_PATH=gh;process.env.GSC_FAKE_PR_PREVIEW_STATE=state;await writeFile(join(repo,"staged"),"yes\n");await writeFile(join(repo,"unstaged"),"keep\n");await git(repo,"add","staged");const service=new PullRequestPublishService(repo);const result=await service.publishPreview({sourceBranch:"feature",targetBranch:"origin/main",remote:"origin",title:"Draft",body:"body",draft:true,commitMessage:"staged only"});assert.equal(result.committed,true);assert.equal(result.pullRequest.isDraft,true);assert.equal(await git(repo,"status","--short","unstaged"),"?? unstaged");assert.equal(await git(repo,"show","-s","--format=%s","HEAD"),"staged only");await assert.rejects(service.publishPreview({sourceBranch:"feature",targetBranch:"main",remote:"origin",title:"Again",body:"",draft:false,commitMessage:"no"}),/already exists/);await git(repo,"switch","-c","other","main");await writeFile(join(repo,"wrong-source"),"wrong\n");await git(repo,"add","wrong-source");await assert.rejects(service.publishPreview({sourceBranch:"feature",targetBranch:"main",remote:"origin",title:"Wrong",body:"",draft:false,commitMessage:"wrong"}),/Staged changes belong to 'other'/);await git(repo,"reset");await git(repo,"switch","-c","ready","main");await writeFile(join(repo,"ready"),"ready\n");await git(repo,"add","ready");const ready=await service.publishPreview({sourceBranch:"ready",targetBranch:"main",remote:"origin",title:"Ready",body:"body",draft:false,commitMessage:"ready"});assert.equal(ready.committed,true);assert.equal(ready.pullRequest.isDraft,false);await git(repo,"switch","-c","empty","main");await assert.rejects(service.publishPreview({sourceBranch:"empty",targetBranch:"main",remote:"origin",title:"Empty",body:"",draft:false}),/no commits ahead/);}finally{if(oldGh===undefined)delete process.env.GITHUB_CLI_PATH;else process.env.GITHUB_CLI_PATH=oldGh;if(oldState===undefined)delete process.env.GSC_FAKE_PR_PREVIEW_STATE;else process.env.GSC_FAKE_PR_PREVIEW_STATE=oldState;await rm(root,{recursive:true,force:true});}});

/** staged Preview renderer가 Review Center 없이 독립적으로 유지되는지 확인한다. */
test("staged Preview renderer and GitHub action remain independent", () => {
  assert.match(pullRequestPreviewDiffScript(), /publishText\.diffUnavailable/);
  assert.match(pullRequestPreviewStyles(), /topbar/);
  assert.equal(pullRequestPreviewI18n().openGitHub, "Open pull request on GitHub");
});

test("Preview script escapes injected localized text and keeps publish message route", () => {
  const text = { ...pullRequestPreviewI18n(), ready: "Create <PR>" };
  const script = pullRequestPreviewScript(text);
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /publishPullRequest/);
  assert.equal(script.includes("Create <PR>"), false);
});

test("localized diff renderer contract has no English fallback literals", async () => {
  const renderer = await readFile(join(process.cwd(), "src/webview/pullRequestPreviewDiffRenderer.ts"), "utf8");
  const i18n = pullRequestPreviewI18n();
  for (const field of ["diffUnavailable", "diffLinesTruncated", "diffExpandUnchangedLines", "diffShowMoreUnchangedLines", "diffCollapseUnchangedLines", "diffCollapseUnchanged", "diffLine", "diffReview", "diffUnknownAuthor"] as const) {
    assert.match(renderer, new RegExp(`publishText\\.${field}`));
    assert.equal(typeof i18n[field], "string");
  }
  for (const literal of ["Diff snippet is unavailable for this file.", " lines truncated", "Expand ' + count", "Collapse unchanged lines", "line review"]) assert.equal(renderer.includes(literal), false);
  const script = pullRequestPreviewDiffScript();
  assert.doesNotThrow(() => new Function(script));
  assert.match(pullRequestPreviewScript({ ...i18n, diffLinesTruncated: "{0} <&>\u2028\u2029" }), /\\u003c/);
});

test("Preview HTML composes CSP nonce and localized diff text", () => {
  const originalJoinPath = vscode.Uri.joinPath;
  const makeUri = (path: string, query = "") => ({ path, query, with: ({ query: next }: { query?: string }) => makeUri(path, next), toString: () => `file://${path}${query ? `?${query}` : ""}` });
  (vscode.Uri as any).joinPath = (...parts: any[]) => makeUri(parts.map(part => typeof part === "string" ? part : part.path).join("/"));
  const uri: any = makeUri("/extension");
  const fakeWebview: any = { cspSource: "vscode-webview://test", asWebviewUri: (resource: any) => ({ toString: () => `vscode-webview://test${resource.path}` }) };
  const text = { ...pullRequestPreviewI18n(), diffUnavailable: "<diff>&\u2028\u2029" };
  try {
    const html = buildPullRequestPreviewHtml(uri as any, fakeWebview, text);
    const nonce = html.match(/style-src vscode-webview:\/\/test 'nonce-([^']+)'/)?.[1];
    assert.match(html, /default-src 'none'/); assert.match(html, /font-src vscode-webview:\/\/test/); assert.ok(nonce);
    assert.match(html, new RegExp(`<style nonce="${nonce}">`));
    for (const value of html.matchAll(/<script nonce="([^"]+)">/g)) assert.equal(value[1], nonce);
    assert.equal(html.includes("<diff>&"), false); assert.match(html, /\\u003c.*\\u003e.*\\u0026.*\\u2028.*\\u2029/);
  } finally { (vscode.Uri as any).joinPath = originalJoinPath; }
  const design = JSON.parse(require("node:fs").readFileSync(".impeccable/design.json", "utf8"));
  for (const forbidden of ["Review Queue Row", "The Queue-to-Code Rule", "관리 큐", "팀·조직 관리", "PR 리뷰 workspace", "src/webview/review.ts"]) assert.equal(JSON.stringify(design).includes(forbidden), false);
  assert.match(JSON.stringify(design), /Staged Pull Request Summary/);
  assert.match(JSON.stringify(design), /The Graph-to-Preview Rule/);
  const search = design.components.find((component: any) => component.name === "Search Field");
  const summary = design.components.find((component: any) => component.name === "Staged Pull Request Summary");
  assert.equal(search.html, '<label class="ds-search"><span class="ds-sr-only">Filter changed files</span><input placeholder="Filter changed files…" /></label>');
  assert.equal(summary.html, '<button class="ds-pr-row" title="Preview staged changes for feature/localize → main" aria-label="Preview staged changes for feature/localize → main" data-tooltip="Preview staged changes for feature/localize → main"><span class="ds-pr-id">feature/localize → main</span><strong class="ds-pr-title">Localize staged PR preview</strong><span class="ds-pr-id">3 staged files</span><span class="ds-pr-need">Ready to publish</span><span class="ds-pr-id">local</span></button>');
  for (const value of ["Search pull requests", "repo #418", "Harden review draft recovery", "Your review", "2 failed", "ds-pr-checks", "<time", "12m"]) assert.equal(summary.html.includes(value) || search.html.includes(value), false);
  for (const value of ["feature/localize → main", "3 staged files", "Ready to publish", "Localize staged PR preview", "title=", "aria-label=", "data-tooltip="]) assert.equal(summary.html.includes(value), true);
  assert.equal(design.schemaVersion, 2); assert.ok(design.extensions.colorMeta); assert.match(search.css, /\.ds-search/); assert.match(summary.css, /\.ds-pr-row/); assert.match(JSON.stringify(design.narrative), /native PR comments\/suggestions/);
});

test("V10 localization asset cleanup preserves native PR concepts", async () => {
  const bundle = JSON.parse(await readFile(join(process.cwd(), "l10n/bundle.l10n.ko.json"), "utf8")) as Record<string, string>;
  for (const key of ["Only the latest 100 commits are shown in Review Center.", "Review Center is offline. Check your connection and try again.", "Review draft status could not be verified. Refresh Review Center before writing."]) assert.equal(key in bundle, false);
  for (const key of ["review", "unknown", "GitHub PR Preview Comments", "Suggested changeset"]) assert.equal(typeof bundle[key], "string");
  const controls = await readFile(join(process.cwd(), "media/shared/controls.css"), "utf8");
  assert.equal(controls.startsWith("/* Git Simple Compare 웹뷰에서 공유하는 compact control 문법."), true);
});
