import assert from "node:assert/strict";
import test from "node:test";
import { GitHubReadCache } from "../src/git/githubReadCache";

/** 실제 실행 시작·취소·종료를 시간 추정 없이 제어하는 gate다. */
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
/** 취소 promise의 microtask가 처리될 기회를 제공하며 실제 close gate는 해제하지 않는다. */
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

for (const interruption of ["cancel", "deadline"] as const) {
  test(`a scoped ${interruption} waits for its last owned cached execution to close`, async () => {
    const release = deferred<string>(), started = deferred<void>(), interrupted = deferred<void>(); let closed = false, settled = false;
    const cache = new GitHubReadCache(async (_args, _root, options) => {
      options.signal!.addEventListener("abort", () => interrupted.resolve(undefined), { once: true }); started.resolve(undefined);
      try { return await release.promise; } finally { closed = true; }
    }, interruption === "deadline" ? 100 : 30_000);
    const controller = new AbortController();
    const pending = cache.read(["api", interruption], "/close-join", { operation: "close-join", signal: controller.signal, waitForReadClose: true });
    const observed = pending.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    try {
      await started.promise; if (interruption === "cancel") controller.abort();
      await interrupted.promise; await turn(); assert.equal(settled, false); assert.equal(closed, false);
      release.resolve("closed"); const error = await observed; assert(error instanceof Error);
      assert.match(error.message, interruption === "cancel" ? /cancelled/ : /timed out/); assert.equal(closed, true);
    } finally { release.resolve("closed"); await observed; await cache.dispose(); }
  });
}

test("a cancelling scope detaches immediately when another consumer still owns the shared execution", async () => {
  const release = deferred<string>(), started = deferred<void>(); let signal: AbortSignal | undefined, calls = 0, detached = false;
  const cache = new GitHubReadCache(async (_args, _root, options) => { calls++; signal = options.signal; started.resolve(undefined); return release.promise; });
  const controller = new AbortController();
  const scoped = cache.read(["api", "shared"], "/close-join", { operation: "close-join", signal: controller.signal, waitForReadClose: true });
  const other = cache.read(["api", "shared"], "/close-join", { operation: "close-join" });
  const observed = scoped.then(() => { detached = true; return undefined; }, error => { detached = true; return error; });
  try {
    await started.promise; await turn(); controller.abort(); await turn();
    assert.equal(detached, true); assert.equal(signal?.aborted, false); assert.equal(calls, 1);
    assert.match((await observed).message, /cancelled/); release.resolve("value"); assert.equal(await other, "value");
  } finally { release.resolve("value"); await Promise.allSettled([observed, other]); await cache.dispose(); }
});
