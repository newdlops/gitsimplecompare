// 실제 native CommentThread에서 API 선표시·HTML 실패·파일 전환을 검증하는 격리 Host 시나리오.
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { execFileSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { PullRequestCommentController } from "../../src/providers/pullRequestCommentController";
import { PullRequestReviewCommentService } from "../../src/git/pullRequestReviewComments";
import { GitHubWebTransport } from "../../src/git/githubWebTransport";
import { encodeRestPage, restPageMetadata } from "../../src/git/githubRestPages";
import type { GitServiceRegistry } from "../../src/git/serviceRegistry";
import { IsolatedTestWindow } from "../helpers/isolatedTestWindow";

/** 원격 HTML 완료만 제어하고 API/cache/controller/native UI 경로는 그대로 실행한다. */
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** UI 상태 자체가 도착할 때까지 기다리며 대기 시간은 성능 지표로 해석하지 않는다. */
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await check()) { assert(Date.now() < deadline, `${label} did not settle`); await new Promise(resolve => setTimeout(resolve, 50)); }
}

/** 소유 fixture의 API 응답만 대체하고 실제 VS Code 에디터/댓글의 단계별 상태를 증명한다. */
export async function verifyProgressiveComments(root: string, owned: IsolatedTestWindow, directory: string): Promise<any> {
  const config = vscode.workspace.getConfiguration("gitSimpleCompare", vscode.Uri.file(root));
  const saved = { transport: config.inspect("githubReadTransport")?.workspaceValue, show: config.inspect("pullRequestComments.show")?.workspaceValue };
  const envKeys = ["GH_REPO", "GH_HOST", "GITHUB_CLI_PATH"] as const;
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const originalService = PullRequestReviewCommentService.prototype.getActiveBranchReviewComments;
  const originalWeb = GitHubWebTransport.prototype.read;
  const file = "comments-first.ts", other = "comments-second.ts";
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
  const fakeGh = path.join(root, "comments-gh.js");
  await writeFile(fakeGh, `#!/usr/bin/env node
const a=process.argv.slice(2);if(a[0]==='auth'){process.stdout.write('fixture-token');process.exit(0)}
if(a[0]==='api'&&a[1]==='graphql'){const q=(a.find(v=>v.startsWith('query='))||'').slice(6),r={nameWithOwner:'owner/repo',url:'https://github.com/owner/repo',defaultBranchRef:{name:'main'}};for(const m of q.matchAll(/(p\\d+):/g))r[m[1]]={nodes:[]};process.stdout.write(JSON.stringify({data:{repository:r}}));process.exit(0)}
process.stdout.write('[]');
`);
  await chmod(fakeGh, 0o755);
  const apiComments = [
    { id: 42, path: file, line: 2, body: "GSC API comment ready\n\n긴 한글 검토 내용이 좁은 에디터에서도 읽히는지 확인합니다. API 댓글은 HTML 보완이 늦어져도 먼저 표시되며 사용자가 펼친 스레드는 보완 실패 뒤에도 유지됩니다.\n\n```ts\nconst visibleBeforeHtml = true;\n```", user: { login: "fixture-reviewer" }, html_url: "https://github.com/owner/repo/pull/7#discussion_r42" },
    { id: 43, in_reply_to_id: 42, path: file, body: "GSC reply retained — 답글도 같은 스레드에 표시됩니다.", user: { login: "fixture-author" } },
  ];
  const pullRequest = { number: 7, title: "Progressive comments / 단계별 댓글", state: "OPEN", url: "https://github.com/owner/repo/pull/7",
    headRefName: branch, baseRefName: "main", isCrossRepository: false, headRepositoryOwner: { login: "owner" } };
  let gate = barrier(), htmlStarted = 0, apiReady = 0, firstReadyMs = 0, lastResult: any;
  const started = Date.now(), states: any[] = [];
  let controller: any;
  try {
    Object.assign(process.env, { GH_REPO: "owner/repo", GH_HOST: "github.com", GITHUB_CLI_PATH: fakeGh });
    await config.update("githubReadTransport", "cli", vscode.ConfigurationTarget.Workspace);
    await config.update("pullRequestComments.show", true, vscode.ConfigurationTarget.Workspace);
    // 다른 production controller도 fake gh의 명시적 'PR 없음'만 읽는다. 실제 계정/HTML 접근은 없다.
    PullRequestReviewCommentService.prototype.getActiveBranchReviewComments = async function(this: any, current?: string) {
      const options = this.options;
      const service = new PullRequestReviewCommentService(root, { ...options,
        suggestedChangeset: { webAccessToken: "fixture-token", networkPolicy: { transport: "auto", systemProxy: "none", proxySupport: "on" } },
        onApiReady: value => { apiReady++; firstReadyMs ||= Date.now() - started; options.onApiReady?.(value); },
      }, async (_args, _cwd, readOptions) => readOptions?.request?.kind === "rest"
        ? encodeRestPage(JSON.stringify(apiComments), restPageMetadata(200, {}))
        : JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", defaultBranchRef: { name: "main" }, p0: { nodes: [pullRequest] } } } }));
      lastResult = await originalService.call(service, current); return lastResult;
    };
    GitHubWebTransport.prototype.read = async () => { htmlStarted++; await gate.promise; return { ok: false, reason: "status403" }; };
    await writeFile(path.join(root, file), "// fixture only\nconst commentLine = true;\nexport { commentLine };\n");
    await writeFile(path.join(root, other), "// fixture without comments\nexport const otherFile = true;\n");
    await owned.focusOwnedWindow(); await until(() => vscode.window.state.focused, "owned Host focus");
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, file)), { preview: false });
    const registry = { resolve: async () => ({ repoRoot: root, toRepoRelative: (absolute: string) => path.relative(root, absolute) }) } as unknown as GitServiceRegistry;
    controller = new PullRequestCommentController(registry, { get: async () => undefined } as any); controller.register();
    await until(() => apiReady === 1 && htmlStarted > 0 && controller.activeThreads.size === 1, "API-ready native thread before HTML");
    assert.equal(controller.commentCache.cache.size, 0, "provisional data must not enter completed TTL");
    const thread = [...controller.activeThreads.values()][0] as vscode.CommentThread;
    assert.equal(thread.comments.length, 2);
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    await vscode.commands.executeCommand("workbench.action.focusCommentOnCurrentLine");
    await vscode.commands.executeCommand("workbench.action.expandAllComments");
    // 댓글 이동 명령이 여는 하단 목록은 닫고 실제 에디터 thread의 본문/답글을 QA한다.
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    await vscode.commands.executeCommand("notifications.clearAll");
    await until(async () => (await owned.commentState()).widgets.some((widget: any) => widget.text.includes("GSC API comment ready") && widget.text.includes("GSC reply retained")), "expanded native API comments");
    for (const [width, height] of [[1440, 900], [900, 700]]) {
      await owned.settingsViewport(width, height);
      await until(async () => (await owned.commentState()).width === width, "comment viewport");
      const state = await owned.commentState(); assert(state.widgets.length >= 1);
      assert(state.widgets.every((widget: any) => widget.bounds.left >= 0 && widget.bounds.right <= width));
      states.push({ phase: "api-ready", ...state });
      await writeFile(path.join(directory, `comments-${vscode.env.language}-${width}.png`), await owned.screenshot());
    }
    gate.resolve(); await until(() => controller.commentCache.inFlightLoads.size === 0, "HTML failure completion");
    assert.equal([...controller.activeThreads.values()][0], thread);
    assert.equal(thread.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
    assert.equal(lastResult.comments.length, 2); assert(lastResult.suggestedChangesetStatus.attempted);
    await until(async () => (await owned.commentState()).widgets.some((widget: any) => widget.text.includes("GSC API comment ready")), "comments retained after HTML failure");
    await writeFile(path.join(directory, `comments-${vscode.env.language}-html-failed.png`), await owned.screenshot());
    states.push({ phase: "html-failed", ...await owned.commentState() });
    gate = barrier(); const previousHtml = htmlStarted;
    controller.invalidateCache("host-stale-file-check");
    await until(() => apiReady >= 2 && htmlStarted > previousHtml, "second progressive load");
    const pending = [...controller.commentCache.inFlightLoads.values()][0] as any;
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, other)), { preview: false });
    await until(() => controller.activeThreads.size === 0, "new file clears old comments");
    assert.equal(pending.controller.signal.aborted, false, "file switching must preserve repository singleflight");
    gate.resolve(); await until(() => controller.commentCache.inFlightLoads.size === 0, "stale HTML completion");
    assert.equal(controller.activeThreads.size, 0); assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, path.join(root, other));
    await until(async () => !(await owned.commentState()).widgets.some((widget: any) => widget.text.includes("GSC API comment ready")), "stale UI remains absent");
    await writeFile(path.join(directory, `comments-${vscode.env.language}-stale-file.png`), await owned.screenshot());
    controller.dispose(); assert.equal(controller.commentCache.cache.size, 0); assert.equal(controller.activeThreads.size, 0);
    return { apiBeforeHtml: true, firstReadyMs, htmlFailureKeepsApi: true, nativeExpandedThreadPreserved: true,
      staleFileSuppressed: true, repositoryLoadSurvivesFileSwitch: true, disposeClearsCacheAndThreads: true, states };
  } finally {
    gate.resolve(); controller?.dispose();
    PullRequestReviewCommentService.prototype.getActiveBranchReviewComments = originalService;
    GitHubWebTransport.prototype.read = originalWeb;
    for (const key of envKeys) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
    await config.update("githubReadTransport", saved.transport, vscode.ConfigurationTarget.Workspace);
    await config.update("pullRequestComments.show", saved.show, vscode.ConfigurationTarget.Workspace);
  }
}
