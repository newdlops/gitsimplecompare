// 실제 서비스 조립을 통과하는 통제된 전후 비교다. GitHub 인터넷 지연 시간으로 해석하지 않는다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { createServer, request, type RequestOptions } from "node:https";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const directory = process.env.GSC_HTTP_NEXT_DIRECTORY!;
const sides = { before: require(join(directory, "before.cjs")), after: require(join(directory, "after.cjs")) };
const rounds = 5, delayMs = 8;
let serial = 0;
type Counts = { api: number; cli: number; credentials: number; bytes: number; connections: number; hydrated: number };
interface Sample { wallMs: number; counts: Omit<Counts, "bytes" | "credentials"> & { bytes: number | null; credentials: number | null }; payload: string; }

/** 객체 키 순서와 undefined의 표현 차이가 payload 비교를 왜곡하지 않게 한다. */
function canonical(value: any): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value));
}

/** 모든 지연은 fixture의 명시적 8ms이며 GitHub 서버/인터넷 상태를 대표하지 않는다. */
const delay = () => new Promise(resolve => setTimeout(resolve, delayMs));

/** 외부 API 한계를 대역 처리하면서 원래 DTO가 요구하는 identity와 연결을 유지한다. */
function node(number = 1): any {
  return { id: `PR-${number}`, number, title: `PR ${number}`, state: "OPEN", url: `https://github.com/owner/repo/pull/${number}`,
    headRefName: `topic-${number}`, baseRefName: "main", headRefOid: `head-${number}`, baseRefOid: "base",
    author: { login: "author" }, isDraft: false, comments: { totalCount: 0 }, files: { totalCount: 1 },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    commits: { nodes: [{ commit: { oid: `head-${number}`, messageHeadline: `Change ${number}`, author: { name: "Author" }, committedDate: "2026-11-01T00:00:00Z" } }], pageInfo: { hasNextPage: false } } };
}

/** 각 실행마다 별도 저장소/인증 파일과 native CLI 대역 counter를 만들고 사용자 설정은 읽지 않는다. */
async function fixture(api: any) {
  const root = join(directory, `repo-${++serial}`); await mkdir(root); await mkdir(join(root, ".git")); await mkdir(join(root, "gh"));
  await writeFile(join(root, ".git/config"), '[remote "origin"]\nurl = https://github.com/owner/repo.git\n');
  await writeFile(join(root, "gh/hosts.yml"), "fixture: benchmark\n");
  const counter = join(root, "cli-count"), executable = join(root, "gh-fixture"); await writeFile(counter, "0");
  const metadata = { ...node(), number: 7, url: "https://github.com/owner/repo/pull/7", headRefName: "topic" };
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2),p=${JSON.stringify(counter)};fs.writeFileSync(p,String(Number(fs.readFileSync(p))+1));setTimeout(()=>console.log(JSON.stringify(a[0]==='pr'?(a[1]==='list'?[]:${JSON.stringify(metadata)}):[{filename:'file.ts',status:'modified',additions:1,deletions:0}])),${delayMs});\n`);
  await chmod(executable, 0o755);
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_REPO", "GH_CONFIG_DIR", "GITHUB_CLI_PATH"]) delete process.env[key];
  Object.assign(process.env, { GH_HOST: "github.com", GH_REPO: "owner/repo", GH_CONFIG_DIR: join(root, "gh"), GITHUB_CLI_PATH: executable });
  api.clearGitHubRepositoryNameCache();
  const context = await api.captureGitHubRequestContext(root, { ...process.env }, ["repo"]);
  api.gitHubRepositoryScopes.learn(root, context, { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
  const counts: Counts = { api: 0, cli: 0, credentials: 0, bytes: 0, connections: 0, hydrated: 0 };
  return { root, counter, counts, metadata };
}

/** 내부 page envelope를 제외한 응답 JSON body bytes만 계측한다. HTTP 헤더/query/TLS bytes는 포함하지 않는다. */
function responseBytes(value: string): number {
  const parsed = JSON.parse(value);
  return Buffer.byteLength(parsed?.__gscRestPage === 1 && typeof parsed.body === "string" ? parsed.body : value);
}

/** 실제 reader 경계에서 요청 횟수와 응답 JSON 크기를 관찰한다. */
function boundary(counts: Counts, handler: (args: readonly string[], options: any) => Promise<string> | string) {
  return async (args: readonly string[], _root: string, options: any) => {
    counts.api++; await delay();
    const value = await handler(args, options);
    counts.bytes += responseBytes(value);
    return value;
  };
}

/** 실서비스의 runtime/cache/session 결합은 유지하고 외부 HTTP와 credential lookup만 통제한다. */
function runtime(api: any, f: Awaited<ReturnType<typeof fixture>>, handler: (request: any) => string) {
  const instance = new api.GitHubReadRuntime({ policy: async () => ({ transport: "auto", systemProxy: "none" }),
    credentials: new api.GitHubCredentialProvider(async () => { f.counts.credentials++; return "fixture-token"; }),
    cli: async () => { throw new Error("unexpected injected CLI"); },
    http: { read: async (request: any) => {
      f.counts.api++; await delay(); const value = handler(request);
      f.counts.bytes += responseBytes(value); return value;
    }, dispose: async () => {} } });
  const cache = new api.GitHubReadCache(instance.execute, 30_000, instance.prepare.bind(instance));
  return { run: (args: readonly string[], root: string, options: any) => cache.read(args, root, options),
    dispose: async () => { await cache.dispose(); await instance.dispose(); } };
}

/** 측정 대상 진입점 전후만 재며 fixture 준비나 certificate 생성은 제외한다. */
async function timed(f: Awaited<ReturnType<typeof fixture>>, action: () => Promise<any>): Promise<Sample> {
  const started = performance.now(), payload = await action(), wallMs = performance.now() - started;
  f.counts.cli = Number(await readFile(f.counter, "utf8"));
  // native CLI 대역은 명령마다 API 1회를 모델링한다. 내부 인증/HTTP bytes는 관찰하지 않아 null로 남긴다.
  f.counts.api += f.counts.cli;
  return { wallMs, counts: { ...f.counts, bytes: f.counts.cli ? null : f.counts.bytes,
    credentials: f.counts.cli ? null : f.counts.credentials }, payload: canonical(payload) };
}

/** N1은 실제 helper의 세션 경로와 baseline native CLI 프로세스 실행을 비교한다. */
async function changedFiles(api: any): Promise<Sample> {
  const f = await fixture(api), reads = runtime(api, f, () => api.encodeRestPage(JSON.stringify([{ filename: "file.ts", status: "modified", additions: 1, deletions: 0 }]), api.restPageMetadata(200, {})));
  const stop = api.beginGitHubReadLifetime();
  try { return await timed(f, () => api.fetchPullRequestChangedFiles(f.root, "owner/repo", 7, reads.run)); }
  finally { await reads.dispose(); await stop(); }
}

/** N2는 파일 100개의 마지막 페이지에서 불필요한 빈 요청을 실제 pagination reader로 관찰한다. */
async function restPages(api: any): Promise<Sample> {
  const f = await fixture(api);
  const run = boundary(f.counts, (_args, options) => {
    const url = new URL(options.request.path, "https://api.github.com"), page = Number(url.searchParams.get("page"));
    const values = url.pathname.endsWith("/files") && page === 1
      ? Array.from({ length: 100 }, (_, i) => ({ filename: `file-${i}`, status: "modified", additions: 1, deletions: 0 })) : [];
    const body = JSON.stringify(values);
    return options.request.responseMode === "page" ? api.encodeRestPage(body, api.restPageMetadata(200, {})) : body;
  });
  return timed(f, () => api.fetchPullRequestPreviewFiles(f.root, "owner/repo", 7, run));
}

/** N3는 쓰기 없이 실제 게시 서비스가 쓰는 preflight/postcreate 단계를 실행한다. */
async function publishReads(api: any): Promise<Sample> {
  const f = await fixture(api), reads = runtime(api, f, request => JSON.stringify({ data: { repository:
    request.variables.head ? { pullRequests: { nodes: [] } } : { pullRequest: f.metadata } } }));
  const service = new api.PullRequestPublishService(f.root, reads.run), stop = api.beginGitHubReadLifetime();
  try { return await timed(f, async () => {
    await service.assertNoOpenPullRequest("topic");
    return service.readPublishedPullRequest("topic", f.metadata.url, "fallback", "main", "head-1", false);
  }); } finally { await reads.dispose(); await stop(); }
}

/** N4는 warm 10개/cold 10개의 완전한 raw metadata와 원래 순서를 비교한다. */
async function mixedMetadata(api: any): Promise<Sample> {
  const f = await fixture(api), nodes = Array.from({ length: 20 }, (_, i) => node(i + 1)), byId = new Map(nodes.map(n => [n.id, n]));
  const known = new Map(nodes.slice(0, 10).map(n => [n.number, { number: n.number, headHash: n.headRefOid, baseHash: "base", baseRefName: "main",
    commitHashes: [n.headRefOid], commitSummaries: [{ hash: n.headRefOid, title: `Change ${n.number}`, author: "Author", dateIso: "2026-11-01T00:00:00Z" }],
    commitHashesComplete: true, fileCount: 1, fileCountComplete: true }]));
  const run = boundary(f.counts, (_args, options) => {
    const { variables, query } = options.request;
    const values = (ids: string[], stable: boolean) => ids.map(id => {
      const value = { ...byId.get(id) }; if (!stable) { delete value.commits; delete value.files; } return value;
    });
    return JSON.stringify({ data: variables.ids ? { nodes: values(variables.ids, query.includes("commits(")) }
      : { warm: values(variables.warmIds, false), cold: values(variables.coldIds, true) } });
  });
  return timed(f, () => api.readPullRequestNodes(f.root, nodes, new AbortController(), run, () => {}, known));
}

/** N5는 실제 commit-tail 시작을 기다려 고정 sleep 없이 검색 결과 중복을 재현한다. */
async function searchOverlap(api: any): Promise<Sample> {
  const f = await fixture(api), first = node(1); first.commits.pageInfo = { hasNextPage: true, endCursor: "tail" };
  let ready!: () => void; const tail = new Promise<void>(resolve => { ready = resolve; });
  const run = boundary(f.counts, async (args, options) => {
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
    if (options.operation === "pr-search") return JSON.stringify({ data: { search: { nodes: [first], issueCount: 1, pageInfo: { hasNextPage: false } } } });
    if (options.operation === "graph-pr-commit-page") { ready(); return JSON.stringify({ data: { repository: { pullRequest: node(1) } } }); }
    if (options.operation === "pr-search-associated") { await tail; return JSON.stringify([{ number: 1 }, { number: 2 }]); }
    const numbers = [...options.request.query.matchAll(/p(\d+):\s*pullRequest/g)].map((match: RegExpMatchArray) => Number(match[1]));
    f.counts.hydrated += numbers.length;
    return JSON.stringify({ data: { repository: Object.fromEntries(numbers.map(number => [`p${number}`, node(number)])) } });
  });
  return timed(f, async () => (await api.searchPullRequests(f.root, "abcdef0", undefined, undefined, run)).pullRequests);
}

/** N6는 원문 cache TTL을 쓰지 않고 같은 인증/앵커의 완전한 201개 요약을 재조회한다. */
async function previewSummaries(api: any): Promise<Sample> {
  const f = await fixture(api), hashes = Array.from({ length: 200 }, (_, i) => `commit-${i}`).concat("head");
  const selected = { number: 7, title: "Preview", state: "OPEN", url: "https://github.com/owner/repo/pull/7", headHash: "head", baseHash: "base",
    headRefName: "topic", baseRefName: "main", author: "author", isDraft: false, commentCount: 0, fileCount: 1, fileCountComplete: true, commitHashes: hashes };
  const reads = runtime(api, f, request => {
    const start = Number(request.variables.cursor ?? 0);
    return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo", pullRequest: {
      headRefOid: "head", baseRefOid: "base", baseRefName: "main", title: "Fresh title", body: "Fresh body",
      commits: { nodes: hashes.slice(start, start + 100).map(oid => ({ commit: { oid, messageHeadline: `Title ${oid}`, author: { name: "Author" }, committedDate: "2026-11-01T00:00:00Z" } })),
        pageInfo: { hasNextPage: start + 100 < hashes.length, endCursor: String(start + 100) } },
    } } } });
  });
  const load = async () => {
    const first = await api.fetchPreviewBootstrap(f.root, selected, reads.run);
    return api.fetchPreviewCommitSummaries(f.root, selected, reads.run, first.firstPage);
  };
  try { await load(); Object.assign(f.counts, { api: 0, bytes: 0, credentials: 0 }); return await timed(f, load); }
  finally { await reads.dispose(); }
}

/** N7만 실제 CA 검증 TLS를 사용한다. 서버 delay는 고정이며 인증 원문을 결과에 내보내지 않는다. */
async function htmlConnections(api: any): Promise<Sample> {
  const f = await fixture(api), cert = await readFile(join(directory, "cert")), key = await readFile(join(directory, "key"));
  const server = createServer({ cert, key }, async (_req, res) => {
    f.counts.api++; await delay(); const html = "<html>GitHub fixture</html>"; f.counts.bytes += Buffer.byteLength(html); res.end(html);
  });
  server.on("secureConnection", () => f.counts.connections++);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port, stop = api.beginGitHubReadLifetime();
  try { return await timed(f, async () => {
    const results = [];
    for (let i = 0; i < 2; i++) {
      const transport = new api.GitHubWebTransport({ ownedAgent: true, request: (options: RequestOptions, callback: any) =>
        request({ ...options, hostname: "127.0.0.1", port, servername: "localhost", ca: cert }, callback) });
      const context = new api.GitHubWebReadContext({ transport });
      try { results.push(await context.read("https://github.com/owner/repo/pull/7", { Cookie: "fixture-account" }, true)); }
      finally { await context.dispose(); }
    }
    return results;
  }); } finally { await stop(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

/** 작은 표본의 p95는 상위 관측치에 가깝다. 원본 모든 표본을 함께 보관한다. */
function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

/** 기준/현재 순서를 번갈아 실행해 한쪽이 항상 warm 환경을 받지 않게 한다. */
async function main() {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key"), "-out", join(directory, "cert"),
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-days", "2"], { stdio: "ignore" });
  const scenarios = { N1: changedFiles, N2: restPages, N3: publishReads, N4: mixedMetadata, N5: searchOverlap, N6: previewSummaries, N7: htmlConnections };
  const results: Record<string, any> = {};
  for (const [name, run] of Object.entries(scenarios)) {
    const samples: Record<string, Sample[]> = { before: [], after: [] };
    for (let round = 0; round < rounds; round++) {
      for (const side of round % 2 ? ["after", "before"] as const : ["before", "after"] as const) samples[side].push(await run(sides[side]));
      assert.equal(samples.before[round].payload, samples.after[round].payload, `${name} payload mismatch`);
    }
    const stats = (values: Sample[]) => ({ p50Ms: percentile(values.map(v => v.wallMs), 0.5), p95Ms: percentile(values.map(v => v.wallMs), 0.95),
      samples: values.map(({ payload, ...sample }) => sample) });
    results[name] = { payloadEqual: true, before: stats(samples.before), after: stats(samples.after) };
    console.log(`${name}: payload equal, ${rounds} alternating pairs`);
  }
  await writeFile(process.env.GSC_HTTP_NEXT_RESULT!, JSON.stringify({ sourceBefore: process.env.GSC_HTTP_NEXT_BASE, sourceAfter: process.env.GSC_HTTP_NEXT_HEAD,
    node: process.version, fixtureDelayMs: delayMs, pairsPerCandidate: rounds, scope: "controlled service/CLI/TLS fixtures; not live GitHub latency",
    bytesMetric: "response body bytes excluding internal page envelopes, request documents, HTTP headers and TLS; native CLI bytes/auth unknown=null; native CLI fixture models one API read per invocation", results }, null, 2) + "\n");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
