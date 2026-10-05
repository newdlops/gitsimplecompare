import assert from "node:assert/strict";
import test from "node:test";
import { GitHubReadCache } from "../src/git/githubReadCache";
import type { GhRunnerOptions } from "../src/git/ghRunner";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** 실행기 종료와 호출자 취소를 독립적으로 제어해 실제 슬롯 반환 시점을 관찰한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

/** 타이머 길이 대신 microtask와 실행 큐가 진행할 기회만 제공한다. */
function settle(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }

test("a fresh read bypasses and removes a previously completed cache entry", async () => {
  let calls = 0;
  const cache = new GitHubReadCache(async () => String(++calls));
  assert.equal(await cache.read(["api", "data"], "/repo", { operation: "test", ttlMs: 10000 }), "1");
  assert.equal(await cache.read(["api", "data"], "/repo", { operation: "test", ttlMs: 0 }), "2");
  assert.equal(await cache.read(["api", "data"], "/repo", { operation: "test", ttlMs: 10000 }), "3");
  assert.equal(calls, 3);
});

test("a consumer requesting a shorter freshness window does not receive an older cached response", async t => {
  let now = 1000, calls = 0;
  t.mock.method(Date, "now", () => now);
  const cache = new GitHubReadCache(async () => String(++calls));
  await cache.read(["api"], "/repo", { operation: "test", ttlMs: 10000 });
  now += 100;
  assert.equal(await cache.read(["api"], "/repo", { operation: "test", ttlMs: 50 }), "2");
});

test("different repository, host, and authentication environments cannot share completed responses", async () => {
  let calls = 0;
  const cache = new GitHubReadCache(async () => String(++calls));
  const contexts = [
    { GH_REPO: "owner/one", GH_HOST: "one.example", GH_TOKEN: "fixture-a" },
    { GH_REPO: "owner/two", GH_HOST: "one.example", GH_TOKEN: "fixture-a" },
    { GH_REPO: "owner/two", GH_HOST: "two.example", GH_TOKEN: "fixture-a" },
    { GH_REPO: "owner/two", GH_HOST: "two.example", GH_TOKEN: "fixture-b" },
  ];
  for (let index = 0; index < contexts.length; index++) {
    const options = { operation: "test", ttlMs: 10000, env: contexts[index] };
    assert.equal(await cache.read(["api", "same"], "/repo", options), String(index + 1));
    assert.equal(await cache.read(["api", "same"], "/repo", options), String(index + 1));
  }
  assert.equal(calls, 4);
});

test("queued reads execute with the environment captured when they were requested", async () => {
  const responses: Array<ReturnType<typeof deferred<string>>> = [];
  const environments: Array<string | undefined> = [];
  const cache = new GitHubReadCache(async (_args, _root, options) => {
    environments.push((options as GhRunnerOptions & { env?: NodeJS.ProcessEnv }).env?.GH_REPO);
    const response = deferred<string>(); responses.push(response); return response.promise;
  });
  const env = { GH_REPO: "owner/old" };
  const requests = Array.from({ length: 5 }, (_, index) => cache.read(["api", String(index)], "/repo", { operation: "test", ...{ env } }));
  const observed = Promise.allSettled(requests);
  try {
    await settle();
    env.GH_REPO = "owner/new";
    responses[0].resolve("value"); await settle();
    assert.equal(environments[4], "owner/old");
  } finally {
    for (let turn = 0; turn < 6; turn++) { for (const response of responses) response.resolve("value"); await settle(); }
    await observed;
  }
});

test("cancelled executions retain their slots until the actual runner has closed", async () => {
  const responses: Array<ReturnType<typeof deferred<string>>> = [];
  const cache = new GitHubReadCache(async () => {
    const response = deferred<string>(); responses.push(response); return response.promise;
  });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const requests = controllers.map((controller, index) => cache.read(["old", String(index)], "/repo", { operation: "test", signal: controller.signal }));
  requests.push(cache.read(["new", "one"], "/repo", { operation: "test" }), cache.read(["new", "two"], "/repo", { operation: "test" }));
  const observed = Promise.allSettled(requests);
  try {
    await settle(); assert.equal(responses.length, 4);
    for (const controller of controllers) controller.abort();
    await settle();
    assert.equal(responses.length, 4, "no replacement process may start before old executions close");
    for (const response of responses) response.resolve("closed");
    await settle(); assert.equal(responses.length, 6);
  } finally {
    for (let turn = 0; turn < 6; turn++) { for (const response of responses) response.resolve("closed"); await settle(); }
    await observed;
  }
});

test("queued timeouts reject without spawning behind four still-closing executions", async () => {
  let calls = 0;
  const responses: Array<ReturnType<typeof deferred<string>>> = [];
  const cache = new GitHubReadCache(async () => {
    calls++; const response = deferred<string>(); responses.push(response); return response.promise;
  }, 15);
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => cache.read([String(index)], "/repo", { operation: "test" })));
  try {
    assert.ok(results.every(result => result.status === "rejected"));
    assert.equal(calls, 4);
  } finally { for (const response of responses) response.resolve("closed"); await settle(); }
});

test("disposal rejects consumers immediately but waits for execution close and blocks new reads", async t => {
  const response = deferred<string>(); let calls = 0;
  t.after(() => response.resolve("closed"));
  const cache = new GitHubReadCache(async () => { calls++; return response.promise; });
  const pending = cache.read(["api"], "/repo", { operation: "test" });
  const observed = pending.then(() => undefined, error => error);
  await settle();
  let finished = false;
  const disposing = (cache as GitHubReadCache & { dispose(): Promise<void> }).dispose().then(() => { finished = true; });
  try {
    await settle();
    assert.equal((await observed).name, "AbortError");
    assert.equal(finished, false);
    await assert.rejects(cache.read(["new"], "/repo", { operation: "test" }), /cancelled|disposed|closed/i);
    assert.equal(calls, 1);
  } finally { response.resolve("closed"); await disposing; }
  assert.equal(finished, true);
});

test("stored authentication changes invalidate successful reads without reading credential contents", async t => {
  const config = await mkdtemp(path.join(tmpdir(), "gsc-gh-context-"));
  t.after(() => rm(config, { recursive: true, force: true }));
  const hosts = path.join(config, "hosts.yml");
  await writeFile(hosts, "fixture: first\n");
  let calls = 0;
  const cache = new GitHubReadCache(async () => String(++calls));
  const options = { operation: "test", ttlMs: 10000, env: { GH_CONFIG_DIR: config } };
  assert.equal(await cache.read(["api"], "/repo", options), "1");
  assert.equal(await cache.read(["api"], "/repo", options), "1");
  await writeFile(hosts, "fixture: replacement-authentication\n");
  assert.equal(await cache.read(["api"], "/repo", options), "2");
});
