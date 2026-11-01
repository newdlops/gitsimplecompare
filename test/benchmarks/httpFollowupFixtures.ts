// 성능 비교는 임시 Git·가짜 gh·localhost만 사용하고 실제 계정/원격 쓰기를 사용하지 않는다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, request, get, type RequestOptions } from "node:https";
import https = require("node:https");
import * as http from "node:http";
import { gzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { mkdir, mkdtemp, readFile, writeFile, chmod, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { urlToHttpOptions } from "node:url";

export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** 객체 key의 삽입 순서만 정규화하며 모든 값·배열·Map 항목은 빠짐없이 비교한다. */
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item) => {
  if (item instanceof Map) return [...item];
  return item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
})).digest("hex");
export const clock = () => Number(process.hrtime.bigint()) / 1e6;
export const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** 실제 GitHub 응답의 head/본문/선택 필드를 가진 고정 fixture다. */
export function pr(number = 7, headRefName = "main", state = "OPEN"): any {
  return { number, title: `Fixture ${number}`, body: `User body ${number}`, state, url: `https://github.com/owner/repo/pull/${number}`,
    headRefName, baseRefName: "main", headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40), headHash: "a".repeat(40), baseHash: "b".repeat(40),
    isCrossRepository: false, isDraft: false, headRepositoryOwner: { login: "owner" }, author: { login: "fixture" }, createdAt: "2020-01-01T00:00:00Z",
    files: { totalCount: 1 }, comments: { totalCount: 0 }, commits: { nodes: [{ commit: { oid: "a".repeat(40), messageHeadline: "Fixture" } }], pageInfo: { hasNextPage: false } },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } };
}

/** 사용자 Git 설정/인증 환경을 벤치마크 자식 프로세스에서만 격리한다. */
export async function environment() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gsc-http-followup-bench-")));
  for (const key of Object.keys(process.env)) if (/^(?:GIT_|GCM_|GH_|GITHUB_)/.test(key) || /^(?:https?_proxy|all_proxy|no_proxy|node_extra_ca_certs)$/i.test(key)) delete process.env[key];
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never",
    GH_REPO: "owner/repo", GH_HOST: "github.com", GH_CONFIG_DIR: join(root, "gh"), GSC_PERF_COUNT_FILE: join(root, "calls"), GSC_PERF_STATE: join(root, "state") });
  await mkdir(process.env.GH_CONFIG_DIR!); await writeFile(join(process.env.GH_CONFIG_DIR!, "hosts.yml"), "fixture: benchmark\n");
  const executable = join(root, "gh.js");
  await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2),s=JSON.parse(fs.readFileSync(process.env.GSC_PERF_STATE,'utf8'));
const kind=a.slice(0,2).join('/');fs.appendFileSync(process.env.GSC_PERF_COUNT_FILE,kind+'\\n');
const out=v=>process.stdout.write(typeof v==='string'?v:JSON.stringify(v));
const flag=n=>a[a.indexOf(n)+1];const save=()=>fs.writeFileSync(process.env.GSC_PERF_STATE,JSON.stringify(s));
if(a[0]==='auth'){out('fixture-token');process.exit(0)}
if(a[0]==='repo'){out({nameWithOwner:'owner/repo',url:'https://github.com/owner/repo',defaultBranchRef:{name:'main'}});process.exit(0)}
if(a[0]==='pr'&&a[1]==='list'){out(s.prs.filter(p=>p.state==='OPEN'));process.exit(0)}
if(a[0]==='pr'&&a[1]==='view'){out(s.prs.find(p=>String(p.number)===a[2]||p.headRefName===a[2])||s.prs[0]);process.exit(0)}
if(a[0]==='pr'&&a[1]==='edit'){const p=s.prs.find(p=>String(p.number)===a[2]);if(a.includes('--body'))p.body=flag('--body');if(a.includes('--base'))p.baseRefName=flag('--base');save();out(p.url);process.exit(0)}
if(a[0]==='api'&&a[1]==='graphql'){
 const q=(a.find(v=>v.startsWith('query='))||'').slice(6),v=Object.fromEntries(a.filter(x=>/^[A-Za-z][A-Za-z0-9_]*=/.test(x)).map(x=>{let i=x.indexOf('=');return[x.slice(0,i),x.slice(i+1)]}));
 const r={nameWithOwner:'owner/repo',url:'https://github.com/owner/repo',defaultBranchRef:{name:'main'},pullRequest:s.prs[0],current:{headRefOid:s.prs[0]?.headRefOid,body:''},parents:{nodes:[]}};
 for(const m of q.matchAll(/(p\\d+):\\s*pullRequests\\(headRefName:\\s*\\$(head\\d+)/g))r[m[1]]={nodes:s.prs.filter(p=>p.headRefName===v[m[2]])};
 for(const m of q.matchAll(/(p\\d+):\\s*pullRequest\\(number:\\s*\\$(number\\d+)/g))r[m[1]]=s.prs.find(p=>String(p.number)===v[m[2]])||null;
 for(const p of s.prs)if(!Object.hasOwn(r,'p'+p.number))r['p'+p.number]=p;out({data:{repository:r}});process.exit(0)
}
if(a[0]==='api'){const route=a.find(x=>x.includes('repos/')||x.startsWith('https://'))||'';out(route.includes('/comments?')?s.comments:[]);process.exit(0)}
throw Error('Unexpected fixture command');
`);
  await chmod(executable, 0o755); process.env.GITHUB_CLI_PATH = executable;
  const set = (prs: any[], comments: any[] = []) => writeFile(process.env.GSC_PERF_STATE!, JSON.stringify({ prs, comments }));
  const reset = () => writeFile(process.env.GSC_PERF_COUNT_FILE!, "");
  const calls = async () => {
    const rows = (await readFile(process.env.GSC_PERF_COUNT_FILE!, "utf8")).trim().split("\n").filter(Boolean);
    return { reads: rows.filter(row => /^(?:api|repo|pr\/view|pr\/list)/.test(row) && row !== "api/https:").length,
      cliCalls: rows.length, authCalls: rows.filter(row => row === "auth/token").length,
      graphql: rows.filter(row => row === "api/graphql").length, prViews: rows.filter(row => row === "pr/view").length,
      broad: rows.filter(row => row === "repo/view" || row === "pr/list").length, writes: rows.filter(row => row === "pr/edit").length };
  };
  await set([pr()]); await reset();
  return { root, set, reset, calls, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** 사용자 외부 설정 없이 commit과 branch만 가진 native Git fixture를 만든다. */
export async function repository(parent: string, name: string) {
  const root = join(parent, name); await mkdir(root);
  git(root, "-c", "init.templateDir=", "init", "-q", "-b", "main");
  for (const [key, value] of Object.entries({ "user.name": "Fixture", "user.email": "fixture@example.invalid", "core.hooksPath": "/dev/null", "commit.gpgSign": "false" })) git(root, "config", key, value);
  await writeFile(join(root, "file.txt"), "fixture\n"); git(root, "add", "file.txt"); git(root, "commit", "-qm", "Fixture");
  return root;
}

/** GitHub HTML만 TLS 검증을 유지한 localhost에 대응시키고 원래 request/get을 반드시 복원한다. */
export async function htmlFixture(root: string) {
  const key = join(root, "tls-key"), certPath = join(root, "tls-cert");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certPath, "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-days", "2"], { stdio: "ignore" });
  const cert = await readFile(certPath); let mode = "dedup", requests = 0, bytes = 0, connections = 0;
  const server = createServer({ key: await readFile(key), cert }, async (req, res) => {
    requests++;
    let body: string;
    if (mode === "dedup") { if (req.url?.endsWith("/files")) { res.writeHead(403); res.end(); return; } body = "<html>GitHub empty suggestions</html>"; }
    else if (mode === "comments") { await wait(200); body = "<html>GitHub enrichment finished</html>"; }
    else {
      await wait(15);
      body = req.url?.endsWith("/files") ? '<html>GitHub' + Array.from({ length: 8 }, (_, index) => `<include-fragment src="/owner/repo/pull/7/fragment/${index}"></include-fragment>`).join("") + '</html>' : '<div>' + "fixture-code\n".repeat(1000) + '</div>';
    }
    const zipped = req.headers["accept-encoding"]?.includes("gzip"), data = zipped ? gzipSync(Buffer.from(body)) : Buffer.from(body);
    if (zipped) res.setHeader("content-encoding", "gzip"); bytes += data.length; res.end(data);
  });
  server.on("secureConnection", () => connections++);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  const originalRequest = https.request, originalGet = https.get;
  const patched: any = (input: any, options: any, callback?: any) => {
    const args: RequestOptions = typeof input === "string" || input instanceof URL ? { ...urlToHttpOptions(new URL(input)), ...(typeof options === "object" ? options : {}) } : { ...input };
    const cb = typeof options === "function" ? options : callback;
    if (args.hostname === "github.com") Object.assign(args, { hostname: "127.0.0.1", port, servername: "localhost", ca: cert });
    else assert.fail("HTML benchmark attempted an external hostname");
    return originalRequest(args, cb);
  };
  (https as any).request = patched; (https as any).get = (...args: any[]) => { const req = patched(...args); req.end(); return req; };
  return { mode: (value: string) => { mode = value; }, reset: () => { requests = 0; bytes = 0; connections = 0; }, stats: () => ({ requests, responseBodyBytes: bytes, newConnections: connections }),
    async close() { (https as any).request = originalRequest; (https as any).get = originalGet; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

/** 실제 HTTP/WebSocket PID probe 횟수를 검증하며 사용자의 다른 앱 inspector는 사용하지 않는다. */
export async function inspectorFixture() {
  let requests = 0, pidProbes = 0;
  const servers: http.Server[] = [], sockets: WebSocketServer[] = [], ports: number[] = [];
  for (let index = 0; index < 21; index++) {
    let port = 0;
    const server = http.createServer((_req, res) => { requests++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(index === 20 ? [{ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/fixture` }] : [])); });
    const ws = new WebSocketServer({ server }); ws.on("connection", socket => socket.on("message", raw => { pidProbes++; const message = JSON.parse(String(raw)); socket.send(JSON.stringify({ id: message.id, result: { result: { value: 654321 } } })); }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); port = (server.address() as { port: number }).port;
    ports.push(port); servers.push(server); sockets.push(ws);
  }
  return { ports, reset: () => { requests = 0; pidProbes = 0; }, stats: () => ({ requests, pidProbes }), async close() {
    for (const socket of sockets) { for (const client of socket.clients) client.terminate(); await new Promise<void>(resolve => socket.close(() => resolve())); }
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  } };
}
