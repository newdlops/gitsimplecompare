import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { gitCommandIndex } from "../src/git/gitCommandPolicy";
import { readLinearRebaseRange } from "../src/git/rebaseStartRange";
import { RebaseService } from "../src/git/rebaseService";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** Native 출력 framing을 검증하기 위해 SHA 형식에 맞는 서로 다른 고정 OID를 만든다. */
function oid(index: number, length = 40): string { return index.toString(16).padStart(length, "0"); }

for (const length of [40, 64]) for (const root of [false, true]) {
  test(`compact range keeps complete ${length}-digit root/parent records (${root ? "root" : "base"}) in one read`, async () => {
    let reads = 0;
    const hashes = [oid(1, length), oid(2, length)];
    const result = await readLinearRebaseRange("/owned", oid(3, length), root, async (args, cwd) => {
      reads++; assert.equal(cwd, "/owned");
      assert.deepEqual(args, ["rev-list", "--reverse", "--format=%H%x00%P", "--no-commit-header", root ? "HEAD" : `${oid(3, length)}..HEAD`, "--"]);
      return `${hashes[0]}\0\r\n${hashes[1]}\0${hashes[0]}\r\n`;
    });
    assert.equal(reads, 1); assert.deepEqual(result, hashes.map(hash => ({ hash })));
  });
}

test("empty Native range remains empty without inventing a commit", async () => {
  assert.deepEqual(await readLinearRebaseRange("/owned", oid(1), false, async () => ""), []);
});

const invalid = ["missing separator", `${oid(1)}\0`, `${oid(1)}\n`, `${oid(1)}\0\0\n`,
  `${oid(1)}\0not-an-oid\n`, `${oid(1)}\0${oid(2, 64)}\n`, `${oid(1)}\0 ${oid(2)}\n`,
  `${oid(1)}\0\n\n`, `${oid(1)}\0\n${oid(1)}\0\n`];
for (const [index, output] of invalid.entries()) test(`malformed compact range is rejected before coverage (${index})`, async () => {
  await assert.rejects(readLinearRebaseRange("/owned", oid(1), false, async () => output), /Invalid rebase range metadata/);
});

for (const root of [false, true]) test(`compact ${root ? "root" : "base"} range rejects a complete merge record`, async () => {
  await assert.rejects(readLinearRebaseRange("/owned", oid(1), root, async () => `${oid(2)}\0${oid(1)} ${oid(3)}\n`), /contains merge commits/);
});

for (const root of [false, true]) test(`Native ${root ? "root" : "base"} merge DAG is rejected before any rebase is started`, async t => {
  const f = await safetyFixture(t, "rebase-range-merge");
  await git(f.root, "switch", "-qc", "side");
  await writeFile(join(f.root, "side.txt"), "side\n"); await git(f.root, "add", "side.txt"); await git(f.root, "commit", "-qm", "side");
  await git(f.root, "switch", "-q", "main");
  await commitText(f.root, "main\n", "main");
  await git(f.root, "merge", "--no-ff", "-qm", "f".repeat(40), "side");
  const head = await git(f.root, "rev-parse", "HEAD"), index = await readFile(join(f.root, ".git/index"));
  const service = new RebaseService(f.root), commits = await service.getCommits(f.head, root, false);
  const calls: string[][] = [], spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push([...args[1]]);
    return (spawn as Function)(...args);
  });
  await assert.rejects(service.start(f.head, root, commits.map(commit => ({ hash: commit.hash, action: "pick" })),
    resolve("media/rebase/rebaseEditor.js")), /contains merge commits/);
  assert.equal(calls.some(args => ["rebase", "commit", "update-ref"].includes(args[gitCommandIndex(args)])), false);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), head);
  assert.deepEqual(await readFile(join(f.root, ".git/index")), index);
  await assert.rejects(readFile(join(f.root, ".git/rebase-merge/git-rebase-todo")), { code: "ENOENT" });
});

test("missing todo entries keep their subject labels and never start Native rebase", async t => {
  const f = await safetyFixture(t, "rebase-range-missing");
  const first = await commitText(f.root, "first\n", "first"), second = await commitText(f.root, "second\n", "second subject");
  const result = await new RebaseService(f.root).start(f.head, false, [{ hash: first, action: "pick" }], resolve("media/rebase/rebaseEditor.js"));
  assert.equal(result.status, "failed"); assert.ok(result.message?.includes(`${second.slice(0, 12)} second subject`));
  assert.equal(await git(f.root, "rev-parse", "HEAD"), second);
  await assert.rejects(readFile(join(f.root, ".git/rebase-merge/git-rebase-todo")), { code: "ENOENT" });
});

test("diagnostic metadata from a later HEAD cannot turn failed coverage into a successful Start", async t => {
  const f = await safetyFixture(t, "rebase-range-label-race");
  const first = await commitText(f.root, "first\n", "first"), second = await commitText(f.root, "second\n", "second");
  const index = await readFile(join(f.root, ".git/index")), spawn = childProcess.spawn;
  let moved = false, rebases = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") {
      const command = args[1][gitCommandIndex(args[1])];
      if (command === "log" && !moved) {
        moved = true; childProcess.execFileSync("git", ["update-ref", "refs/heads/main", first], { cwd: f.root });
      }
      if (command === "rebase") rebases++;
    }
    return (spawn as Function)(...args);
  });
  const result = await new RebaseService(f.root).start(f.head, false, [{ hash: first, action: "pick" }], resolve("media/rebase/rebaseEditor.js"));
  assert.equal(moved, true); assert.equal(rebases, 0); assert.equal(result.status, "failed");
  assert.ok(result.message?.includes(second.slice(0, 12))); assert.equal(result.message?.includes("undefined"), false);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), first);
  assert.deepEqual(await readFile(join(f.root, ".git/index")), index);
});

for (const format of ["sha1", "sha256"]) test(`Native ${format} root Start keeps all commits and rewrites messages with two fresh guards`, async t => {
  const f = await safetyFixture(t, "rebase-range-root"), root = join(f.directory, format);
  await mkdir(root); await git(root, "init", "-q", "-b", "main", `--object-format=${format}`);
  for (const [key, value] of Object.entries({ "user.name": "Range Test", "user.email": "range@example.test",
    "commit.gpgsign": "false", "core.fsmonitor": "false", "core.hooksPath": join(f.directory, "hooks") })) await git(root, "config", key, value);
  const first = await commitText(root, "root\n", "root"), second = await commitText(root, "second\n", "second");
  const tree = await git(root, "rev-parse", "HEAD^{tree}"), spawn = childProcess.spawn, calls: string[][] = [];
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push([...args[1]]);
    return (spawn as Function)(...args);
  });
  const result = await new RebaseService(root, { nativeEditors: true }).start("", true,
    [{ hash: first, action: "reword", message: "root rewritten" }, { hash: second, action: "pick" }], resolve("media/rebase/rebaseEditor.js"));
  assert.equal(result.status, "completed", result.message);
  assert.equal(calls.filter(args => args.includes("--symbolic-full-name")).length, 2);
  assert.equal(calls.filter(args => args.includes("--format=%H%x00%P")).length, 1);
  assert.equal(await git(root, "log", "--reverse", "--format=%s"), "root rewritten\nsecond");
  assert.equal(await git(root, "rev-parse", "HEAD^{tree}"), tree);
  assert.equal(await git(root, "status", "--porcelain=v1"), "");
});
