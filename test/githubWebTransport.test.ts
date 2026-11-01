import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createServer, request, Agent, type RequestOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { GitHubWebTransport } from "../src/git/githubWebTransport";
import { GitHubWebReadContext } from "../src/git/githubWebReadContext";

const base = "https://github.com/owner/repo/pull/7";

/** CA 검증을 유지한 로컬 TLS 서버에서 실제 request·압축·socket close를 검증한다. */
async function fixture(t: test.TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void,
  options: { maxBytes?: number; ownedAgent?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gsc-web-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "key"),
    "-out", join(root, "cert"), "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-days", "2"], { stdio: "ignore" });
  const cert = await readFile(join(root, "cert")), key = await readFile(join(root, "key"));
  let connections = 0, reads = 0;
  const agents: unknown[] = [];
  const server = createServer({ cert, key }, (req, res) => { reads++; handler(req, res); });
  server.on("secureConnection", () => connections++);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  const transport = new GitHubWebTransport({ ...options, request: (args: RequestOptions, callback) => {
    agents.push(args.agent);
    return request({ ...args, hostname: "127.0.0.1", port, servername: "localhost", ca: cert }, callback);
  } });
  const context = new GitHubWebReadContext({ transport });
  t.after(async () => { await context.dispose(); await transport.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return { context, transport, counts: () => ({ reads, connections }), agents };
}

for (const [encoding, compress] of [["identity", (b: Buffer) => b], ["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]] as const) {
  test(`HTML ${encoding} responses decode to identical content and reuse one verified Agent socket`, async t => {
    const html = "<html>GitHub 한글 compressed page</html>";
    const f = await fixture(t, (req, res) => {
      assert.equal(req.headers.authorization, "Bearer fixture-token");
      assert.match(req.headers["accept-encoding"] ?? "", /gzip/);
      res.writeHead(200, { "content-encoding": encoding }); res.end(compress(Buffer.from(html)));
    }, { ownedAgent: true });
    const headers = { Authorization: "Bearer fixture-token" };
    assert.deepEqual(await f.context.read(base + "/files", headers, true), { ok: true, html, finalUrl: base + "/files" });
    assert((await f.context.read(base, headers, true)).ok);
    assert.deepEqual(f.counts(), { reads: 2, connections: 1 });
    assert(f.agents[0] instanceof Agent); assert.equal((f.agents[0] as Agent).maxSockets, 2);
  });
}

test("Host-managed HTTPS leaves Agent selection to the existing environment", async t => {
  const f = await fixture(t, (_req, res) => res.end("<html>GitHub</html>"));
  assert((await f.context.read(base, {}, true)).ok); assert.deepEqual(f.agents, [undefined]);
});

for (const compressed of [false, true]) {
  test(`HTML ${compressed ? "decoded" : "wire"} byte limit closes the request safely`, async t => {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(200, compressed ? { "content-encoding": "gzip" } : {});
      const body = Buffer.from("<html>GitHub" + "x".repeat(4096) + "</html>");
      res.end(compressed ? gzipSync(body) : body);
    }, { maxBytes: 1024, ownedAgent: true });
    assert.deepEqual(await f.context.read(base, { Cookie: "private-cookie" }), { ok: false, reason: "web html response is too large" });
    await f.context.dispose();
  });
}

test("same-origin redirects work and external redirects never receive headers", async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url?.endsWith("/files")) { res.writeHead(302, { location: base }); res.end(); }
    else { res.writeHead(302, { location: "https://other.example/steal" }); res.end(); }
  }, { ownedAgent: true });
  assert.deepEqual(await f.context.read(base + "/files", { Cookie: "fixture-cookie" }), { ok: false, reason: "unsafe web redirect" });
  assert.equal(f.counts().reads, 2);
});

test("deadline destroys an active compressed response before dispose resolves", async t => {
  let closed = false;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-encoding": "gzip" }); res.write(gzipSync(Buffer.from("<p>partial")));
    res.on("close", () => { closed = true; });
  }, { ownedAgent: true });
  const controller = new AbortController();
  const pending = f.transport.read(base, {}, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 30)); controller.abort();
  const result = await pending; assert(!result.ok);
  await f.transport.dispose();
  await new Promise(resolve => setTimeout(resolve, 10)); assert(closed);
});

test("invalid compression and unsafe URLs produce fixed errors without credential or payload text", async t => {
  const secret = "fixture-private-data";
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { "content-encoding": "gzip" }); res.end(secret); });
  const result = await f.context.read(base, { Cookie: secret }); assert(!result.ok);
  assert(!JSON.stringify(result).includes(secret));
  assert(!(await f.context.read("http://github.com/owner/repo/pull/7", {})).ok);
  assert(!(await f.context.read("https://user:secret@github.com/owner/repo/pull/7", {})).ok);
  assert.equal(f.counts().reads, 1);
});
