import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createGitOperationFixture } from "./helpers/gitOperationFixture";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 원본 loose object 이름 목록을 기록해 격리 작업이 원본 object dir에도 쓰지 않는지 확인한다. */
async function objectNames(directory: string): Promise<string[]> {
  const values: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (/^[a-f0-9]{2}$/.test(item.name) && item.isDirectory()) {
      for (const name of await readdir(path.join(directory, item.name))) values.push(`${item.name}/${name}`);
    }
  }
  return values.sort();
}

test("borrowed history fixture writes only its private repository/receiver and keeps source state and objects unchanged", async t => {
  const source = await safetyFixture(t, "borrowed-fixture"), destination = path.join(source.directory, "fixture"); await mkdir(destination);
  const objects = path.join(source.root, ".git/objects"), metadata = path.join(source.directory, "metadata.json");
  const sourceIndex = await readFile(path.join(source.root, ".git/index")), sourceConfig = await readFile(path.join(source.root, ".git/config"));
  const refs = await git(source.root, "for-each-ref", "--format=%(refname)%00%(objectname)"), objectBefore = await objectNames(objects);
  await writeFile(metadata, JSON.stringify({ source: source.root, objects, head: source.head, objectFormat: "sha1", refsStable: true,
    refs: [{ ref: "refs/heads/main", hash: source.head, symref: "", upstream: "refs/remotes/origin/main", remote: "origin", remoteRef: "refs/heads/main" },
      { ref: "refs/remotes/origin/main", hash: source.head, symref: "", upstream: "", remote: "", remoteRef: "" }],
    tree: { entries: 1, blobBytes: 5, unknown: 0, submodules: 0 } }));
  const f = await createGitOperationFixture(destination, metadata);
  assert.equal(await git(f.root, "remote", "get-url", "origin"), f.remote);
  assert.equal(await git(f.remote, "remote"), "");
  assert.equal(await git(f.root, "rev-parse", "refs/remotes/origin/main"), source.head);
  assert.equal(await git(f.root, "config", "branch.main.merge"), "refs/heads/main");
  assert.equal(await git(f.root, "status", "--porcelain=v1"), "");
  assert.equal(f.prCommits.length, 3);
  await git(f.root, "push", "origin", `${f.prBranch}:refs/heads/fixture-check`);
  assert.equal(await git(f.remote, "rev-parse", "refs/heads/fixture-check"), f.pr);
  assert.equal(await git(source.root, "rev-parse", "HEAD"), source.head);
  assert.equal(await git(source.root, "for-each-ref", "--format=%(refname)%00%(objectname)"), refs);
  assert.deepEqual(await readFile(path.join(source.root, ".git/index")), sourceIndex);
  assert.deepEqual(await readFile(path.join(source.root, ".git/config")), sourceConfig);
  assert.deepEqual(await objectNames(objects), objectBefore);
  assert.equal(await readFile(path.join(source.root, "tracked.txt"), "utf8"), "base\n");
});
