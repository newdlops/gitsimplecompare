import assert from "node:assert/strict";
import test from "node:test";
import {
  GitTagService,
  invalidateRemoteTagCache,
  type GitTagRunner,
} from "../src/git/gitTagService";

/** 비동기 remote 목록 조회 뒤 ls-remote가 시작될 때까지 event loop를 진행시킨다. */
const settleRemoteRead = () => new Promise<void>((resolve) => setImmediate(resolve));

test("remote tag status uses TTL cache and explicit invalidation refreshes only the remote read", async () => {
  let remoteReads = 0;
  const runner: GitTagRunner = async (args) => {
    if (args[0] === "remote") return "origin\n";
    if (args[0] === "for-each-ref") return "local-tag\0\0local-hash\n";
    if (args[0] === "ls-remote") {
      remoteReads++;
      return `${remoteReads}-hash\trefs/tags/remote-tag\n`;
    }
    return "";
  };
  const first = await new GitTagService("/tag-cache", runner).getTagStatuses();
  const second = await new GitTagService("/tag-cache", runner).getTagStatuses();
  assert.equal(remoteReads, 1);
  assert.equal(first.find((tag) => tag.name === "remote-tag")?.remoteTargets[0]?.hash, "1-hash");
  assert.equal(second.find((tag) => tag.name === "local-tag")?.localHash, "local-hash");

  invalidateRemoteTagCache("/tag-cache", "origin");
  const refreshed = await new GitTagService("/tag-cache", runner).getTagStatuses();
  assert.equal(remoteReads, 2);
  assert.equal(refreshed.find((tag) => tag.name === "remote-tag")?.remoteTargets[0]?.hash, "2-hash");
});

test("simultaneous tag consumers share one network request and force bypasses a completed value", async () => {
  let remoteReads = 0;
  let release: ((value: string) => void) | undefined;
  const runner: GitTagRunner = async (args) => {
    if (args[0] === "remote") return "upstream\n";
    if (args[0] === "for-each-ref") return "";
    remoteReads++;
    if (remoteReads === 1) {
      return new Promise<string>((resolve) => { release = resolve; });
    }
    return "forced\trefs/tags/v2\n";
  };
  const one = new GitTagService("/tag-singleflight", runner).getRemoteTagRefs();
  const two = new GitTagService("/tag-singleflight", runner).getRemoteTagRefs();
  await settleRemoteRead();
  release!("initial\trefs/tags/v1\n");
  assert.deepEqual(await one, await two);
  assert.equal(remoteReads, 1);

  const forced = await new GitTagService("/tag-singleflight", runner).getRemoteTagRefs({ forceRemote: true });
  assert.equal(remoteReads, 2);
  assert.equal(forced[0]?.name, "v2");
});

test("invalidated in-flight tag read cannot repopulate the completed cache", async () => {
  let remoteReads = 0;
  const releases: Array<(value: string) => void> = [];
  const runner: GitTagRunner = async (args) => {
    if (args[0] === "remote") return "origin\n";
    if (args[0] === "for-each-ref") return "";
    remoteReads++;
    return new Promise<string>((resolve) => releases.push(resolve));
  };
  const stale = new GitTagService("/tag-stale", runner).getRemoteTagRefs();
  await settleRemoteRead();
  invalidateRemoteTagCache("/tag-stale", "origin");
  releases[0]("old\trefs/tags/old\n");
  await stale;
  const current = new GitTagService("/tag-stale", runner).getRemoteTagRefs();
  await settleRemoteRead();
  releases[1]("new\trefs/tags/new\n");
  assert.equal((await current)[0]?.name, "new");
  assert.equal(remoteReads, 2);
});
