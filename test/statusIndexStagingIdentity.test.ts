import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runGit, runGitWithInput } from "../src/git/gitExec";
import { statusIndexStagingIdentity } from "../src/git/statusIndexStagingIdentity";

/** Git 자체가 생성한 index로 SHA와 format별 경로·mode·flags 해석을 검증한다. */
async function fixture(t: TestContext, algorithm = "sha1", version = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-staging-identity-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(["init", "-q", `--object-format=${algorithm}`], root);
  await runGit(["config", "core.fsmonitor", "false"], root);
  await runGit(["config", "user.name", "Fixture"], root); await runGit(["config", "user.email", "fixture@example.invalid"], root);
  const names = ["dir/common α.txt", "dir/common β.txt", "line\nname.txt", "-option", " leading.txt"];
  for (const name of names) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), "initial\n"); }
  await symlink(" leading.txt", path.join(root, "link"));
  await runGit(["add", "."], root); await runGit(["commit", "-qm", "initial"], root);
  await runGit(["update-index", `--index-version=${version}`], root);
  return { root, index: path.join(root, ".git/index"), names };
}

for (const algorithm of ["sha1", "sha256"]) for (const version of [2, 3, 4]) {
  test(`${algorithm} index v${version} identity survives only stat refresh and index encoding changes`, async t => {
    const f = await fixture(t, algorithm, version), before = await readFile(f.index);
    const identity = statusIndexStagingIdentity(before); assert.ok(identity);
    const touched = new Date(Date.now() + 10000); await utimes(path.join(f.root, f.names[0]), touched, touched);
    await runGit(["update-index", "--refresh"], f.root);
    const refreshed = await readFile(f.index); assert.notDeepEqual(refreshed, before);
    assert.equal(statusIndexStagingIdentity(refreshed), identity);
    await runGit(["update-index", "--index-version=4"], f.root);
    assert.equal(statusIndexStagingIdentity(await readFile(f.index)), identity);
    await writeFile(path.join(f.root, f.names[0]), "different\n"); await runGit(["add", "--", f.names[0]], f.root);
    assert.notEqual(statusIndexStagingIdentity(await readFile(f.index)), identity);
  });
}

test("assume-valid, intent-to-add, executable mode, rename and merge stages change the identity", async t => {
  const f = await fixture(t);
  const read = async () => statusIndexStagingIdentity(await readFile(f.index));
  const original = await read(); assert.ok(original);
  await runGit(["update-index", "--assume-unchanged", "--", f.names[0]], f.root);
  assert.notEqual(await read(), original);
  await runGit(["update-index", "--no-assume-unchanged", "--", f.names[0]], f.root);
  assert.equal(await read(), original);
  await runGit(["update-index", "--chmod=+x", "--", f.names[0]], f.root);
  assert.notEqual(await read(), original);
  await runGit(["reset", "--hard", "HEAD"], f.root);
  await writeFile(path.join(f.root, "new.txt"), ""); await runGit(["add", "-N", "new.txt"], f.root);
  const intent = await read(); assert.notEqual(intent, original);
  await runGit(["add", "new.txt"], f.root);
  assert.notEqual(await read(), intent, "staging the same empty blob must distinguish the intent-to-add flag");
  await runGit(["reset", "--hard", "HEAD"], f.root);
  await runGit(["mv", "--", f.names[0], "renamed.txt"], f.root); assert.notEqual(await read(), original);
  await runGit(["reset", "--hard", "HEAD"], f.root);
  const oid = (await runGit(["rev-parse", `HEAD:${f.names[0]}`], f.root)).trim();
  await runGit(["update-index", "--add", "--cacheinfo", `100644,${oid},conflict.txt`], f.root);
  const stageZero = await read();
  await runGit(["update-index", "--force-remove", "conflict.txt"], f.root);
  await runGitWithInput(["update-index", "--index-info"], f.root, `100644 ${oid} 2\tconflict.txt\n`);
  assert.ok((await runGit(["ls-files", "--stage", "--", "conflict.txt"], f.root)).includes(" 2\tconflict.txt"));
  assert.notEqual(await read(), stageZero);
});

test("split, sparse and skip-worktree indexes use exact fallback", async t => {
  const f = await fixture(t);
  await runGit(["update-index", "--skip-worktree", "--", f.names[0]], f.root);
  assert.equal(statusIndexStagingIdentity(await readFile(f.index)), undefined);
  await runGit(["update-index", "--no-skip-worktree", "--", f.names[0]], f.root);
  await runGit(["update-index", "--split-index"], f.root);
  assert.equal(statusIndexStagingIdentity(await readFile(f.index)), undefined);
  await runGit(["update-index", "--no-split-index"], f.root);
  await runGit(["sparse-checkout", "init", "--cone", "--sparse-index"], f.root);
  await runGit(["sparse-checkout", "set", "dir"], f.root);
  assert.equal(statusIndexStagingIdentity(await readFile(f.index)), undefined);
});

test("bad checksum, unknown mandatory extension and truncated headers cannot authorize cache reuse", async t => {
  const f = await fixture(t), valid = await readFile(f.index);
  const bad = Buffer.from(valid); bad[bad.length - 1] ^= 1;
  for (const bytes of [Buffer.alloc(0), valid.subarray(0, 15), bad]) assert.equal(statusIndexStagingIdentity(bytes), undefined);
  const body = Buffer.concat([valid.subarray(0, -20), Buffer.from("abcd"), Buffer.alloc(4)]);
  const unknown = Buffer.concat([body, createHash("sha1").update(body).digest()]);
  assert.equal(statusIndexStagingIdentity(unknown), undefined);
});
