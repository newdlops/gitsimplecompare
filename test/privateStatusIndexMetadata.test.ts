import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PrivateStatusIndex } from "../src/git/privateStatusIndex";
import { runGit, runGitWithInput } from "../src/git/gitExec";
import { StatusIndexSource } from "../src/git/statusIndexStagingIdentity";
import { parseWorkingTreeV2, workingTreeSnapshot, type WorkingTreeSnapshot } from "../src/git/workingTreeStatusFormat";

/** 전체 파일별 의미를 보존하고 표시 순서만 정규화해 Native 원본과 비교한다. */
function groups(value: WorkingTreeSnapshot) {
  const sort = (one: { path: string }, two: { path: string }) => one.path.localeCompare(two.path);
  return { staged: [...value.groups.staged].sort(sort), unstaged: [...value.groups.unstaged].sort(sort) };
}

/** 원본 index의 byte·inode·mtime·ctime을 함께 기록해 optional cache 쓰기가 원본에 새지 않게 한다. */
async function sourceState(root: string) {
  const file = path.join(root, ".git/index"), info = await stat(file);
  return { bytes: await readFile(file), ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs };
}

test("same-stage index metadata replacement retains private UNTR while Native detects new edits and ignore rules", { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-status-metadata-")), root = path.join(directory, "repo");
  await mkdir(root); const git = (args: string[]) => runGit(args, root);
  let index: PrivateStatusIndex | undefined;
  t.after(async () => { await index?.dispose(); await rm(directory, { recursive: true, force: true }); });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "core.fsmonitor", "false"]); await git(["config", "core.untrackedCache", "false"]);
  const paths = Array.from({ length: 5001 }, (_, i) => `M 100644 :1 src/${i % 512}/${i}.txt`);
  await runGitWithInput(["fast-import", "--quiet"], root,
    `blob\nmark :1\ndata 5\nbase\n\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ndata 4\nbase\n${paths.join("\n")}\n\ndone\n`);
  await git(["read-tree", "--reset", "-u", "main"]);
  await mkdir(path.join(root, "newdir")); await writeFile(path.join(root, "newdir/entry.txt"), "untracked\n");
  const events: string[] = []; index = new PrivateStatusIndex(root, event => events.push(event));
  assert.equal((await index.readSummary(new AbortController().signal)).hasChanges, true);
  const cached = await readFile((index as any).index);
  assert.equal(StatusIndexSource.inspect(cached)?.info.hasUntrackedCache, true);
  const original = await sourceState(root);
  // pull이나 외부 Git의 stat 갱신처럼 stage 의미는 그대로 두고 원본 index의 파일 identity만 바꾼다.
  await writeFile(path.join(root, ".git/index"), original.bytes);
  await writeFile(path.join(root, "src/0/0.txt"), "late\n");
  await writeFile(path.join(root, "src/3/new.txt"), "new\n");
  await writeFile(path.join(root, ".git/info/exclude"), "newdir/\n");
  const before = await sourceState(root); events.length = 0;
  const actual = await index.read(new AbortController().signal);
  const expected = workingTreeSnapshot(root, parseWorkingTreeV2(await git([
    "status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=all",
  ])));
  assert.deepEqual(groups(actual), groups(expected));
  assert.deepEqual(await sourceState(root), before);
  assert.equal(events.includes("private status cold scan completed"), false,
    "The same stage must not discard a verified private directory cache after a metadata-only source change");
  assert.ok(events.includes("private status index metadata refreshed"));
  await git(["add", "src/0/0.txt"]); const staged = await sourceState(root); events.length = 0;
  const next = await index.read(new AbortController().signal);
  assert.equal(next.groups.staged.some(change => change.path === "src/0/0.txt"), true);
  assert.equal(events.includes("private status index metadata refreshed"), false, "Real stage changes require checked transition or replacement");
  assert.deepEqual(await sourceState(root), staged);
});
