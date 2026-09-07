import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GitError, runGit, runGitBuffer, runGitWithInput } from "../src/git/gitExec";
import { GitService } from "../src/git/gitService";
import { GitServiceRegistry } from "../src/git/serviceRegistry";
import { BranchContentProvider } from "../src/providers/branchContentProvider";
import { makeRefUri } from "../src/utils/uri";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

const special = "[ab].txt";
const paths = [special, "a.txt", "b.txt"];

/** 패턴과 정확한 파일명이 동시에 일치하는 파일 세 개를 만들고 모두 수정한다. */
async function pathFixture(t: TestContext) {
  const fixture = await safetyFixture(t, "literal-paths");
  for (const file of paths) await writeFile(join(fixture.root, file), "base\n");
  await git(fixture.root, "add", ".");
  await git(fixture.root, "commit", "-qm", "path fixtures");
  for (const file of paths) await writeFile(join(fixture.root, file), `edited ${file}\n`);
  return { ...fixture, service: new GitService(fixture.root) };
}

test("stage treats the selected bracket filename literally", async (t) => {
  const { root, service } = await pathFixture(t);
  await service.stage([special]);
  assert.equal(await git(root, "diff", "--cached", "--name-only"), special);
});

test("unstage preserves other files whose names match a selected path pattern", async (t) => {
  const { root, service } = await pathFixture(t);
  await service.stageAll();
  await service.unstage([special]);
  assert.equal(await git(root, "diff", "--cached", "--name-only"), "a.txt\nb.txt");
  assert.equal(await readFile(join(root, special), "utf8"), `edited ${special}\n`);
});

test("discard preserves unselected working changes matching a selected path pattern", async (t) => {
  const { root, service } = await pathFixture(t);
  await service.discard([special]);
  assert.equal(await readFile(join(root, special), "utf8"), "base\n");
  for (const file of paths.slice(1)) {
    assert.equal(await readFile(join(root, file), "utf8"), `edited ${file}\n`);
  }
});

test("pathspec magic in a filename cannot expand a stage selection", { skip: process.platform === "win32" }, async (t) => {
  const { root, service } = await pathFixture(t);
  const file = ":(glob)*.txt";
  await writeFile(join(root, file), "literal magic\n");
  await service.stage([file]);
  assert.equal(await git(root, "diff", "--cached", "--name-only"), file);
});

test("Git exit codes survive string, stdin and Buffer execution failures", async (t) => {
  const { root } = await safetyFixture(t, "git-error-code");
  const args = ["config", "--get", "gitsimplecompare.missingSafetyConfig"];
  for (const run of [
    () => runGit(args, root),
    () => runGitWithInput(args, root, ""),
    () => runGitBuffer(args, root),
  ]) {
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof GitError);
      assert.equal(error.code, 1);
      assert.ok(error.cause instanceof Error);
      return true;
    });
  }
});

test("a rejected commit containing index.lock runs its hook only once", async (t) => {
  const { root, directory } = await safetyFixture(t, "hook-retry");
  await writeFile(join(directory, "hooks/pre-commit"),
    "#!/bin/sh\nprintf 'run\\n' >> .git/hook-runs\nprintf 'Commit policy rejected this change.\\n' >&2\nexit 1\n",
    { mode: 0o755 });
  await writeFile(join(root, "tracked.txt"), "edited\n");
  const service = new GitService(root);
  await service.stageAll();
  await assert.rejects(() => service.commit("Fix index.lock handling"), /Commit policy rejected/);
  assert.equal(await readFile(join(root, ".git/hook-runs"), "utf8"), "run\n");
});

test("a genuine temporary index lock still retries a safe stage operation", async (t) => {
  const { root } = await safetyFixture(t, "index-lock");
  await writeFile(join(root, "tracked.txt"), "edited\n");
  const lock = join(root, ".git/index.lock");
  await writeFile(lock, "");
  const release = new Promise<void>((resolve, reject) => {
    setTimeout(() => { rm(lock).then(resolve, reject); }, 100);
  });
  await new GitService(root).stage(["tracked.txt"]);
  await release;
  assert.equal(await git(root, "diff", "--cached", "--name-only"), "tracked.txt");
});

test("a ref lock failure after a successful commit hook never replays that hook", async (t) => {
  const { root, directory } = await safetyFixture(t, "commit-ref-lock");
  await writeFile(join(directory, "hooks/pre-commit"),
    "#!/bin/sh\nprintf 'run\\n' >> .git/hook-runs\n: > .git/HEAD.lock\n", { mode: 0o755 });
  await writeFile(join(root, "tracked.txt"), "edited\n");
  const service = new GitService(root);
  await service.stageAll();
  await assert.rejects(() => service.commit("commit with a late ref lock"), /cannot lock ref|Unable to create/);
  assert.equal(await readFile(join(root, ".git/hook-runs"), "utf8"), "run\n");
});

test("pre-aborted stdin and Buffer commands never spawn or write Git objects", async (t) => {
  const { root } = await safetyFixture(t, "git-cancel");
  const controller = new AbortController();
  controller.abort();
  const content = "cancelled object\n";
  const oid = (await runGitWithInput(["hash-object", "--stdin"], root, content)).trim();
  await assert.rejects(() => runGitWithInput(
    ["hash-object", "-w", "--stdin"], root, content, { signal: controller.signal }
  ), /cancelled/i);
  await assert.rejects(() => runGitBuffer(["rev-parse", "HEAD"], root, { signal: controller.signal }), /cancelled/i);
  await assert.rejects(() => runGit(["cat-file", "-e", oid], root));
});

test("missing paths are empty while invalid refs and corrupt blobs remain failures", async (t) => {
  const { root } = await safetyFixture(t, "file-content-errors");
  const service = new GitService(root);
  assert.equal(await service.getFileContentAtRef("HEAD", "absent.txt"), "");
  assert.equal(await service.getFileContentAtRef(":0", "absent.txt"), "");
  assert.equal(await service.getFileContentAtRef("HEAD", "tracked.txt"), "base\n");
  await assert.rejects(() => service.getFileContentAtRef("nonexistent-ref", "tracked.txt"), GitError);
  const oid = await git(root, "rev-parse", "HEAD:tracked.txt");
  await rm(join(root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
  await assert.rejects(() => service.getFileContentAtRef("HEAD", "tracked.txt"), GitError);
});

test("a failed virtual document read is retried after Git becomes available", async (t) => {
  const { root, directory } = await safetyFixture(t, "file-content-cache");
  const provider = new BranchContentProvider(new GitServiceRegistry());
  const uri = makeRefUri("HEAD", "tracked.txt", root);
  const emptyBin = join(directory, "empty-bin");
  await mkdir(emptyBin);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = emptyBin;
    await assert.rejects(() => provider.provideTextDocumentContent(uri), (error: unknown) => {
      assert.ok(error instanceof GitError);
      assert.equal(error.code, "ENOENT");
      return true;
    });
  } finally {
    process.env.PATH = previousPath;
  }
  assert.equal(await provider.provideTextDocumentContent(uri), "base\n");
});

test("HEAD remains an empty diff base before the first commit", async (t) => {
  const { directory } = await safetyFixture(t, "unborn-file-content");
  const root = join(directory, "unborn");
  await mkdir(root);
  await git(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "new.txt"), "new content\n");
  assert.equal(await new GitService(root).getFileContentAtRef("HEAD", "new.txt"), "");
});
