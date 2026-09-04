import assert from "node:assert/strict";
import test from "node:test";
import {
  GitBranchListCache,
  invalidateGitBranchListCaches,
  parseGitBranchList,
} from "../src/git/gitBranchListCache";

const FS = "\x1f";

/** 테스트용 for-each-ref 행을 production 필드 순서로 만든다. */
function ref(head: string, name: string, fullRef: string): string {
  return [head, name, fullRef].join(FS);
}

test("branch list parser marks current local branch and excludes symbolic remote HEAD", () => {
  assert.deepEqual(parseGitBranchList([
    ref("*", "main", "refs/heads/main"),
    ref(" ", "topic", "refs/heads/topic"),
    ref(" ", "origin/HEAD", "refs/remotes/origin/HEAD"),
    ref(" ", "origin/main", "refs/remotes/origin/main"),
  ].join("\n")), [
    { name: "main", kind: "local", isCurrent: true },
    { name: "topic", kind: "local", isCurrent: false },
    { name: "origin/main", kind: "remote", isCurrent: false },
  ]);
});

test("remote snapshot satisfies local reads, coalesces callers, and expires by TTL", async () => {
  let now = 10_000;
  let calls = 0;
  let release: ((value: string) => void) | undefined;
  const cache = new GitBranchListCache(2_000, () => now);
  const runner = async () => {
    calls++;
    return new Promise<string>((resolve) => { release = resolve; });
  };
  const first = cache.read(true, runner);
  const second = cache.read(false, runner);
  release!([
    ref("*", "main", "refs/heads/main"),
    ref(" ", "origin/main", "refs/remotes/origin/main"),
  ].join("\n"));
  assert.equal((await first).source, "miss");
  const coalesced = await second;
  assert.equal(coalesced.source, "coalesced");
  assert.deepEqual(coalesced.branches.map((branch) => branch.name), ["main"]);
  assert.equal((await cache.read(true, runner)).source, "hit");
  assert.equal(calls, 1);

  now += 2_001;
  const expired = cache.read(false, async () => {
    calls++;
    return ref("*", "next", "refs/heads/next");
  });
  assert.deepEqual((await expired).branches.map((branch) => branch.name), ["next"]);
  assert.equal(calls, 2);
});

test("known ref mutation invalidates a still-young snapshot", async () => {
  const cache = new GitBranchListCache(60_000);
  let output = ref("*", "main", "refs/heads/main");
  let calls = 0;
  const runner = async () => { calls++; return output; };
  await cache.read(false, runner);
  output = ref("*", "feature", "refs/heads/feature");
  cache.invalidate();
  assert.deepEqual((await cache.read(false, runner)).branches.map((branch) => branch.name), ["feature"]);
  assert.equal(calls, 2);
});

test("repository generation invalidates snapshots held by another service instance", async () => {
  let calls = 0;
  const cache = GitBranchListCache.forRepository("/shared-repository");
  const runner = async () => {
    calls++;
    return `${calls === 1 ? "*" : " "}${FS}main${FS}refs/heads/main\n`;
  };
  await cache.read(false, runner);
  await cache.read(false, runner);
  invalidateGitBranchListCaches("/shared-repository");
  await cache.read(false, runner);
  assert.equal(calls, 2);
});
