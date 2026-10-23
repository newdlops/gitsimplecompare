import assert from "node:assert/strict";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runGit } from "../src/git/gitExec";
import { GitStatusFsMonitorGuard } from "../src/git/gitStatusExec";
import { PrivateStatusIndex } from "../src/git/privateStatusIndex";
import { RepositoryIndexPathReader } from "../src/git/repositoryIndexPath";
import { parseWorkingTreeV2, workingTreeSnapshot, type WorkingTreeSnapshot } from "../src/git/workingTreeStatusFormat";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 linked worktree의 locator 하나만 다른 소유 저장소로 잠시 돌렸다 원복하는 경계를 만든다. */
async function bindingFixture(t: TestContext, kind: "gitfile" | "commondir") {
  const source = await safetyFixture(t, `metadata-aba-${kind}`);
  const other = await safetyFixture(t, `metadata-aba-other-${kind}`);
  const otherHead = await commitText(other.root, "other repository\n", "other repository");
  await git(other.root, "branch", "linked");
  const root = path.join(source.directory, "linked");
  await git(source.root, "worktree", "add", "-q", "-b", "linked", root);
  const gitDir = await git(root, "rev-parse", "--absolute-git-dir"), otherGitDir = path.join(other.root, ".git");
  const marker = kind === "gitfile" ? path.join(root, ".git") : path.join(gitDir, "commondir");
  const original = await readFile(marker), replacement = kind === "gitfile" ? `gitdir: ${otherGitDir}\n` : `${otherGitDir}\n`;
  return { source, other, root, gitDir, otherGitDir, otherHead,
    /** Native 실행이 끝나기 전에 내용을 원복해 경계 전후 문자열·inode만 보는 구현의 누락을 재현한다. */
    async redirect<T>(read: () => Promise<T>): Promise<T> {
      await writeFile(marker, replacement);
      try { return await read(); } finally { await writeFile(marker, original); }
    } };
}

/** index·HEAD·config·작업 파일의 바이트와 파일 시각을 기록해 원본 쓰기가 없는지 확인한다. */
async function fileStates(files: string[]) {
  return Promise.all(files.map(async file => {
    const info = await stat(file);
    return { file, bytes: await readFile(file), dev: info.dev, ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs };
  }));
}

/** Native 전체 status는 optional index 쓰기를 꺼서 독립된 HEAD·파일 비교 기준으로만 사용한다. */
async function authoritative(root: string) {
  const raw = await runGit(["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=all"],
    root, { env: { GIT_OPTIONAL_LOCKS: "0" } });
  return workingTreeSnapshot(root, parseWorkingTreeV2(raw));
}

/** 파일의 표시 순서만 정규화하고 HEAD·branch·stage·미추적 경로의 의미는 모두 비교한다. */
function normalized(value: WorkingTreeSnapshot) {
  const sorted = (items: typeof value.groups.staged) => [...items].sort((a, b) => a.path.localeCompare(b.path));
  return { head: value.head, branch: value.branch, upstream: value.upstream, hasChanges: value.hasChanges,
    staged: sorted(value.groups.staged), unstaged: sorted(value.groups.unstaged) };
}

for (const kind of ["gitfile", "commondir"] as const) {
  test(`${kind} restored during native index resolution cannot certify a foreign binding`, async t => {
    const f = await bindingFixture(t, kind); let calls = 0;
    const reader = new RepositoryIndexPathReader(f.root, (...args) => ++calls === 1
      ? f.redirect(() => runGit(...args)) : runGit(...args));
    await assert.rejects(reader.read(new AbortController().signal), /metadata changed while resolving/);
    const next = await reader.read(new AbortController().signal);
    assert.equal(next.file, path.resolve(f.root, await git(f.root, "rev-parse", "--git-path", "index")));
    assert.equal(await reader.unchanged(next, new AbortController().signal), true); assert.equal(calls, 2);
  });

  test(`${kind} restored after private status discards a real foreign HEAD and preserves source files`, async t => {
    const f = await bindingFixture(t, kind);
    await writeFile(path.join(f.root, "tracked.txt"), "staged source change\n");
    await git(f.root, "add", "tracked.txt");
    await writeFile(path.join(f.root, "tracked.txt"), "unstaged source change\n");
    await writeFile(path.join(f.root, "untracked.txt"), "preserved source work\n");
    const expected = normalized(await authoritative(f.root)); assert.notEqual(expected.head, f.otherHead);
    const files = [path.join(f.gitDir, "index"), path.join(f.gitDir, "HEAD"), path.join(f.source.root, ".git/config"),
      path.join(f.otherGitDir, "index"), path.join(f.otherGitDir, "HEAD"), path.join(f.otherGitDir, "config"),
      path.join(f.root, "tracked.txt"), path.join(f.root, "untracked.txt")];
    const before = await fileStates(files), events: string[] = [];
    const index = new PrivateStatusIndex(f.root, event => events.push(event)); t.after(() => index.dispose());
    await index.read(new AbortController().signal);
    const run = GitStatusFsMonitorGuard.prototype.run; let statuses = 0;
    const mock = t.mock.method(GitStatusFsMonitorGuard.prototype, "run", async function (
      this: GitStatusFsMonitorGuard, ...args: Parameters<typeof run>
    ) {
      statuses++;
      if (statuses !== 1) return Reflect.apply(run, this, args);
      const raw = await f.redirect(() => Reflect.apply(run, this, args));
      assert.equal(parseWorkingTreeV2(raw).head, f.otherHead, "The injected response really comes from the foreign repository");
      return raw;
    });
    const actual = await index.read(new AbortController().signal); mock.mock.restore();
    assert.deepEqual(normalized(actual), expected, "A transient foreign HEAD must never reach the Graph or Changes model");
    assert.equal(statuses, 2, "Discard the stale response and read the restored repository once");
    assert.ok(events.includes("private status index invalidated"));
    assert.deepEqual(await fileStates(files), before);
  });
}

test("a metadata directory replaced and restored invalidates only the in-flight read boundary", async t => {
  const f = await safetyFixture(t, "metadata-directory-aba"), other = await safetyFixture(t, "metadata-directory-other");
  await commitText(other.root, "different repository\n", "different repository");
  const locator = path.join(f.root, ".git"), saved = path.join(f.directory, "saved.git"), foreign = path.join(other.root, ".git");
  let calls = 0;
  const reader = new RepositoryIndexPathReader(f.root, (...args) => { calls++; return runGit(...args); });
  const initial = await reader.read(new AbortController().signal);
  await rename(locator, saved); await rename(foreign, locator);
  try { assert.notEqual(await git(f.root, "rev-parse", "HEAD"), f.head); }
  finally { await rename(locator, foreign); await rename(saved, locator); }
  assert.equal(await reader.unchanged(initial, new AbortController().signal), false);
  const next = await reader.read(new AbortController().signal);
  assert.equal(next.file, initial.file); assert.equal(calls, 1, "A fresh boundary can still reuse Git's validated path");
  assert.equal(await reader.unchanged(next, new AbortController().signal), true);
});
