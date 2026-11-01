import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PullRequestService } from "../src/git/pullRequestService";
import { gitCommandIndex } from "../src/git/gitCommandPolicy";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

test("a staged PR preview reads one branch catalog and at most four diffs while preserving literal staged data", async t => {
  const f = await safetyFixture(t, "preview-local-reads");
  const oldName = process.platform === "win32" ? "old name.txt" : "old\t한글\nname.txt";
  const newName = process.platform === "win32" ? "new name.txt" : "new\t한글\nname.txt";
  await writeFile(join(f.root, oldName), "rename exactly\n");
  await writeFile(join(f.root, "deleted.txt"), "delete\n");
  await writeFile(join(f.root, "binary.bin"), Buffer.from([0, 1, 2]));
  await git(f.root, "add", "-A"); await git(f.root, "commit", "-qm", "preview fixture");
  const head = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "switch", "-qc", "source"); await git(f.root, "branch", "topic");
  await git(f.root, "mv", oldName, newName); await git(f.root, "rm", "deleted.txt");
  await writeFile(join(f.root, "tracked.txt"), "stage\nextra\n");
  await writeFile(join(f.root, "binary.bin"), Buffer.from([0, 3]));
  await writeFile(join(f.root, "new [x].txt"), "new\n"); await git(f.root, "add", "-A");
  await writeFile(join(f.root, "tracked.txt"), "keep unstaged\n");
  await writeFile(join(f.root, "untracked.txt"), "keep untracked\n");
  const before = { index: await readFile(join(f.root, ".git/index")), config: await readFile(join(f.root, ".git/config")) };
  const spawn = childProcess.spawn, calls: string[] = [];
  const spy = t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git" && args[2]?.cwd === f.root) calls.push(args[1][gitCommandIndex(args[1])]);
    return Reflect.apply(spawn, childProcess, args);
  });
  const service = new PullRequestService(f.root, () => async () => JSON.stringify({ nameWithOwner: "fixture/repo" }));
  const preview = await service.getStagedPreview("main", undefined, "source"); spy.mock.restore();
  const synthetic = preview.previewCommits.find(commit => commit.synthetic)!;
  assert.equal(preview.stagedFileCount, 5);
  assert.deepEqual(synthetic.files.map(file => ({ path: file.path, status: file.status, oldPath: file.oldPath,
    additions: file.additions, deletions: file.deletions })).sort((a, b) => a.path.localeCompare(b.path)), [
    { path: "binary.bin", status: "M", oldPath: undefined, additions: 0, deletions: 0 },
    { path: "deleted.txt", status: "D", oldPath: undefined, additions: 0, deletions: 1 },
    { path: newName, status: "R", oldPath: oldName, additions: 0, deletions: 0 },
    { path: "new [x].txt", status: "A", oldPath: undefined, additions: 1, deletions: 0 },
    { path: "tracked.txt", status: "M", oldPath: undefined, additions: 2, deletions: 1 },
  ].sort((a, b) => a.path.localeCompare(b.path)));
  assert.ok(preview.sourceBranches.includes("topic") && preview.targetBranches.includes("topic"));
  assert.equal(calls.filter(command => command === "for-each-ref").length, 1);
  assert.ok(calls.filter(command => command === "diff").length <= 4, JSON.stringify(calls));
  assert.equal(await git(f.root, "rev-parse", "HEAD"), head);
  assert.deepEqual(await readFile(join(f.root, ".git/index")), before.index);
  assert.deepEqual(await readFile(join(f.root, ".git/config")), before.config);
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "keep unstaged\n");
  assert.equal(await readFile(join(f.root, "untracked.txt"), "utf8"), "keep untracked\n");
});
