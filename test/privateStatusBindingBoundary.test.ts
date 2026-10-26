import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runGit } from "../src/git/gitExec";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { GitStatusFsMonitorGuard } from "../src/git/gitStatusExec";
import { PrivateStatusIndex } from "../src/git/privateStatusIndex";
import { parseWorkingTreeV2, workingTreeSnapshot, type WorkingTreeSnapshot } from "../src/git/workingTreeStatusFormat";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 전체 Native status의 경로 순서만 정규화하며 HEAD·branch·XY 의미는 그대로 비교한다. */
function normalized(value: WorkingTreeSnapshot) {
  const sorted = (rows: typeof value.groups.staged) => [...rows].sort((a, b) => a.path.localeCompare(b.path));
  return { head: value.head, branch: value.branch, hasChanges: value.hasChanges,
    staged: sorted(value.groups.staged), unstaged: sorted(value.groups.unstaged) };
}

/** 사용자 설정·index 쓰기를 끈 실제 Native 전체 조회를 독립 기준으로 사용한다. */
async function authoritative(root: string) {
  return workingTreeSnapshot(root, parseWorkingTreeV2(await runGit([
    "status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=all",
  ], root, { env: { GIT_OPTIONAL_LOCKS: "0" } })));
}

/** 원본의 byte·inode·시각을 비교해 전용 index나 metadata 검증이 실제 파일을 쓰지 않게 한다. */
async function filesState(files: string[]) {
  return Promise.all(files.map(async file => {
    const info = await stat(file);
    return { file, bytes: await readFile(file), ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs };
  }));
}

for (const kind of ["main", "linked-git", "linked-common"] as const) {
  test(kind + ": invalidated status skips its stale untracked-file expansion", async t => {
    const f = await safetyFixture(t, "status-binding-" + kind);
    const root = kind === "main" ? f.root : path.join(f.directory, "linked");
    if (root !== f.root) await git(f.root, "worktree", "add", "-q", "-b", "linked", root);
    const gitDir = await git(root, "rev-parse", "--absolute-git-dir");
    const marker = path.join(kind === "linked-common" ? path.join(f.root, ".git") : gitDir, "owned-monitor-fixture");
    await writeFile(path.join(root, "tracked.txt"), "changed source\n");
    await mkdir(path.join(root, "untracked")); await writeFile(path.join(root, "untracked/entry.txt"), "untracked\n");
    const expected = normalized(await authoritative(root));
    const files = [path.join(gitDir, "index"), path.join(gitDir, "HEAD"), path.join(f.root, ".git/config"), path.join(root, "tracked.txt")];
    const before = await filesState(files), events: Array<{ event: string; phase?: unknown }> = [];
    const index = new PrivateStatusIndex(root, (event, fields) => events.push({ event, phase: fields.phase })); t.after(() => index.dispose());
    const commands: string[] = []; t.after(setGitExecutionObserver(timing => commands.push(timing.command)));
    const run = GitStatusFsMonitorGuard.prototype.run; let statuses = 0;
    t.mock.method(GitStatusFsMonitorGuard.prototype, "run", async function (this: GitStatusFsMonitorGuard, ...args: Parameters<typeof run>) {
      statuses++;
      const raw = await Reflect.apply(run, this, args);
      if (statuses === 1) {
        // daemon endpoint나 lock 파일의 생성·제거만 재현한다. 실제 daemon이나 사용자 저장소는 사용하지 않는다.
        await writeFile(marker, "owned metadata fixture\n"); await rm(marker);
      }
      return raw;
    });
    assert.deepEqual(normalized(await index.read(new AbortController().signal)), expected);
    assert.equal(statuses, 2, "The metadata boundary must still discard an uncertain Native response");
    assert.equal(commands.filter(command => command === "ls-files").length, 1, "Only the valid status may expand its untracked directories");
    assert.ok(events.some(item => item.event === "private status index invalidated" && item.phase === "beforeUntrackedExpansion"));
    assert.deepEqual(await filesState(files), before);
  });
}

test("directory replacement restored after private status still discards a foreign HEAD", async t => {
  const f = await safetyFixture(t, "status-binding-directory"), other = await safetyFixture(t, "status-binding-foreign");
  const foreignHead = await commitText(other.root, "foreign\n", "foreign");
  const expected = normalized(await authoritative(f.root)), locator = path.join(f.root, ".git");
  const saved = path.join(f.directory, "saved.git"), foreign = path.join(other.root, ".git");
  const index = new PrivateStatusIndex(f.root, () => {}); t.after(() => index.dispose());
  const run = GitStatusFsMonitorGuard.prototype.run; let statuses = 0;
  t.mock.method(GitStatusFsMonitorGuard.prototype, "run", async function (this: GitStatusFsMonitorGuard, ...args: Parameters<typeof run>) {
    if (++statuses !== 1) return Reflect.apply(run, this, args);
    await rename(locator, saved); await rename(foreign, locator);
    try {
      const raw = await Reflect.apply(run, this, args);
      assert.equal(parseWorkingTreeV2(raw).head, foreignHead); return raw;
    } finally { await rename(locator, foreign); await rename(saved, locator); }
  });
  assert.deepEqual(normalized(await index.read(new AbortController().signal)), expected);
  assert.equal(statuses, 2);
});

test("HEAD rewritten and restored without a directory-entry change cannot publish a foreign checkout", async t => {
  const f = await safetyFixture(t, "status-binding-head");
  const tree = await git(f.root, "rev-parse", "HEAD^{tree}");
  const foreignHead = await git(f.root, "commit-tree", tree, "-p", f.head, "-m", "foreign checkout");
  await git(f.root, "update-ref", "refs/heads/foreign", foreignHead);
  const file = path.join(f.root, ".git/HEAD"), original = await readFile(file);
  const expected = normalized(await authoritative(f.root));
  const index = new PrivateStatusIndex(f.root, () => {}); t.after(() => index.dispose());
  const run = GitStatusFsMonitorGuard.prototype.run; let statuses = 0;
  t.mock.method(GitStatusFsMonitorGuard.prototype, "run", async function (this: GitStatusFsMonitorGuard, ...args: Parameters<typeof run>) {
    if (++statuses !== 1) return Reflect.apply(run, this, args);
    await writeFile(file, "ref: refs/heads/foreign\n");
    try {
      const raw = await Reflect.apply(run, this, args);
      assert.equal(parseWorkingTreeV2(raw).head, foreignHead); return raw;
    } finally { await writeFile(file, original); }
  });
  assert.deepEqual(normalized(await index.read(new AbortController().signal)), expected);
  assert.equal(statuses, 2);
});

for (const kind of ["config-rewrite", "worktree-config-create-remove"] as const) {
  test(kind + ": restored configuration cannot publish another worktree's file state", async t => {
    const f = await safetyFixture(t, "status-binding-" + kind), other = await safetyFixture(t, "status-binding-config-other");
    await writeFile(path.join(other.root, "tracked.txt"), "foreign worktree modification\n");
    if (kind === "worktree-config-create-remove") await git(f.root, "config", "extensions.worktreeConfig", "true");
    const file = path.join(f.root, ".git", kind === "config-rewrite" ? "config" : "config.worktree");
    const original = kind === "config-rewrite" ? await readFile(file) : undefined;
    const expected = normalized(await authoritative(f.root));
    const index = new PrivateStatusIndex(f.root, () => {}); t.after(() => index.dispose());
    const run = GitStatusFsMonitorGuard.prototype.run; let statuses = 0;
    t.mock.method(GitStatusFsMonitorGuard.prototype, "run", async function (this: GitStatusFsMonitorGuard, ...args: Parameters<typeof run>) {
      if (++statuses !== 1) return Reflect.apply(run, this, args);
      await writeFile(file, (original?.toString("utf8") ?? "") + "\n[core]\nworktree = " + JSON.stringify(other.root) + "\n");
      try {
        const raw = await Reflect.apply(run, this, args);
        assert.ok(parseWorkingTreeV2(raw).entries.some(entry => entry.path === "tracked.txt"), "The injected response must really contain the foreign working change");
        return raw;
      } finally { if (original) await writeFile(file, original); else await rm(file); }
    });
    assert.deepEqual(normalized(await index.read(new AbortController().signal)), expected);
    assert.equal(statuses, 2);
  });
}
