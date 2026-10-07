import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitBlameService, parseBlamePorcelain, type GitBlameLine } from "../src/git/blameService";
import { disposeSharedBlameReads } from "../src/git/sharedBlameReads";

const COMMIT = "a".repeat(40);

/** 커밋 metadata를 최초 레코드에만 넣는 실제 porcelain 형태의 최소 입력이다. */
function porcelain(commit = COMMIT): string {
  return `${commit} 1 1 2\nauthor Alice\nauthor-mail <alice@example.test>\nauthor-time 1700000000\nauthor-tz +0900\nsummary first change\nfilename original.ts\n\tfirst\n${commit} 2 2\n\tsecond\n`;
}

/** Git이 실행 시각으로 만드는 미커밋 timestamp만 제외하고 실제 커밋 metadata는 전부 비교한다. */
function comparable(lines: GitBlameLine[]): GitBlameLine[] {
  return lines.map(line => /^0+$/.test(line.commit) ? { ...line, authorTime: undefined } : line);
}

test("compact blame restores metadata on following lines without sharing line contents", () => {
  const lines = parseBlamePorcelain(porcelain());
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[1], { ...lines[0], line: 2, content: "second" });
  assert.equal(lines[1].authorName, "Alice");
  assert.equal(lines[1].summary, "first change");
});

test("revisited commits restore their own metadata and accept a new origin filename", () => {
  const other = "b".repeat(40);
  const output = porcelain() + `${other} 1 3 1\nauthor Bob\nauthor-mail <bob@example.test>\nsummary another change\nfilename other.ts\n\tthird\n${COMMIT} 3 4 1\nfilename renamed.ts\n\tfourth\n`;
  const lines = parseBlamePorcelain(output);
  assert.equal(lines[2].authorName, "Bob");
  assert.equal(lines[3].authorName, "Alice");
  assert.equal(lines[3].filename, "renamed.ts");
  assert.equal(lines[3].content, "fourth");
});

test("compact blame accepts SHA-256 commits and isolates metadata between invocations", () => {
  const commit = "c".repeat(64);
  assert.equal(parseBlamePorcelain(porcelain(commit))[1].commit, commit);
  assert.equal(parseBlamePorcelain(`${COMMIT} 1 1\n\tunknown\n`)[0].authorName, "Unknown");
});

test("real compact blame matches line porcelain after edits, renames and working changes", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-compact-blame-"));
  t.after(async () => { await disposeSharedBlameReads(); await rm(root, { recursive: true, force: true }); });
  /** 테스트의 임시 저장소만 실행하고 사용자 hooks/config를 사용하지 않는다. */
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  git(["-c", "init.templateDir=", "init", "--initial-branch=main"]);
  git(["config", "user.name", "Blame Fixture"]);
  git(["config", "user.email", "blame@example.invalid"]);
  await writeFile(path.join(root, "original.ts"), Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n") + "\n");
  git(["add", "original.ts"]); git(["commit", "-m", "first file"]);
  git(["mv", "original.ts", "renamed.ts"]);
  git(["commit", "-m", "rename file"]);
  const file = path.join(root, "renamed.ts");
  const edited = Array.from({ length: 2000 }, (_, i) => i === 10 ? "new committed line" : `line ${i}`).join("\n") + "\n";
  await writeFile(file, edited); git(["add", "renamed.ts"]); git(["commit", "-m", "edit one line"]);
  await writeFile(file, edited.replace("line 20\n", "working line\n"));
  const compact = git(["blame", "--porcelain", "--", "renamed.ts"]);
  const full = git(["blame", "--line-porcelain", "--", "renamed.ts"]);
  assert.deepEqual(comparable(parseBlamePorcelain(compact)), comparable(parseBlamePorcelain(full)));
  assert.ok(Buffer.byteLength(compact) < Buffer.byteLength(full) / 3, "repeated commit metadata should be substantially smaller");
  const service = new GitBlameService(root);
  const lines = await service.getFileBlame(file);
  assert.deepEqual(comparable(lines), comparable(parseBlamePorcelain(full)));
  assert.equal(lines[0].filename, "original.ts");
  assert.equal(lines[20].commit, "0".repeat(40));
  assert.deepEqual(comparable(await service.getFileBlame(file, { startLine: 9, endLine: 23 })), comparable(parseBlamePorcelain(
    git(["blame", "--line-porcelain", "-L", "9,23", "--", "renamed.ts"])
  )));
});
