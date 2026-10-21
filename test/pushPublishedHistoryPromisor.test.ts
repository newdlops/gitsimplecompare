import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runGit, runGitStreamWithInput, runGitWithInput } from "../src/git/gitExec";
import { readPublishedPushTips } from "../src/git/pushPublishedHistory";
import type { PushGitRunner } from "../src/git/sequentialPush";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

for (const streaming of [true, false]) test(`published-tip ${streaming ? "stream" : "buffer"} verification does not lazily fetch unknown promisor commits`, async t => {
  const version = /git version (\d+)\.(\d+)/.exec(await runGit(["--version"], process.cwd()));
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 45)) {
    t.skip("Native no-lazy-fetch assertion needs Git 2.45 or newer"); return;
  }
  const f = await safetyFixture(t, "published-tip-promisor"), remote = await addOrigin(f.root, f.directory);
  const head = await commitText(f.root, "local-only\n", "local change");
  const unknown = await git(remote, "-c", "user.name=Remote", "-c", "user.email=remote@example.test",
    "commit-tree", `${f.head}^{tree}`, "-p", f.head, "-m", "remote-only");
  await git(remote, "update-ref", "refs/heads/remote-only", unknown);
  // blobless clone과 같은 promisor 설정으로 다른 branch의 commit을 아직 받지 않은 상태를 만든다.
  await git(f.root, "config", "remote.origin.promisor", "true");
  await git(f.root, "config", "remote.origin.partialclonefilter", "blob:none");
  const noFetch = { env: { GIT_NO_LAZY_FETCH: "1" } };
  await assert.rejects(runGit(["cat-file", "-e", unknown], f.root, noFetch));
  const trace = join(f.directory, "metadata-trace.jsonl"), packPath = join(f.root, ".git/objects/pack");
  const index = await readFile(join(f.root, ".git/index")), config = await readFile(join(f.root, ".git/config"));
  const packs = (await readdir(packPath)).sort();
  const runner: PushGitRunner = { run: runGit, input: runGitWithInput,
    ...(streaming ? { inputStream: runGitStreamWithInput } : {}) };
  const selected = await readPublishedPushTips(f.root, remote, head, runner, {
    env: { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "0", GIT_TRACE2_EVENT: trace },
  });
  const events = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const childFetches = events.filter(event => event.event === "child_start" && event.argv?.includes("fetch")).length;
  const objectPresent = await runGit(["cat-file", "-e", unknown], f.root, noFetch).then(() => true, () => false);
  assert.deepEqual({ selected, childFetches, objectPresent }, { selected: [f.head], childFetches: 0, objectPresent: false });
  assert.deepEqual((await readdir(packPath)).sort(), packs, "Read-only verification must not download a promisor pack");
  assert.deepEqual(await readFile(join(f.root, ".git/index")), index);
  assert.deepEqual(await readFile(join(f.root, ".git/config")), config);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), head);
});
