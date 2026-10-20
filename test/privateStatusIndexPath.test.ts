import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runGit } from "../src/git/gitExec";
import { GitStatusFsMonitorGuard } from "../src/git/gitStatusExec";
import { PrivateStatusIndex } from "../src/git/privateStatusIndex";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { parseWorkingTreeV2, workingTreeSnapshot, type WorkingTreeSnapshot } from "../src/git/workingTreeStatusFormat";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 Git 전체 status와 비교하되 행 순서는 의미가 없어 파일 경로별로 정렬한다. */
function normalized(value: WorkingTreeSnapshot) {
  const sort = (items: typeof value.groups.staged) => [...items].sort((left, right) => left.path.localeCompare(right.path));
  return { head: value.head, branch: value.branch, upstream: value.upstream, hasChanges: value.hasChanges,
    staged: sort(value.groups.staged), unstaged: sort(value.groups.unstaged) };
}

/** 사용자 index를 갱신하지 않는 전체 status를 독립된 비교 기준으로 사용한다. */
async function authoritative(root: string) {
  return workingTreeSnapshot(root, parseWorkingTreeV2(await runGit(["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=all"],
    root, { env: { GIT_OPTIONAL_LOCKS: "0" } })));
}

test("repeated status resolves the index once while edits, staging and new files stay fresh", async t => {
  const f = await safetyFixture(t, "private-status-path"), index = new PrivateStatusIndex(f.root, () => undefined);
  t.after(() => index.dispose());
  const spawn = childProcess.spawn; let paths = 0;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
    if (Array.isArray(args[1]) && args[1][0] === "rev-parse" && args[1].includes("--git-path") && args[1].includes("index")) paths++;
    return Reflect.apply(spawn, childProcess, args);
  });
  for (let round = 0; round < 3; round++) {
    if (round === 1) await writeFile(path.join(f.root, "tracked.txt"), "modified\n");
    if (round === 2) {
      await git(f.root, "add", "tracked.txt"); await mkdir(path.join(f.root, "new/deep"), { recursive: true });
      await writeFile(path.join(f.root, "new/deep/untracked.txt"), "untracked\n");
    }
    const before = await readFile(path.join(f.root, ".git/index"));
    assert.deepEqual(normalized(await index.read(new AbortController().signal)), normalized(await authoritative(f.root)));
    assert.deepEqual(await readFile(path.join(f.root, ".git/index")), before);
  }
  assert.equal(paths, 1, "New index content must stay fresh without repeating the location lookup");
});

test("metadata repointed after status discards the obsolete result and preserves both real indexes", async t => {
  const f = await safetyFixture(t, "private-status-origin"), other = await safetyFixture(t, "private-status-replacement");
  await git(other.root, "branch", "-m", "replacement");
  await commitText(other.root, "other repository\n", "other repository");
  const oldGitDir = path.join(f.directory, "original.git"), newGitDir = path.join(other.root, ".git");
  await rename(path.join(f.root, ".git"), oldGitDir);
  await writeFile(path.join(f.root, ".git"), `gitdir: ${oldGitDir}\n`);
  const events: string[] = [], index = new PrivateStatusIndex(f.root, event => events.push(event)); t.after(() => index.dispose());
  await index.read(new AbortController().signal);
  const oldBytes = await readFile(path.join(oldGitDir, "index")), newBytes = await readFile(path.join(newGitDir, "index"));
  const run = GitStatusFsMonitorGuard.prototype.run; let repointed = false, statuses = 0;
  t.mock.method(GitStatusFsMonitorGuard.prototype, "run", async function (this: GitStatusFsMonitorGuard, ...args: Parameters<typeof run>) {
    const raw = await Reflect.apply(run, this, args); statuses++;
    if (!repointed) { repointed = true; await writeFile(path.join(f.root, ".git"), `gitdir: ${newGitDir}\n`); }
    return raw;
  });
  const result = await index.read(new AbortController().signal);
  assert.equal(statuses, 2); assert.equal(result.branch, "replacement");
  assert.deepEqual(normalized(result), normalized(await authoritative(f.root)));
  assert.equal(events.includes("private status index invalidated"), true);
  assert.deepEqual(await readFile(path.join(oldGitDir, "index")), oldBytes);
  assert.deepEqual(await readFile(path.join(newGitDir, "index")), newBytes);
});

test("metadata that cannot be proved uses native status without a private index", async t => {
  const f = await safetyFixture(t, "private-status-unproven"), gitDir = path.join(f.directory, "repository.git");
  await rename(path.join(f.root, ".git"), gitDir);
  // Git은 끝의 빈 줄들을 허용하지만 보수적인 metadata 파서는 이 gitfile을 증거로 채택하지 않는다.
  await writeFile(path.join(f.root, ".git"), `gitdir: ${gitDir}\n\n`);
  await writeFile(path.join(f.root, "tracked.txt"), "changed\n");
  const before = await readFile(path.join(gitDir, "index")), index = new PrivateStatusIndex(f.root, () => undefined);
  t.after(() => index.dispose());
  const statuses: string[] = [], stop = setGitExecutionObserver(value => {
    if (value.command === "status") statuses.push(value.statusIndex ?? "unknown");
  }); t.after(stop);
  const actual = await index.read(new AbortController().signal); stop();
  assert.deepEqual(statuses, ["repository"]);
  assert.deepEqual(normalized(actual), normalized(await authoritative(f.root)));
  assert.deepEqual(await readFile(path.join(gitDir, "index")), before);
});
