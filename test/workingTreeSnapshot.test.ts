import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test, { type TestContext } from "node:test";
import { GitService } from "../src/git/gitService";
import { GitLogService } from "../src/git/gitLogService";
import { GitError, runGit } from "../src/git/gitExec";
import { GitStatusFsMonitorGuard } from "../src/git/gitStatusExec";
import { PrivateStatusIndex } from "../src/git/privateStatusIndex";
import { disposeWorkingTreeSnapshots } from "../src/git/workingTreeSnapshot";
import { parsePorcelainGroups } from "../src/git/diffParse";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";

/** 실제 Git fixture를 만들어 변경 목록과 Graph가 같은 저장소를 읽게 한다. */
async function repository(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-shared-status-"));
  t.after(async () => { await disposeWorkingTreeSnapshots(); await rm(root, { recursive: true, force: true }); });
  await runGit(["init", "-q"], root);
  await runGit(["config", "user.name", "Fixture"], root);
  await runGit(["config", "user.email", "fixture@example.invalid"], root);
  await runGit(["config", "core.fsmonitor", "false"], root);
  await writeFile(path.join(root, "old.txt"), "initial\n");
  await writeFile(path.join(root, "edit.txt"), "initial\n");
  await runGit(["add", "."], root);
  await runGit(["commit", "-qm", "initial"], root, { env: { HUSKY: "0" } });
  return root;
}

test("Changes and Graph share a single authoritative status process", async t => {
  const root = await repository(t);
  await writeFile(path.join(root, "edit.txt"), "changed\n");
  let statuses = 0;
  t.after(setGitExecutionObserver(timing => { if (timing.command === "status") statuses++; }));
  const service = new GitService(root), graph = new GitLogService(root);
  const [groups, commits] = await Promise.all([service.getStatusGroups({ force: true, includeStats: false }), graph.getVirtualCommits()]);
  assert.deepEqual(groups.unstaged.map(change => change.path), ["edit.txt"]);
  assert.equal(commits.length, 2);
  assert.equal(statuses, 1, "two consumers must not scan the same worktree twice");
});

for (const format of ["split", "sparse", "linked"] as const) {
  test(`private status matches complete Git output and preserves the ${format} index`, async t => {
    let root = await repository(t);
    await mkdir(path.join(root, "included")); await mkdir(path.join(root, "excluded"));
    await writeFile(path.join(root, "included/a.txt"), "base\n"); await writeFile(path.join(root, "excluded/b.txt"), "base\n");
    await runGit(["add", "."], root); await runGit(["commit", "-qm", "folders"], root);
    if (format === "split") await runGit(["update-index", "--split-index"], root);
    if (format === "sparse") {
      await runGit(["sparse-checkout", "init", "--cone", "--sparse-index"], root);
      await runGit(["sparse-checkout", "set", "included"], root);
    }
    if (format === "linked") {
      const linked = root + "-linked";
      await runGit(["worktree", "add", "-b", "linked-test", linked], root); root = linked;
      t.after(() => rm(linked, { recursive: true, force: true }));
    }
    await writeFile(path.join(root, "included/a.txt"), "modified\n");
    await mkdir(path.join(root, "new/deep"), { recursive: true }); await writeFile(path.join(root, "new/deep/file.txt"), "new\n");
    const indexPath = path.resolve(root, (await runGit(["rev-parse", "--git-path", "index"], root)).trim());
    const before = await readFile(indexPath);
    const expected = parsePorcelainGroups(await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root, { env: { GIT_OPTIONAL_LOCKS: "0" } }));
    for (let round = 0; round < 2; round++) {
      const actual = await new GitService(root).getStatusGroups({ force: true, includeStats: false });
      const sorted = (groups: typeof actual) => ({ staged: [...groups.staged].sort((a, b) => a.path.localeCompare(b.path)), unstaged: [...groups.unstaged].sort((a, b) => a.path.localeCompare(b.path)) });
      assert.deepEqual(sorted(actual), sorted(expected)); assert.deepEqual(await readFile(indexPath), before);
    }
  });
}

test("private index timeout never retries as an authoritative scan", async t => {
  const root = await repository(t); let statuses = 0;
  const timeout = new GitError("timed out", "", "", Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
  t.mock.method(GitStatusFsMonitorGuard.prototype, "run", async () => { statuses++; throw timeout; });
  const index = new PrivateStatusIndex(root, () => undefined); t.after(() => index.dispose());
  await assert.rejects(index.read(new AbortController().signal), error => error === timeout);
  assert.equal(statuses, 1);
});

test("cached complete status preserves staged rename and every hostile untracked filename without changing the real index", async t => {
  const root = await repository(t);
  await rename(path.join(root, "old.txt"), path.join(root, "renamed name.txt"));
  await runGit(["add", "-A"], root);
  await writeFile(path.join(root, "edit.txt"), "changed\n");
  const names = ["new dir/deep/file.txt", "new dir/-option", "[glob]/a.txt", "line\nbreak.txt", " leading.txt"];
  for (const name of names) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), "new\n"); }
  const index = await readFile(path.join(root, ".git/index"));
  const authoritative = parsePorcelainGroups(await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root, { env: { GIT_OPTIONAL_LOCKS: "0" } }));
  const service = new GitService(root);
  for (let round = 0; round < 3; round++) {
    const groups = await service.getStatusGroups({ force: true, includeStats: false });
    const sort = (items: typeof groups.staged) => [...items].sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(sort(groups.staged), sort(authoritative.staged));
    assert.deepEqual(sort(groups.unstaged), sort(authoritative.unstaged));
    for (const name of names) assert.ok(groups.unstaged.some(change => change.path === name), name);
    assert.deepEqual(await readFile(path.join(root, ".git/index")), index);
  }
});
