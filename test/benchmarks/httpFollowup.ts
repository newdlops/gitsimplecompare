// 이전/현재의 실제 서비스 코드를 같은 외부 경계에서 실행하고 전체 applicable DTO를 비교한다.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { environment, repository, htmlFixture, inspectorFixture, pr, digest, clock, wait, git } from "./httpFollowupFixtures";
import { smartHttpCloneFixture } from "../helpers/smartHttpCloneFixture";

const before = require(process.env.GSC_FOLLOWUP_BEFORE!), after = require(process.env.GSC_FOLLOWUP_AFTER!);
const records: any[] = [];
const supportedPolicy = { transport: "auto", systemProxy: "none", proxySupport: "on" };

/** 최소 세 쌍을 번갈아 실행하고 user payload의 완전한 equality/hash를 별도 확인한다. */
async function pairs(id: string, evidence: string, run: (module: any, side: string, iteration: number) => Promise<any>) {
  const samples: any[] = [];
  for (let index = 0; index < 3; index++) {
    const values: Record<string, any> = {};
    for (const side of index % 2 ? ["after", "before"] : ["before", "after"]) values[side] = await run(side === "before" ? before : after, side, index);
    assert.equal(values.before.payloadHash, values.after.payloadHash, `${id}: complete applicable payload changed`);
    samples.push({ before: values.before, after: values.after });
  }
  records.push({ id, evidence, payloadEquality: true, pairs: samples });
  console.log(JSON.stringify({ candidate: id, pairs: samples.length, payloadEquality: true }));
}

/** 본문과 metadata를 포함한 완전한 PR fixture를 typed HTTP 적용 전후에 비교한다. */
async function typedReads(root: string, module: any) {
  const context = await module.captureGitHubRequestContext(root, { ...process.env }, ["repo"]);
  module.gitHubRepositoryScopes.learn(root, context, { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
  const value = JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", pullRequest: pr(), current: { headRefOid: pr().headRefOid, body: "" }, parents: { nodes: [] }, p7: pr() } } });
  let http = 0, cli = 0, credentials = 0;
  const runtime = new module.GitHubReadRuntime({ policy: async () => supportedPolicy,
    credentials: new module.GitHubCredentialProvider(async () => { credentials++; return "fixture-token"; }),
    cli: async () => { cli++; return value; }, http: { read: async () => { http++; return value; }, dispose: async () => {} } });
  const cache = new module.GitHubReadCache(runtime.execute, 30_000, runtime.prepare.bind(runtime)), runner = (args: any, cwd: any, options: any) => cache.read(args, cwd, options);
  const started = clock();
  try {
    const refs = await module.fetchPullRequestRefs(root, 7, runner);
    const prerequisites = await module.lookupPullRequestDependencies(root, pr(), [], undefined, runner);
    const details = await module.lookupPullRequestDependencyDetails(root, [7], undefined, runner);
    assert.equal(refs.number, 7); assert.equal(details[0].number, 7);
    return { wallMs: clock() - started, http, cli, credentials, payloadHash: digest({ refs, prerequisites, details }) };
  } finally { await cache.dispose(); await runtime.dispose(); }
}

async function run() {
  const env = await environment(), cleanup: Array<() => Promise<void>> = [];
  try {
    const root = await repository(env.root, "general"), html = await htmlFixture(env.root); cleanup.push(() => html.close());
    const comments = [{ id: 42, path: "file.txt", body: "Review comment", line: 1, html_url: "https://github.com/owner/repo/pull/7#discussion_r42", user: { login: "fixture" } }];
    await env.set([pr()], comments);
    await pairs("H1", "Controlled real TLS HTML plus actual fixture gh process; equal OAuth token across fallback paths", async module => {
      html.mode("dedup"); html.reset(); await env.reset(); const started = clock();
      const value = await module.readPullRequestSuggestedChangesets(root, "owner", "repo", 7,
        { webAccessToken: "fixture-token", networkPolicy: supportedPolicy }, [{ id: "42", url: comments[0].html_url }]);
      assert.equal(value.byCommentId.size, 0);
      return { wallMs: clock() - started, ...html.stats(), ...await env.calls(), payloadHash: digest(value) };
    });
    await pairs("H2", "Controlled real TLS, eight fragments, 15ms response delay; content-encoding negotiated normally", async (module, side) => {
      html.mode("fragments"); html.reset(); const started = clock();
      const context = side === "after" ? new after.GitHubWebReadContext({ policy: supportedPolicy, env: {} }) : undefined;
      try {
        const value = await module.readGitHubWebHtmlWithFragments("https://github.com/owner/repo/pull/7/files", {}, undefined, context);
        assert(value.ok); assert.equal((value.html.match(/fixture-code/g) ?? []).length, 8000);
        return { wallMs: clock() - started, ...html.stats(), payloadHash: digest({ html: value.html, finalUrl: value.finalUrl }) };
      } finally { await context?.dispose(); }
    });
    await pairs("H4", "Actual comment service/fake gh with real TLS enrichment delayed 200ms; before first display was final completion", async (module, side) => {
      html.mode("comments"); html.reset(); await env.reset(); let firstReadyMs: number | undefined;
      const started = clock(), service = new module.PullRequestReviewCommentService(root, { suggestedChangeset: { webAccessToken: "fixture-token", networkPolicy: supportedPolicy },
        onApiReady: () => { firstReadyMs = clock() - started; } });
      const value = await service.getActiveBranchReviewComments("main"), wallMs = clock() - started;
      assert.equal(value.comments.length, 1); assert.equal(value.comments[0].id, "42");
      if (side === "after") assert(firstReadyMs !== undefined && firstReadyMs < wallMs - 100);
      return { wallMs, firstReadyMs: firstReadyMs ?? wallMs, ...html.stats(), ...await env.calls(), payloadHash: digest(value) };
    });
    await pairs("M2", "Real production session/cache/routing with controlled complete GraphQL data; deterministic routing counts", module => typedReads(root, module));
    await pairs("M1", "Actual Conversation service; controlled complete 100-item terminal page and 15ms API delay", async (module, side) => {
      let requests = 0;
      const execute = async (args: string[], _root: string, options: any) => {
        requests++; await wait(15);
        const route = options.request?.path ?? args.at(-1)!, url = new URL(route.replace(/^\/?/, "/"), "https://api.github.com");
        const values = url.pathname.endsWith("/timeline") && url.searchParams.get("page") === "1"
          ? Array.from({ length: 100 }, (_, index) => ({ id: index, event: "commented", body: `Comment ${index}`, created_at: new Date(index * 1000).toISOString(), html_url: `https://github.com/owner/repo/issues/7#${index}` })) : [];
        const body = JSON.stringify(values);
        return side === "after" ? after.encodeRestPage(body, after.restPageMetadata(200, {})) : body;
      };
      const started = clock(), value = await module.buildPullRequestConversation(root, "owner/repo", { number: 7 }, "Opening", "fixture", execute);
      assert.equal(value.length, 101); return { wallMs: clock() - started, requests, payloadHash: digest(value) };
    });
    const advanceRoot = await repository(env.root, "advance"), merged = Array.from({ length: 8 }, (_, index) => pr(index + 1, `parent-${index}`, "MERGED"));
    for (let index = 0; index < 8; index++) { git(advanceRoot, "branch", `parent-${index}`); git(advanceRoot, "branch", `child-${index}`); git(advanceRoot, "config", `branch.child-${index}.gscStackParent`, `parent-${index}`); }
    await pairs("H3", "Actual native local branch metadata and eight parent PRs through fixture gh; no remote writes", async module => {
      await env.set(merged); await env.reset(); const started = clock(), value = await new module.PullRequestStackAdvanceService(advanceRoot).listCandidates();
      assert.equal(value.length, 8); return { wallMs: clock() - started, ...await env.calls(), payloadHash: digest(value) };
    });
    const submitRoot = await repository(env.root, "submit"), remote = join(env.root, "remote.git"); git(env.root, "init", "--bare", "-q", remote); git(submitRoot, "remote", "add", "origin", remote);
    const submitted = Array.from({ length: 8 }, (_, index) => ({ ...pr(index + 1, `topic-${index}`), baseRefName: index ? `topic-${index - 1}` : "main" }));
    for (let index = 0; index < 8; index++) { git(submitRoot, "branch", `topic-${index}`); git(submitRoot, "config", `branch.topic-${index}.gscStackParent`, index ? `topic-${index - 1}` : "main"); }
    git(submitRoot, "push", "-q", "origin", "--all");
    await pairs("M3", "Actual native Git gates/fetches against owned bare remote and fixture-only PR writes; eight existing layers", async module => {
      await env.set(submitted); await env.reset(); const started = clock(), value = await new module.PullRequestStackSubmitService(submitRoot).submit({ branch: "topic-7", remote: "origin", draft: false });
      assert.equal(value.layers.length, 8); assert(value.layers.every((layer: any) => layer.push === "unchanged"));
      const state = JSON.parse(await readFile(process.env.GSC_PERF_STATE!, "utf8"));
      assert(state.prs.every((item: any) => item.body.startsWith(`User body ${item.number}`) && item.body.includes("#8")));
      return { wallMs: clock() - started, ...await env.calls(), payloadHash: digest({ value, bodies: state.prs.map((item: any) => item.body) }) };
    });
    let catalogRequests = 0, catalogBytes = 0;
    const catalogBody = JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ full_name: `organization/private-${index}`, private: true, description: "fixture description ".repeat(30) })));
    const catalogServer = createServer(async (req, res) => { catalogRequests++; await wait(15); res.setHeader("etag", '"fixture-v1"');
      res.setHeader("link", '<https://api.github.com/user/repos?page=1>; rel="last"');
      if (req.headers["if-none-match"]) { res.writeHead(304); res.end(); } else { catalogBytes += Buffer.byteLength(catalogBody); res.setHeader("content-type", "application/json"); res.end(catalogBody); } });
    await new Promise<void>(resolve => catalogServer.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => { catalogServer.closeAllConnections(); await new Promise<void>(resolve => catalogServer.close(() => resolve())); });
    const catalogUrl = `http://127.0.0.1:${(catalogServer.address() as { port: number }).port}`;
    const catalogs = { before: new before.GitHubRepositoryCatalog((_url: string, options: any) => fetch(catalogUrl, options)), after: new after.GitHubRepositoryCatalog((_url: string, options: any) => fetch(catalogUrl, options)) };
    await catalogs.before.listPage("fixture-token"); await catalogs.after.listPage("fixture-token");
    await pairs("L1", "Native fetch against owned HTTP endpoint, current OAuth authorization on every reopening; real 200/304 bytes", async (_module, side) => {
      catalogRequests = 0; catalogBytes = 0; const started = clock(), value = await catalogs[side as "before" | "after"].listPage("fixture-token");
      assert.equal(value.repositories.length, 100);
      return { wallMs: clock() - started, requests: catalogRequests, responseBodyBytes: catalogBytes, nextPage: value.nextPage, payloadHash: digest(value) };
    });
    await catalogs.after.dispose(); await catalogs.before.dispose?.();
    const inspector = await inspectorFixture(); cleanup.push(() => inspector.close());
    await before.findInspectorWebSocketUrlForPid(654321, undefined, inspector.ports, "fixture");
    await after.findInspectorWebSocketUrlForPid(654321, undefined, inspector.ports, "fixture");
    await pairs("D1", "Real localhost HTTP/WebSocket probes, twenty empty ports and one matching target; every reconnect proves PID", async module => {
      inspector.reset(); const started = clock(), value = await module.findInspectorWebSocketUrlForPid(654321, undefined, inspector.ports, "fixture"); assert(value);
      return { wallMs: clock() - started, ...inspector.stats(), payloadHash: digest(value) };
    });
    const cloneCleanups: Array<() => Promise<void>> = [];
    const clone = await smartHttpCloneFixture({ after: (fn: () => Promise<void>) => cloneCleanups.push(fn) } as any, { auth: "native" });
    cleanup.push(async () => { for (const close of cloneCleanups) await close(); });
    await pairs("D2", "Actual native credential smart HTTP clone; all refs/parents/current checkout and old-blob hydration compared", async (module, side, index) => {
      clone.reset(); const started = clock(), value = await new module.RepositorySetupService(clone.execute).clone(clone.url, clone.root, `${side}-${index}`, { cloneMode: "blobless" });
      const wallMs = clock() - started, downloaded = clone.stats(), wasMissing = !await clone.hasObject(value.root, clone.oldBlob), beforeHydrate = clone.stats();
      const parents = await clone.git(value.root, "rev-list", "--all", "--parents"), refs = await clone.git(value.root, "for-each-ref", "--format=%(refname) %(objectname)");
      const currentContent = await readFile(join(value.root, "asset.txt")), hydrationStart = clock();
      const old = await clone.git(value.root, "show", `${clone.commits[0]}:asset.txt`), hydrationMs = clock() - hydrationStart;
      const hydrated = clone.stats(); assert.equal(old, await clone.git(clone.seed, "show", `${clone.commits[0]}:asset.txt`));
      assert.equal(await clone.git(value.root, "rev-parse", "--is-shallow-repository"), "false");
      assert.equal(wasMissing, side === "after"); assert.equal(await clone.hasObject(value.root, clone.oldBlob), true);
      return { wallMs, requests: downloaded.requests, responseBodyBytes: downloaded.bytes, historicalBlobDeferred: wasMissing,
        hydrationMs, hydrationRequests: hydrated.requests - beforeHydrate.requests, hydrationResponseBodyBytes: hydrated.bytes - beforeHydrate.bytes,
        payloadHash: digest({ branch: value.branch, parents, refs, current: currentContent.toString("base64"), old }) };
    });
    const result = { sourceBefore: process.env.GSC_FOLLOWUP_BASE, sourceAfter: process.env.GSC_FOLLOWUP_HEAD, node: process.version,
      git: git(env.root, "version"), recordedAt: new Date().toISOString(), evidencePolicy: "Controlled fixtures only; no private payload/auth headers included. Wall times include complete service work. Server bytes are HTTP response body bytes, not TCP packet bytes.", records };
    await writeFile(process.env.GSC_FOLLOWUP_RESULT!, JSON.stringify(result, null, 2) + "\n");
  } finally {
    for (const module of [before, after]) { const stop = module.beginGitHubReadLifetime(); await stop(); }
    for (const close of cleanup.reverse()) await close(); await env.cleanup();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
