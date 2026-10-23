import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GitLogService } from "../src/git/gitLogService";
import { runGitWithInput } from "../src/git/gitExec";
import { readNativeGraphExpectation } from "./helpers/graphNativeExpectation";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** Native 읽기가 index·HEAD·설정을 변경하지 않았는지 바이트와 파일 시각으로 비교한다. */
async function filesState(files: string[]) {
  return Promise.all(files.map(async file => {
    const info = await stat(file);
    return { file, bytes: await readFile(file), ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs };
  }));
}

test("Native Graph oracle does not reuse product parsing or local-only algorithms", async t => {
  const f = await safetyFixture(t, "independent-graph-oracle");
  await git(f.root, "remote", "add", "origin", path.join(f.directory, "unused-native-only"));
  await git(f.root, "update-ref", "refs/remotes/origin/main", f.head);
  await git(f.root, "branch", "--set-upstream-to", "origin/main", "main");
  await git(f.root, "switch", "-qc", "feature");
  await writeFile(path.join(f.root, "tracked.txt"), "feature\n");
  const subject = "feature subject with \x1f retained delimiter";
  await git(f.root, "add", "."); await git(f.root, "commit", "-qm", subject);
  const feature = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "update-ref", "refs/remotes/origin/feature", feature);
  await git(f.root, "branch", "--set-upstream-to", "origin/main", "feature");
  await git(f.root, "branch", "twin", feature); await git(f.root, "branch", "--set-upstream-to", "origin/feature", "twin");
  await git(f.root, "branch", "no-upstream", feature);
  await git(f.root, "switch", "-qc", "unpublished"); await writeFile(path.join(f.root, "extra.txt"), "extra\n");
  await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "extra unpublished change");
  const extra = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "branch", "local-tracking", extra);
  await git(f.root, "config", "branch.local-tracking.remote", ".");
  await git(f.root, "config", "branch.local-tracking.merge", "refs/heads/feature");
  await git(f.root, "branch", "gone", extra); await git(f.root, "config", "branch.gone.remote", "origin");
  await git(f.root, "config", "branch.gone.merge", "refs/heads/missing");
  await git(f.root, "branch", "grafted", f.head); await git(f.root, "branch", "replaced", f.head);
  await git(f.root, "tag", "-a", "release,one", feature, "-m", "annotated release");
  await git(f.root, "switch", "-q", "main");
  const protectedFiles = ["index", "HEAD", "config"].map(file => path.join(f.root, ".git", file));
  const before = await filesState(protectedFiles);
  t.mock.method(GitLogService.prototype, "getLocalBranchSnapshot", async () => { throw new Error("Product branch service must not be the oracle"); });
  t.mock.method(GitLogService.prototype, "getCommitPage", async () => { throw new Error("Product log service must not be the oracle"); });
  const rows = await readNativeGraphExpectation(f.root, 300), byHash = new Map(rows.map(row => [row.hash, row]));
  assert.equal(rows.length, 3); assert.equal(byHash.get(feature)?.subject, subject);
  assert.deepEqual(byHash.get(feature)?.localOnlyBranches?.sort(), ["feature"],
    "A commit published on another remote branch can still be ahead of its configured upstream");
  assert.deepEqual(byHash.get(extra)?.localOnlyBranches?.sort(), ["gone", "local-tracking", "unpublished"]);
  assert.deepEqual(byHash.get(f.head)?.localOnlyBranches ?? [], []);
  assert.ok(byHash.get(feature)?.refs.includes("tag:release,one"));
  for (const name of ["HEAD", "main", "grafted", "replaced"]) assert.ok(byHash.get(f.head)?.refs.includes(name), name);
  for (const limit of [1, 2]) assert.deepEqual(await readNativeGraphExpectation(f.root, limit), rows.slice(0, limit),
    "A first-page prefix must preserve the full Native upstream-relative membership");
  assert.deepEqual(await filesState(protectedFiles), before);
});

test("Native Graph oracle handles no remotes and linked HEAD without reading a guessed git directory", async t => {
  const cleanups: Array<() => unknown> = [];
  const f = await safetyFixture({ after: (cleanup: () => unknown) => cleanups.push(cleanup) } as TestContext, "linked-native-oracle");
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  const linked = path.join(f.directory, "linked"); await git(f.root, "worktree", "add", "-q", "-b", "linked", linked);
  cleanups.push(() => git(f.root, "worktree", "remove", linked));
  const index = path.resolve(linked, await git(linked, "rev-parse", "--git-path", "index"));
  const head = path.resolve(linked, await git(linked, "rev-parse", "--git-path", "HEAD"));
  const before = await filesState([index, head, path.join(f.root, ".git/config")]);
  const rows = await readNativeGraphExpectation(linked, 300);
  assert.equal(rows.length, 1); assert.equal(rows[0].hash, f.head); assert.deepEqual(rows[0].parents, []);
  assert.deepEqual(rows[0].refs.sort(), ["HEAD", "linked", "main"]);
  assert.deepEqual(rows[0].localOnlyBranches?.sort(), ["linked", "main"]);
  assert.deepEqual(await filesState([index, head, path.join(f.root, ".git/config")]), before);
});

test("Native Graph oracle retains both merge parents and rejects an unproven empty page limit", async t => {
  const f = await safetyFixture(t, "native-merge-oracle");
  await git(f.root, "switch", "-qc", "topic"); await writeFile(path.join(f.root, "topic.txt"), "topic\n");
  await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "topic"); const topic = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "switch", "-q", "main"); await writeFile(path.join(f.root, "main.txt"), "main\n");
  await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "main"); const main = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "merge", "--no-ff", "--no-edit", "topic"); const merge = await git(f.root, "rev-parse", "HEAD");
  const rows = await readNativeGraphExpectation(f.root, 300);
  assert.deepEqual(rows.find(row => row.hash === merge)?.parents, [main, topic]);
  for (const limit of [1, 2]) assert.deepEqual(await readNativeGraphExpectation(f.root, limit), rows.slice(0, limit));
  await assert.rejects(readNativeGraphExpectation(f.root, 0));
});

test("Native first-page prefixes retain exact membership across old side tips and aliases", async t => {
  const f = await safetyFixture(t, "native-prefix-oracle");
  const input: string[] = [];
  for (const [branch, depth, time, firstMark] of [["old", 8, 1700000000, 1], ["recent", 2, 2000000000, 20]] as const) {
    for (let index = 0; index < depth; index++) {
      const mark = firstMark + index, message = `${branch} ${index}`;
      input.push(`commit refs/heads/${branch}`, `mark :${mark}`,
        `committer Native Prefix <prefix@example.invalid> ${time + index} +0000`,
        `data ${Buffer.byteLength(message)}`, message, `from ${index ? ":" + (mark - 1) : f.head}`, "");
    }
  }
  await runGitWithInput(["fast-import", "--quiet"], f.root, input.join("\n") + "\n");
  await git(f.root, "branch", "old-alias", "old"); await git(f.root, "switch", "-q", "recent");
  const full = await readNativeGraphExpectation(f.root, 100);
  assert.equal(full.length, 11);
  for (const limit of [1, 2, 4, 7, 10]) assert.deepEqual(await readNativeGraphExpectation(f.root, limit), full.slice(0, limit),
    "The complete Native range result must agree with every shorter global topo-order prefix");
});
