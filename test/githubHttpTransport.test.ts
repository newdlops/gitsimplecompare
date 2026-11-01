import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createServer, request, type RequestOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { GitHubHttpTransport } from "../src/git/githubHttpTransport";
import { GitHubCredentialProvider } from "../src/git/githubCredential";
import { graphqlRead, restRead } from "../src/git/githubReadRequest";
import { graphQLResult } from "../src/git/githubApiError";
import { GitHubHttpPool } from "../src/git/githubHttpPool";
import { EventEmitter } from "node:events";

/** 로컬 TLS 검증도 유지하면서 production API 요청을 fixture 서버로만 보낸다. */
async function fixture(t: test.TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const root = await mkdtemp(join(tmpdir(), "gsc-http-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "key"),
    "-out", join(root, "cert"), "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-days", "2"], { stdio: "ignore" });
  const cert = await readFile(join(root, "cert")), key = await readFile(join(root, "key"));
  const server = createServer({ cert, key }, handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  let requests = 0, connections = 0;
  server.on("secureConnection", () => connections++);
  const transport = new GitHubHttpTransport({ request: (options: RequestOptions, callback) => {
    requests++;
    return request({ ...options, hostname: "127.0.0.1", port: address.port, servername: "localhost", ca: cert }, callback);
  } });
  const provider = new GitHubCredentialProvider();
  const credential = await provider.acquire(root, { GH_TOKEN: "fixture-token" });
  t.after(async () => {
    await transport.dispose(); await provider.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const read = (path: string, options: { signal?: AbortSignal; maxBufferBytes?: number } = {}) =>
    transport.read(restRead(path).request, credential, { operation: "fixture", deadline: Date.now() + 3000, ...options });
  return { transport, credential, read, count: () => ({ requests, connections }) };
}

test("HTTP reuses keep-alive, validates JSON and conditionally reuses a complete REST body", async t => {
  const f = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    if (req.headers["if-none-match"]) { res.writeHead(304); res.end(); }
    else { res.writeHead(200, { etag: '"v1"' }); res.end('{"ok":true}'); }
  });
  assert.equal(await f.read("/fixture"), '{"ok":true}');
  assert.equal(await f.read("/fixture"), '{"ok":true}');
  assert.deepEqual(f.count(), { requests: 2, connections: 1 });
});

test("304 without a complete body performs one unconditional read", async t => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => {
    calls++; res.writeHead(calls === 1 ? 304 : 200); res.end(calls === 1 ? "" : '{"ok":true}');
  });
  assert.equal(await f.read("/missing"), '{"ok":true}'); assert.equal(calls, 2);
});

test("REST allows only bounded same-origin redirects; GraphQL never redirects", async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === "/safe") { res.end('{"ok":true}'); return; }
    res.writeHead(302, { location: req.url === "/start" ? "/safe" : "https://other.example/steal" }); res.end();
  });
  assert.equal(await f.read("/start"), '{"ok":true}');
  await assert.rejects(f.read("/bad"), { kind: "redirect" });
  await assert.rejects(f.transport.read(graphqlRead("query{viewer{login}}").request, f.credential,
    { operation: "fixture", deadline: Date.now() + 3000 }), { kind: "redirect" });
  assert.equal(f.count().requests, 4);
});

test("partial GraphQL and HTTP authentication failures remain safe failures", async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === "/auth") { res.writeHead(401); res.end('{"token":"fixture-secret"}'); }
    else res.end('{"data":{"repository":{"pr":null}},"errors":[{"type":"NOT_FOUND","path":["repository","pr"]}]}');
  });
  await assert.rejects(f.transport.read(graphqlRead("query{viewer{login}}").request, f.credential,
    { operation: "fixture", deadline: Date.now() + 3000 }), error => {
    assert.equal((error as any).kind, "graphql"); assert(graphQLResult(error));
    assert.equal("stdout" in (error as object), false); return true;
  });
  await assert.rejects(f.read("/auth"), error => {
    assert.equal((error as any).kind, "auth"); assert(!JSON.stringify(error).includes("fixture-secret")); return true;
  });
  await assert.rejects(f.read("/after"), { kind: "auth" });
  assert.equal(f.count().requests, 2);
});

test("compressed and decoded bodies independently obey the byte cap", async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === "/gzip") { res.writeHead(200, { "content-encoding": "gzip" }); res.end(gzipSync('"' + "a".repeat(10000) + '"')); }
    else res.end('"' + "a".repeat(10000) + '"');
  });
  await assert.rejects(f.read("/gzip", { maxBufferBytes: 1000 }), { kind: "limit" });
  await assert.rejects(f.read("/raw", { maxBufferBytes: 1000 }), { kind: "limit" });
});

test("one aborted request closes independently and other pooled requests complete", async t => {
  let closed!: () => void;
  const didClose = new Promise<void>(resolve => { closed = resolve; });
  const f = await fixture(t, (req, res) => {
    if (req.url === "/slow") { req.on("close", closed); res.write("{"); }
    else res.end('{"ok":true}');
  });
  const controller = new AbortController();
  const slow = f.read("/slow", { signal: controller.signal });
  const rejected = assert.rejects(slow, { name: "AbortError" });
  await new Promise(resolve => setTimeout(resolve, 50)); controller.abort();
  assert.equal(await f.read("/other"), '{"ok":true}');
  await rejected;
  await didClose;
  assert.equal(await f.read("/other"), '{"ok":true}');
});

test("rate limit cooldown rejects a later request without another network call", async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(429, { "retry-after": "30" }); res.end("{}"); });
  await assert.rejects(f.read("/limited"), { kind: "rate-limit" });
  await assert.rejects(f.read("/limited"), { kind: "rate-limit" });
  assert.equal(f.count().requests, 1);
});

test("pool bounds four contexts and cancels a fifth waiter without disrupting active leases", async () => {
  const pool = new GitHubHttpPool(10);
  const leases = await Promise.all(["a", "b", "c", "d"].map(key => pool.acquire(key)));
  const controller = new AbortController();
  const fifth = pool.acquire("e", controller.signal);
  const rejected = assert.rejects(fifth, { name: "AbortError" }); controller.abort(); await rejected;
  const same = await pool.acquire("a"); assert.equal(same.agent, leases[0].agent); same.release();
  leases[0].release();
  const replacement = await pool.acquire("e"); assert.notEqual(replacement.agent, leases[0].agent);
  replacement.release(); for (const lease of leases.slice(1)) lease.release();
  pool.dispose();
});

test("only a reused socket reset before response permits exactly one retry", async () => {
  const provider = new GitHubCredentialProvider();
  const credential = await provider.acquire("/fixture", { GH_TOKEN: "fixture-token" });
  for (const reused of [true, false]) {
    let calls = 0;
    const transport = new GitHubHttpTransport({ request: () => {
      calls++;
      const req = new EventEmitter() as any;
      req.reusedSocket = reused;
      req.destroy = () => queueMicrotask(() => req.emit("close"));
      req.end = () => queueMicrotask(() => { req.emit("error", Object.assign(new Error("fixture"), { code: "ECONNRESET" })); req.emit("close"); });
      return req;
    } });
    await assert.rejects(transport.read(restRead("/fixture").request, credential,
      { operation: "fixture", deadline: Date.now() + 3000 }), { kind: "network" });
    assert.equal(calls, reused ? 2 : 1);
    await transport.dispose();
  }
  await provider.dispose();
});
