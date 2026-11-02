// 실제 서비스·세션을 통과하는 통제된 전후 비교다. 실제 GitHub 지연은 P6 별도 실험에만 있다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const directory = process.env.GSC_CRITICAL_DIRECTORY!;
const sides = { before: require(join(directory, "before.cjs")), after: require(join(directory, "after.cjs")) };
const rounds = 5, wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let serial = 0;
interface Counts { api: number; bodyBytes: number; credentials: number; active: number; maximum: number; }
interface Sample { wallMs: number; counts: Omit<Counts, "active" | "maximum"> & { maximum: number | null }; payload: string; events?: string[]; }

/** 객체 키 삽입 순서와 undefined를 제외하고 모든 사용자 값·배열 순서를 같은 digest로 비교한다. */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, item[key]])) : item)).digest("hex");
}

/** 비교 DTO에 필요한 앵커와 완전한 connection을 가진 고정 PR이다. */
function pr(): any { return { number: 7, title: "Fixture", state: "OPEN", url: "https://github.com/owner/repo/pull/7",
  headRefName: "topic", baseRefName: "main", headHash: "head", baseHash: "base", headRefOid: "head", baseRefOid: "base",
  fileCount: 3, fileCountComplete: true, comments: { totalCount: 1 }, files: { totalCount: 3 },
  commits: { nodes: [{ commit: { oid: "head", messageHeadline: "Head" } }], pageInfo: { hasNextPage: false } },
  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } }; }

/** 사용자 Git/gh 환경을 자식 benchmark 안에서만 대체하고 root마다 실제 설정 파일을 격리한다. */
async function fixture(api: any) {
  const root = join(directory, `fixture-${++serial}`); await mkdir(root); await mkdir(join(root, ".git")); await mkdir(join(root, "gh"));
  await writeFile(join(root, ".git/config"), '[remote "origin"]\nurl=https://github.com/owner/repo.git\n');
  await writeFile(join(root, "gh/hosts.yml"), "fixture: original\n");
  for (const key of Object.keys(process.env)) if (/^(?:GIT_|GCM_|GH_|GITHUB_)/.test(key) || /^(?:https?_proxy|all_proxy|no_proxy|node_extra_ca_certs)$/i.test(key)) delete process.env[key];
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GH_REPO: "owner/repo", GH_HOST: "github.com", GH_CONFIG_DIR: join(root, "gh") });
  const context = await api.captureGitHubRequestContext(root, { ...process.env }, ["repo"]);
  api.gitHubRepositoryScopes.learn(root, context, { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
  const counts: Counts = { api: 0, bodyBytes: 0, credentials: 0, active: 0, maximum: 0 };
  return { root, counts };
}

/** 실제 인증·cache·session을 사용하고 HTTP 응답만 8ms 경계로 대체한다. */
function reads(api: any, f: Awaited<ReturnType<typeof fixture>>, handler: (request: any) => string, auth = { token: "one" }) {
  const runtime = new api.GitHubReadRuntime({ policy: async () => ({ transport: "auto", systemProxy: "none" }),
    credentials: new api.GitHubCredentialProvider(async () => { f.counts.credentials++; return auth.token; }),
    cli: async () => { throw new Error("Unexpected CLI in HTTP fixture"); },
    http: { read: async (request: any) => {
      f.counts.api++; f.counts.maximum = Math.max(f.counts.maximum, ++f.counts.active);
      try { await wait(8); const value = handler(request), parsed = JSON.parse(value);
        f.counts.bodyBytes += Buffer.byteLength(parsed?.__gscRestPage === 1 ? parsed.body : value); return value;
      } finally { f.counts.active--; }
    }, dispose: async () => {} } });
  const cache = new api.GitHubReadCache(runtime.execute, 30_000, runtime.prepare.bind(runtime));
  return { execute: (args: any, root: any, options: any) => cache.read(args, root, { ...options, ttlMs: 0 }),
    close: async () => { await cache.dispose(); await runtime.dispose(); } };
}

/** 준비·seed·정리를 제외하고 사용자 결과와 실제 요청 경계만 측정한다. */
async function timed(counts: Counts, action: () => Promise<unknown>, events?: string[]): Promise<Sample> {
  const started = performance.now(), value = await action(), wallMs = performance.now() - started;
  const { active, ...observed } = counts; assert.equal(active, 0);
  return { wallMs, counts: observed, payload: digest(value), ...(events ? { events } : {}) };
}

/** 리뷰 60ms·commit 20ms의 독립 tail로 같은 완전한 DTO를 조립한다. */
async function search(api: any): Promise<Sample> {
  const counts: Counts = { api: 0, bodyBytes: 0, credentials: 0, active: 0, maximum: 0 }, events: string[] = [];
  const node = pr(); node.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "review" }; node.commits.pageInfo = { hasNextPage: true, endCursor: "commits" };
  return timed(counts, () => api.completeSearchPullRequests("/fixture", "owner", "repo", [node], async (_a: any, _r: any, options: any) => {
    const review = options.operation.includes("review"), name = review ? "review" : "commit";
    counts.api++; counts.maximum = Math.max(counts.maximum, ++counts.active); events.push(`${name}:start`);
    await wait(review ? 60 : 20); events.push(`${name}:end`); counts.active--;
    const value = JSON.stringify({ data: { repository: { pullRequest: { headRefOid: "head", baseRefOid: "base",
      ...(review ? { reviewThreads: { nodes: [{ comments: { totalCount: 2 } }], pageInfo: { hasNextPage: false } } }
        : { commits: { nodes: [{ commit: { oid: "tail", messageHeadline: "Tail" } }], pageInfo: { hasNextPage: false } } }) } } } });
    counts.bodyBytes += Buffer.byteLength(value); return value;
  }), events);
}

/** rename 없는 raw 파일 1000개를 seed하고 이후 Explorer 조회만 측정한다. */
async function comparison(api: any): Promise<Sample> {
  const f = await fixture(api), transport = reads(api, f, request => {
    if (request.kind === "graphql") {
      const start = Number(request.variables.cursor ?? 0), projected = request.query.includes("nodes { path");
      return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", pullRequest: {
        number: 7, headRefOid: "head", baseRefOid: "base",
        ...(projected ? { comments: { totalCount: 0 }, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } : {}),
        files: { totalCount: 1000, ...(projected ? { nodes: Array.from({ length: 100 }, (_, i) => ({ path: `file-${start + i}.ts`, additions: 2, deletions: 1, changeType: "MODIFIED" })),
          pageInfo: { hasNextPage: start + 100 < 1000, endCursor: String(start + 100) } } : {}) } } } } });
    }
    const url = new URL(request.path, "https://api.github.com"), page = Number(url.searchParams.get("page"));
    const next = new URL(url); next.searchParams.set("page", String(page + 1));
    return api.encodeRestPage(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ filename: `file-${(page - 1) * 100 + i}.ts`, additions: 2, deletions: 1, status: "modified" }))),
      api.restPageMetadata(200, page < 10 ? { link: `<${next}>; rel="next"` } : {}));
  });
  try {
    await api.fetchPullRequestDetail(f.root, "owner/repo", 7, undefined, transport.execute);
    Object.assign(f.counts, { api: 0, bodyBytes: 0, credentials: 0, maximum: 0 });
    return await timed(f.counts, () => api.fetchPullRequestChangedFiles(f.root, "owner/repo", 7, transport.execute));
  } finally { await transport.close(); }
}

/** 같은 커밋 201개를 쿼리 투영에 맞춰 반환하며 cold·warm·별도 인증 miss를 비교한다. */
async function preview(api: any, mode: "cold" | "warm" | "stale"): Promise<Sample> {
  const f = await fixture(api), auth = { token: "one" }, selected = pr(), hashes = Array.from({ length: 200 }, (_, i) => `commit-${i}`).concat("head");
  const transport = reads(api, f, request => {
    const start = Number(request.variables.cursor ?? 0), projected = /\bcommits\s*\(/.test(request.query);
    return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", pullRequest: {
      ...(request.query.includes("title body") ? { title: "Fresh title", body: "fresh body" } : {}),
      headRefOid: "head", baseRefOid: "base", baseRefName: "main",
      ...(projected ? { commits: { nodes: hashes.slice(start, start + 100).map(oid => ({ commit: { oid, messageHeadline: `Title ${oid}`, author: { name: "Author" }, committedDate: "2026-11-02T00:00:00Z" } })),
        pageInfo: { hasNextPage: start + 100 < hashes.length, endCursor: String(start + 100) } } } : {}) } } } });
  }, auth);
  const load = async () => { const first = await api.fetchPreviewBootstrap(f.root, selected, transport.execute);
    return { repository: first.repository, title: first.title, body: first.body,
      commits: await api.fetchPreviewCommitSummaries(f.root, selected, transport.execute, first.firstPage) }; };
  try {
    if (mode !== "cold") { await load(); if (mode === "stale") auth.token = "two"; }
    Object.assign(f.counts, { api: 0, bodyBytes: 0, credentials: 0, maximum: 0 });
    return await timed(f.counts, load);
  } finally { await transport.close(); }
}

/** A15ms·B80ms·C15ms HTML을 실제 context의 두 슬롯에서 읽어 같은 BFS 본문으로 합친다. */
async function fragments(api: any): Promise<Sample> {
  const counts: Counts = { api: 0, bodyBytes: 0, credentials: 0, active: 0, maximum: 0 }, events: string[] = [];
  const context = new api.GitHubWebReadContext({ transport: { read: async (url: string) => {
    const tail = new URL(url).pathname.split("/").at(-1)!; events.push(`${tail}:start`); counts.api++; counts.maximum = Math.max(counts.maximum, ++counts.active);
    if (tail !== "files") await wait(tail === "b" ? 80 : 15);
    const html = tail === "files" ? '<html>GitHub<include-fragment src="fragment/a"></include-fragment><include-fragment src="fragment/b"></include-fragment></html>'
      : `<div>${tail}${tail === "a" ? '<include-fragment src="fragment/c"></include-fragment>' : ''}</div>`;
    counts.bodyBytes += Buffer.byteLength(html); counts.active--; events.push(`${tail}:end`); return { ok: true, html, finalUrl: url };
  }, dispose: async () => {} } });
  try { return await timed(counts, () => api.readGitHubWebHtmlWithFragments("https://github.com/owner/repo/pull/7/files", {}, undefined, context), events); }
  finally { await context.dispose(); }
}

/** 실제 localhost HTTP/WS로 무관한 100ms 응답보다 먼저 소유 PID를 찾는지 측정한다. */
async function inspector(api: any): Promise<Sample> {
  const counts: Counts = { api: 0, bodyBytes: 0, credentials: 0, active: 0, maximum: 0 }, events: string[] = [];
  const first = createServer((_req, res) => { counts.api++; counts.bodyBytes += 2; res.end("[]"); });
  let targetUrl = "";
  const target = createServer((_req, res) => { counts.api++; const body = JSON.stringify([{ webSocketDebuggerUrl: targetUrl }]); counts.bodyBytes += Buffer.byteLength(body); events.push("target:http"); res.end(body); });
  const slow = createServer((_req, res) => { counts.api++; events.push("unrelated:start"); const timer = setTimeout(() => { events.push("unrelated:end"); counts.bodyBytes += 2; res.end("[]"); }, 100);
    res.once("close", () => clearTimeout(timer)); });
  const ws = new WebSocketServer({ server: target });
  ws.on("connection", socket => socket.on("message", raw => { const request = JSON.parse(String(raw)); assert.equal(request.params.expression, "process.pid");
    events.push("target:pid"); socket.send(JSON.stringify({ id: request.id, result: { result: { value: 456789 } } })); }));
  for (const server of [first, target, slow]) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server: any) => server.address().port; targetUrl = `ws://127.0.0.1:${port(target)}/owned`;
  const profile = `critical-${++serial}`;
  try { const sample = await timed(counts, async () => { assert.equal(await api.findInspectorWebSocketUrlForPid(456789, undefined, [port(first), port(target), port(slow)], profile), targetUrl); return "verified-owned-target"; }, events);
    return { ...sample, counts: { ...sample.counts, maximum: null } }; }
  finally { api.clearInspectorPortHints(profile); for (const client of ws.clients) client.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    for (const server of [first, target, slow]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}

/** 모든 원 표본을 보존하고 소표본 p95를 일반적인 서비스 보장으로 해석하지 않는다. */
function stats(samples: Sample[]) {
  const values = samples.map(sample => sample.wallMs).sort((a, b) => a - b);
  return { p50Ms: values[Math.ceil(values.length * .5) - 1], p95Ms: values[Math.ceil(values.length * .95) - 1],
    samples: samples.map(({ payload, ...sample }) => sample), payloadSha256: samples[0].payload };
}

/** 순서를 교대하며 매번 payload 동등성을 검증하고 cold·warm·miss를 구분해 보고한다. */
async function main() {
  const scenarios = { P1: search, P2: comparison, P3cold: (api: any) => preview(api, "cold"), P3warm: (api: any) => preview(api, "warm"),
    P3staleHint: (api: any) => preview(api, "stale"), P4: fragments, P5: inspector };
  const results: Record<string, unknown> = {};
  for (const [name, run] of Object.entries(scenarios)) {
    const samples: Record<keyof typeof sides, Sample[]> = { before: [], after: [] };
    for (let round = 0; round < rounds; round++) {
      for (const side of round % 2 ? ["after", "before"] as const : ["before", "after"] as const) samples[side].push(await run(sides[side]));
      assert.equal(samples.before[round].payload, samples.after[round].payload, `${name} payload mismatch`);
    }
    results[name] = { payloadEqual: true, before: stats(samples.before), after: stats(samples.after) };
    console.log(`${name}: ${rounds} alternating pairs, payload equal`);
  }
  await writeFile(process.env.GSC_CRITICAL_RESULT!, JSON.stringify({ sourceBefore: process.env.GSC_CRITICAL_BASE, sourceAfter: process.env.GSC_CRITICAL_HEAD,
    node: process.version, pairs: rounds, scope: "controlled actual service functions; simulated API delay or owned localhost HTTP/WS; not live GitHub latency",
    fixtureDelaysMs: { API: 8, searchReview: 60, searchCommit: 20, fragmentA: 15, fragmentB: 80, fragmentC: 15, unrelatedInspector: 100 },
    bodyMetric: "decoded response body bytes, excluding REST envelopes, request documents, HTTP/WS framing and TLS; no wire-byte claim",
    mutableApiCacheTtlMs: 0, results }, null, 2) + "\n");
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
