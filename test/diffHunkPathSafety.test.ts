import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DiffHunkService, type HunkSelection } from "../src/git/diffHunkService";
import { runGitBuffer } from "../src/git/gitExec";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

const names = ["[ab].bin", "a.bin", "b.bin"];
const original = Buffer.from([0, 1, 2]);
const edited = Buffer.from([0, 3, 4]);

/** bracket pattern과 겹치는 실제 binary 파일을 만들고 모두 수정한다. */
async function fixture(t: TestContext) {
  const data = await safetyFixture(t, "hunk-paths");
  for (const name of names) await writeFile(join(data.root, name), original);
  await git(data.root, "add", ".");
  await git(data.root, "commit", "-qm", "binary files");
  for (const name of names) await writeFile(join(data.root, name), edited);
  return { ...data, service: new DiffHunkService(data.root) };
}

/** binary 파일 전체 선택을 만들어 UI가 보내는 stage/path 식별자를 재현한다. */
function selection(stage: "staged" | "unstaged", path = names[0]): HunkSelection[] {
  return [{ stage, path, binary: true, hunkIds: [] }];
}

test("hunk binary stage changes only the selected literal bracket filename", async (t) => {
  const { root, service } = await fixture(t);
  await service.stageSelections(await service.getWorkingDiff(), selection("unstaged"));
  assert.equal(await git(root, "diff", "--cached", "--name-only"), names[0]);
});

test("hunk binary unstage preserves matching unselected index entries", async (t) => {
  const { root, service } = await fixture(t);
  await git(root, "add", ".");
  await service.unstageSelections(await service.getWorkingDiff(), selection("staged"));
  assert.equal(await git(root, "diff", "--cached", "--name-only"), "a.bin\nb.bin");
  for (const name of names) assert.deepEqual(await readFile(join(root, name)), edited);
});

test("hunk binary discard preserves matching unselected working files", async (t) => {
  const { root, service } = await fixture(t);
  await service.discardSelections(await service.getWorkingDiff(), selection("unstaged"));
  assert.deepEqual(await readFile(join(root, names[0])), original);
  for (const name of names.slice(1)) assert.deepEqual(await readFile(join(root, name)), edited);
});

test("a per-file hunk query never expands a literal path into neighboring files", async (t) => {
  const { service } = await fixture(t);
  assert.deepEqual((await service.getFileWorkingDiff(names[0])).map(file => file.path), [names[0]]);
});

test("a selected binary split commit leaves matching unselected files out of the commit", async (t) => {
  const { root, service } = await fixture(t);
  await service.commit(await service.getWorkingDiff(), selection("unstaged"), "selected literal binary");
  assert.deepEqual(await runGitBuffer(["show", `HEAD:${names[0]}`], root), edited);
  for (const name of names.slice(1)) {
    assert.deepEqual(await runGitBuffer(["show", `HEAD:${name}`], root), original);
    assert.deepEqual(await readFile(join(root, name)), edited);
  }
});

test("hunk staging treats pathspec magic in a binary filename literally", { skip: process.platform === "win32" }, async (t) => {
  const { root, service } = await fixture(t);
  const name = ":(glob)*.bin";
  await writeFile(join(root, name), edited);
  await service.stageSelections(await service.getWorkingDiff(), selection("unstaged", name));
  assert.equal(await git(root, "diff", "--cached", "--name-only"), name);
});
