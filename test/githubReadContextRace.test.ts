import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubReadCache } from "../src/git/githubReadCache";
import { __outputLines } from "./helpers/vscodeMock";

/** 실행 시작과 응답을 분리해 고정 sleep 없이 문맥 파일 변경을 주입한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

/** OUTPUT의 실제 큐/공유 등록을 관찰해 파일 검사의 완료 시점과 경합을 결정적으로 맞춘다. */
async function waitFor(condition: () => boolean): Promise<void> {
  const until = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < until, "expected read state did not occur");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

for (const kind of ["authentication", "repository"] as const) {
  test(`an in-flight ${kind} change discards every shared response and never caches it`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "gsc-gh-context-race-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = path.join(root, "gh"), gitDir = path.join(root, ".git");
    await mkdir(config); await mkdir(gitDir);
    const file = kind === "authentication" ? path.join(config, "hosts.yml") : path.join(gitDir, "config");
    await writeFile(file, "fixture: initial\n");
    const started = deferred<void>(), response = deferred<string>(); let calls = 0;
    t.after(() => response.resolve("stale"));
    const cache = new GitHubReadCache(async () => {
      if (++calls > 1) return "current";
      started.resolve(); return response.promise;
    });
    t.after(() => cache.dispose());
    const args = kind === "repository" ? ["api", "repos/{owner}/{repo}"] : ["api", "user"];
    const options = { operation: "context-race", ttlMs: 60_000, env: { GH_CONFIG_DIR: config } };
    const first = cache.read(args, root, options);
    const observed = first.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await started.promise;
    const offset = __outputLines.length;
    const peer = cache.read(args, root, options).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await waitFor(() => __outputLines.slice(offset).some(line => line.includes("GitHub read coalesced")));
    await writeFile(file, "fixture: changed-before-response\n"); response.resolve("stale");
    const result = await observed;
    assert.ok(result.error instanceof Error, "the old response must not be delivered as a current success");
    assert.match(result.error.message, /changed|refresh/i);
    assert.ok((await peer).error instanceof Error);
    assert.equal(await cache.read(args, root, options), "current");
    assert.equal(await cache.read(args, root, options), "current");
    assert.equal(calls, 2);
  });
}

test("a repository switch during queue wait rejects before spawning against the replacement repository", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-gh-queued-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  const config = path.join(root, ".git/config"); await writeFile(config, "fixture: original\n");
  const blockers = Array.from({ length: 4 }, () => deferred<string>()), executed: string[] = [];
  const cache = new GitHubReadCache(async (args) => {
    executed.push(args[1]);
    return args[1].startsWith("block-") ? blockers[Number(args[1].slice(6))].promise : "current";
  });
  t.after(async () => { for (const blocker of blockers) blocker.resolve("closed"); await cache.dispose(); });
  const holding = Promise.allSettled(blockers.map((_blocker, n) => cache.read(["api", `block-${n}`], root, { operation: "blocker" })));
  await waitFor(() => executed.length === 4);
  const offset = __outputLines.length;
  const options = { operation: "queued-context", ttlMs: 10000 };
  const args = ["api", "repos/{owner}/{repo}"];
  const queued = cache.read(args, root, options).then(() => undefined, error => error);
  await waitFor(() => __outputLines.slice(offset).some(line => line.includes("GitHub read queued") && line.includes("queued-context")));
  await writeFile(config, "fixture: replacement-repository\n"); blockers[0].resolve("closed");
  assert.match((await queued)?.message || "", /changed/i);
  assert.equal(executed.includes(args[1]), false);
  assert.equal(await cache.read(args, root, options), "current");
  assert.equal(await cache.read(args, root, options), "current");
  assert.equal(executed.filter(value => value === args[1]).length, 1);
  for (const blocker of blockers) blocker.resolve("closed"); await holding;
});
