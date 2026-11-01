import assert from "node:assert/strict";
import test from "node:test";
import { GitHubWebAgentPool } from "../src/git/githubWebAgentPool";

test("bounded HTML Agent pool waits for another account, isolates cancellation and evicts idle leases", async () => {
  const pool = new GitHubWebAgentPool({ maxEntries: 1, idleMs: 20 });
  const first = await pool.acquire({ Cookie: "one" }, "direct", new AbortController().signal);
  const controller = new AbortController();
  const cancelled = pool.acquire({ Cookie: "two" }, "direct", controller.signal);
  const waiting = pool.acquire({ Cookie: "two" }, "direct", new AbortController().signal);
  controller.abort(); await assert.rejects(cancelled, { name: "AbortError" });
  first.release();
  const second = await waiting;
  assert.ok(first.agent !== second.agent); assert.equal(second.agent.maxSockets, 2);
  second.release();
  await new Promise(resolve => setTimeout(resolve, 40));
  const afterIdle = await pool.acquire({ Cookie: "two" }, "direct", new AbortController().signal);
  assert.ok(afterIdle.agent !== second.agent, "idle expiry must release the old Agent");
  afterIdle.release(); await pool.dispose();
});

test("policy and authorization select separate HTML Agents and disposal cancels capacity waiters", async () => {
  const pool = new GitHubWebAgentPool({ maxEntries: 2 });
  let first!: Awaited<ReturnType<typeof pool.acquire>>, second!: typeof first;
  first = await pool.acquire({ Authorization: "Bearer one" }, "policy-one", new AbortController().signal, () => first.release());
  second = await pool.acquire({ Authorization: "Bearer one" }, "policy-two", new AbortController().signal, () => second.release());
  assert.ok(first.agent !== second.agent);
  const waiting = pool.acquire({ Authorization: "Bearer two" }, "policy-one", new AbortController().signal);
  const rejection = assert.rejects(waiting, { name: "AbortError" });
  await pool.dispose(); await rejection;
});
