import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runGit, runGitWithInput } from "../src/git/gitExec";
import { restoreStatusIndexMetadata, statusIndexStagingIdentity, statusIndexStagingInfo, StatusIndexSource } from "../src/git/statusIndexStagingIdentity";

/** Git 자체가 생성한 index로 SHA와 format별 경로·mode·flags 해석을 검증한다. */
async function fixture(t: TestContext, algorithm = "sha1", version = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-staging-identity-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(["init", "-q", `--object-format=${algorithm}`], root);
  await runGit(["config", "core.fsmonitor", "false"], root);
  await runGit(["config", "core.untrackedCache", "false"], root);
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
    assert.deepEqual(statusIndexStagingInfo(before), { identity, directoryCount: 1, hasUntrackedCache: false });
    const inspection = StatusIndexSource.inspect(before); assert.ok(inspection);
    assert.deepEqual(inspection.info, statusIndexStagingInfo(before));
    assert.equal(inspection.matches(before), true);
    assert.equal(inspection.matches(Buffer.from(before)), false, "A different source read needs its own inspection");
    const touched = new Date(Date.now() + 10000); await utimes(path.join(f.root, f.names[0]), touched, touched);
    await runGit(["update-index", "--refresh"], f.root);
    const refreshed = await readFile(f.index); assert.notDeepEqual(refreshed, before);
    assert.equal(statusIndexStagingIdentity(refreshed), identity);
    assert.deepEqual(inspection.restoreMetadata(refreshed), restoreStatusIndexMetadata(refreshed, before));
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

test("index shape distinguishes existing native directory caches without changing stage identity", async t => {
  const f = await fixture(t), before = statusIndexStagingInfo(await readFile(f.index));
  await runGit(["-c", "core.untrackedCache=true", "update-index", "--force-untracked-cache"], f.root);
  const after = statusIndexStagingInfo(await readFile(f.index));
  assert.equal(after?.identity, before?.identity); assert.equal(after?.directoryCount, 1);
  assert.equal(after?.hasUntrackedCache, true);
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

for (const algorithm of ["sha1", "sha256"]) test(`${algorithm} raw and saturated-length Native paths keep their identity across v2/v3/v4`, async t => {
  const f = await fixture(t, algorithm), oid = (await runGit(["rev-parse", "HEAD:-option"], f.root)).trim();
  // 작업트리에 만들 수 없는 긴/raw 이름은 Native index-info로 넣어 byte 경계를 검증한다.
  const longName = Array.from({ length: 22 }, (_, index) => `${index}-${"x".repeat(190)}`).join("/");
  assert.ok(Buffer.byteLength(longName) > 0x0fff);
  const names = [Buffer.from(longName), Buffer.concat([Buffer.from("dir/raw-"), Buffer.from([0xff, 0xfe]), Buffer.from("\tline\n.txt")])];
  await runGitWithInput(["update-index", "-z", "--index-info"], f.root,
    Buffer.concat(names.flatMap(name => [Buffer.from(`100644 ${oid} 0\t`), name, Buffer.from([0])])));
  let expected: string | undefined;
  for (const version of [2, 3, 4]) {
    await runGit(["update-index", `--index-version=${version}`], f.root);
    const bytes = await readFile(f.index), actual = statusIndexStagingIdentity(bytes);
    assert.ok(actual);
    expected ??= actual;
    assert.equal(actual, expected);
    assert.equal(statusIndexStagingInfo(bytes)?.identity, expected);
  }
});

for (const version of [2, 3]) test(`v${version} nonzero padding is rejected even with a valid Native checksum`, async t => {
  const f = await fixture(t, "sha1", version), bytes = await readFile(f.index);
  const nulEnd = bytes.indexOf(0, 12 + 62) + 1, paddedEnd = 12 + Math.ceil((nulEnd - 12) / 8) * 8;
  assert.ok(nulEnd > 12 + 62 && nulEnd < paddedEnd);
  bytes[nulEnd] = 1;
  createHash("sha1").update(bytes.subarray(0, -20)).digest().copy(bytes, bytes.length - 20);
  assert.equal(statusIndexStagingIdentity(bytes), undefined);
  assert.equal(statusIndexStagingInfo(bytes), undefined);
});

test("source inspection rejects changed bytes before and after a valid checksum is rewritten", async t => {
  const f = await fixture(t), source = await readFile(f.index), cached = Buffer.from(source);
  const inspection = StatusIndexSource.inspect(source); assert.ok(inspection);
  const original = Buffer.from(source);
  source[12] ^= 1;
  assert.equal(inspection.matches(source), false);
  assert.equal(inspection.restoreMetadata(cached), undefined);
  createHash("sha1").update(source.subarray(0, -20)).digest().copy(source, source.length - 20);
  assert.ok(statusIndexStagingIdentity(source), "Changed stat metadata is still a supported index");
  assert.equal(inspection.matches(source), false);
  assert.equal(inspection.restoreMetadata(cached), undefined);
  assert.equal(inspection.planTransition(cached, inspection.info.identity), undefined);
  original.copy(source);
  assert.equal(inspection.matches(source), true);
  assert.deepEqual(inspection.restoreMetadata(cached), cached);
});
