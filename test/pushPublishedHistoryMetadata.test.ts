import assert from "node:assert/strict";
import test from "node:test";
import { readPublishedPushTips, readPushBranchAdvertisement } from "../src/git/pushPublishedHistory";
import type { PushGitRunner } from "../src/git/sequentialPush";
import type { RunGitOptions } from "../src/git/gitExec";

/** 서로 다른 완전한 SHA-1/SHA-256 fixture OID를 만든다. */
function oid(index: number, length = 40): string { return index.toString(16).padStart(length, "0"); }

test("published tips validate chunked metadata, skip unknown/non-commits and bound selected exclusions", async () => {
  const tips = Array.from({ length: 1000 }, (_, index) => oid(index + 1, 64));
  let batches = 0;
  const runner: PushGitRunner = {
    run: async () => tips.map((tip, index) => `${tip}\trefs/heads/branch-${index}`).join("\n") + `\n${tips[0]}\trefs/heads/duplicate\n`,
    input: async () => { throw new Error("metadata must use streaming when it is available"); },
    inputStream: async (_args, _root, input, consume) => {
      batches++; assert.deepEqual(input.trim().split("\n"), tips);
      const output = tips.map((tip, index) => index === 0 ? `${tip} missing` : `${tip} ${index === 1 ? "tag" : index === 2 ? "blob" : "commit"}`).join("\n") + "\n";
      for (let start = 0; start < output.length; start += 17) consume(Buffer.from(output.slice(start, start + 17)));
    },
  };
  const selected = await readPublishedPushTips("/fixture", "unused", oid(1001, 64), runner, {});
  assert.equal(batches, 1); assert.equal(selected.length, 64); assert.equal(new Set(selected).size, 64);
  assert.deepEqual(selected, tips.slice(3, 67));
});

test("malformed advertisements or mismatched object replies cannot become published history proof", async () => {
  for (const [advertised, metadata] of [
    ["not-an-oid\trefs/heads/main\n", ""],
    [`${oid(1)}\trefs/tags/main\n`, ""],
    [`${oid(1)}\trefs/heads/main\n`, `${oid(2)} commit\n`],
    [`${oid(1)}\trefs/heads/main\n`, ""],
    [`${oid(1)}\trefs/heads/main\n`, `${oid(1)} unknown\n`],
  ]) {
    const runner: PushGitRunner = { run: async () => advertised, input: async () => metadata };
    await assert.rejects(readPublishedPushTips("/fixture", "unused", oid(3), runner, {}), /Could not (read|verify)/);
  }
});

test("discovery failure hides credential-bearing transport errors while preserving cancellation", async () => {
  const secret = "https://name:secret-token@example.invalid/repository";
  const error = new Error(`cannot connect to ${secret}`);
  const runner: PushGitRunner = { run: async () => { throw error; }, input: async () => "" };
  await assert.rejects(readPublishedPushTips("/fixture", secret, oid(1), runner, {}), value => {
    assert.ok(value instanceof Error); assert.equal(value.message.includes("secret-token"), false);
    return /Could not read the push destination/.test(value.message);
  });
  const controller = new AbortController(); controller.abort();
  const cancelled = Object.assign(new Error("Git read cancelled"), { name: "AbortError" });
  const cancelledRunner: PushGitRunner = { run: async () => { throw cancelled; }, input: async () => "" };
  await assert.rejects(readPublishedPushTips("/fixture", secret, oid(1), cancelledRunner, { signal: controller.signal }), value => value === cancelled);
});

test("destination and published-history verification consume one advertisement without another network read", async () => {
  let advertisements = 0, batches = 0;
  const runner: PushGitRunner = {
    run: async args => {
      advertisements++; assert.deepEqual(args.slice(0, 4), ["ls-remote", "--refs", "--heads", "--"]);
      return `${oid(1)}\trefs/heads/main\n${oid(2)}\trefs/heads/existing\n`;
    },
    input: async (_args, _root, input) => { batches++; assert.equal(input, `${oid(1)}\n${oid(2)}\n`); return `${oid(1)} commit\n${oid(2)} missing\n`; },
  };
  const advertisement = await readPushBranchAdvertisement("/fixture", "owned", runner, {});
  assert.equal(advertisement.get("refs/heads/existing"), oid(2));
  assert.equal(advertisement.get("refs/heads/new"), undefined);
  assert.deepEqual(await readPublishedPushTips("/fixture", "owned", oid(3), runner, {}, advertisement), [oid(1)]);
  assert.equal(advertisements, 1); assert.equal(batches, 1);
});

test("a duplicate destination in one advertisement is rejected before selecting a lease", async () => {
  const runner: PushGitRunner = { run: async () => `${oid(1)}\trefs/heads/main\n${oid(2)}\trefs/heads/main\n`, input: async () => "" };
  await assert.rejects(readPushBranchAdvertisement("/fixture", "owned", runner, {}), /Could not read the remote branch commits/);
});

test("an exact destination read retains the narrow existing-branch advertisement", async () => {
  const runner: PushGitRunner = {
    run: async args => { assert.deepEqual(args, ["ls-remote", "--refs", "--", "owned", "refs/heads/existing"]); return `${oid(1)}\trefs/heads/existing\n`; },
    input: async () => { throw new Error("Existing-branch inspection does not verify unrelated object types"); },
  };
  const advertisement = await readPushBranchAdvertisement("/fixture", "owned", runner, {}, "refs/heads/existing");
  assert.equal(advertisement.size, 1); assert.equal(advertisement.get("refs/heads/existing"), oid(1));
});

for (const streaming of [true, false]) test(`published-tip ${streaming ? "stream" : "buffer"} probe preserves caller options and locally disables lazy fetch`, async () => {
  const controller = new AbortController(), options: RunGitOptions = Object.freeze({
    signal: controller.signal, readTimeoutMs: 1234, retryOnLock: false,
    env: Object.freeze({ GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/owned/no-grafts", GIT_NO_LAZY_FETCH: "0" }),
    clearEnv: Object.freeze(["GIT_INDEX_FILE"]),
  });
  let probes = 0;
  /** 원본 DAG·취소·제한 시간을 보존하고 호출자 객체를 바꾸지 않는 로컬 조회 옵션을 확인한다. */
  const verify = (actual: RunGitOptions | undefined) => {
    probes++;
    assert.notEqual(actual, options);
    assert.deepEqual(actual, { ...options, env: { ...options.env, GIT_NO_LAZY_FETCH: "1" } });
    assert.equal(options.env!.GIT_NO_LAZY_FETCH, "0");
  };
  const runner: PushGitRunner = {
    run: async () => { throw new Error("A supplied advertisement must be reused"); },
    input: async (_args, _root, input, actual) => { verify(actual); assert.equal(input, oid(1) + "\n"); return `${oid(1)} commit\n`; },
    ...(streaming ? { inputStream: async (_args: string[], _root: string, input: string, consume: (chunk: Buffer) => void, actual?: RunGitOptions) => {
      verify(actual); assert.equal(input, oid(1) + "\n"); consume(Buffer.from(`${oid(1)} commit\n`));
    } } : {}),
  };
  assert.deepEqual(await readPublishedPushTips("/fixture", "owned", oid(2), runner, options, new Map([["refs/heads/main", oid(1)]])), [oid(1)]);
  assert.equal(probes, 1);
});
