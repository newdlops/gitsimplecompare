import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GitService } from "../src/git/gitService";
import { gitCommandIndex } from "../src/git/gitCommandPolicy";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

const conflictPaths = ["conflict.txt", "deleted-in-head.txt", "deleted-in-theirs.txt"];

/** 수정/삭제 충돌을 실제 Native 작업으로 만들며 다른 사용자 저장소는 접근하지 않는다. */
async function conflictedFixture(t: TestContext, operation = "merge", linked = false) {
  const fixture = await safetyFixture(t, "discard-conflict"), root = linked ? join(fixture.directory, "linked") : fixture.root;
  if (linked) await git(fixture.root, "worktree", "add", "-qb", "linked", root);
  const branch = await git(root, "branch", "--show-current");
  for (const file of [...conflictPaths, "normal.txt", "staged.txt", "keep.txt"]) await writeFile(join(root, file), "base\n");
  await git(root, "add", "."); await git(root, "commit", "-qm", "base files"); await git(root, "branch", "incoming");
  await writeFile(join(root, conflictPaths[0]), "ours\n"); await git(root, "rm", "-q", conflictPaths[1]);
  await writeFile(join(root, conflictPaths[2]), "ours\n"); await git(root, "add", "."); await git(root, "commit", "-qm", "ours");
  const head = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "-q", "incoming");
  await writeFile(join(root, conflictPaths[0]), "theirs\n"); await writeFile(join(root, conflictPaths[1]), "theirs\n");
  await git(root, "rm", "-q", conflictPaths[2]); await git(root, "add", "."); await git(root, "commit", "-qm", "theirs");
  const incoming = await git(root, "rev-parse", "HEAD");
  if (operation === "rebase") await assert.rejects(git(root, "rebase", branch));
  else {
    await git(root, "switch", "-q", branch);
    await assert.rejects(git(root, operation, ...(operation === "merge" ? ["--no-edit", "incoming"] : [incoming])));
  }
  return { ...fixture, root, head, service: new GitService(root) };
}

for (const operation of ["merge", "rebase", "cherry-pick"]) {
  test(`discard resolves selected ${operation} conflicts to HEAD while preserving staged and unselected changes`, async t => {
    const fixture = await conflictedFixture(t, operation), { root, service, head } = fixture;
    await writeFile(join(root, "normal.txt"), "discard normal\n");
    await writeFile(join(root, "staged.txt"), "keep staged\n"); await git(root, "add", "staged.txt");
    await writeFile(join(root, "staged.txt"), "discard unstaged part\n");
    await writeFile(join(root, "keep.txt"), "keep unselected work\n");
    await writeFile(join(root, "remove-untracked.txt"), "remove\n"); await writeFile(join(root, "keep-untracked.txt"), "keep\n");
    const markers = await git(root, "rev-parse", "--git-path", operation === "merge" ? "MERGE_HEAD" : operation === "rebase" ? "rebase-merge/orig-head" : "CHERRY_PICK_HEAD");
    const marker = await readFile(markers.startsWith("/") ? markers : join(root, markers));
    await service.discard([...conflictPaths, "normal.txt", "staged.txt", "remove-untracked.txt"]);
    assert.equal(await git(root, "ls-files", "--unmerged"), "");
    assert.equal(await readFile(join(root, conflictPaths[0]), "utf8"), "ours\n");
    await assert.rejects(readFile(join(root, conflictPaths[1])), { code: "ENOENT" });
    assert.equal(await readFile(join(root, conflictPaths[2]), "utf8"), "ours\n");
    assert.equal(await readFile(join(root, "normal.txt"), "utf8"), "base\n");
    assert.equal(await readFile(join(root, "staged.txt"), "utf8"), "keep staged\n");
    assert.equal(await git(root, "show", ":staged.txt"), "keep staged");
    assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "keep unselected work\n");
    await assert.rejects(readFile(join(root, "remove-untracked.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "keep-untracked.txt"), "utf8"), "keep\n");
    assert.equal(await git(root, "rev-parse", "HEAD"), head);
    assert.deepEqual(await readFile(markers.startsWith("/") ? markers : join(root, markers)), marker);
  });
}

test("discarding one linked-worktree conflict leaves all other conflict stages and the main worktree intact", async t => {
  const { root, service, head, directory } = await conflictedFixture(t, "merge", true);
  const untouched = await git(root, "ls-files", "--unmerged", "--", ...conflictPaths.slice(1));
  const mainHead = await git(join(directory, "repo"), "rev-parse", "HEAD");
  await service.discard([conflictPaths[0]]);
  assert.equal(await git(root, "ls-files", "--unmerged", "--", conflictPaths[0]), "");
  assert.equal(await git(root, "ls-files", "--unmerged", "--", ...conflictPaths.slice(1)), untouched);
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.equal(await git(join(directory, "repo"), "rev-parse", "HEAD"), mainHead);
});

test("small discard selections never enumerate unrelated untracked files", async t => {
  const { root } = await safetyFixture(t, "discard-scoped-read");
  await mkdir(join(root, "unrelated"));
  for (let index = 0; index < 250; index++) await writeFile(join(root, "unrelated", `${index}.txt`), "keep\n");
  await writeFile(join(root, "tracked.txt"), "discard\n");
  const spawn = childProcess.spawn, calls: string[][] = [];
  let bytes = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const child = (spawn as Function)(...args);
    if (args[0] === "git") {
      calls.push(args[1]);
      if (args[1][gitCommandIndex(args[1])] === "ls-files") child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; });
    }
    return child;
  });
  await new GitService(root).discard(["tracked.txt"]);
  assert.equal(calls.length, 2);
  assert.equal(bytes, 0, "the selected tracked file needs no unmerged/untracked output from unrelated folders");
  const read = calls.find(args => args[gitCommandIndex(args)] === "ls-files")!;
  assert.deepEqual(read.slice(read.indexOf("--") + 1), ["tracked.txt"]);
  assert.equal(await readFile(join(root, "unrelated/0.txt"), "utf8"), "keep\n");
});

test("discard preview rejects an untracked file that became staged before confirmation", async t => {
  const { root } = await safetyFixture(t, "discard-new-stage"), service = new GitService(root);
  await writeFile(join(root, "new.txt"), "preserve newly staged file\n");
  const preview = await (service as any).prepareDiscard(["new.txt"]);
  await git(root, "add", "new.txt");
  await assert.rejects((service as any).discard(["new.txt"], preview), /changed.*discard|discard.*again/i);
  assert.equal(await readFile(join(root, "new.txt"), "utf8"), "preserve newly staged file\n");
  assert.equal(await git(root, "show", ":new.txt"), "preserve newly staged file");
});

test("an aborted and restarted merge cannot reuse confirmation from the previous native operation", async t => {
  const { root, service } = await conflictedFixture(t);
  const preview = await (service as any).prepareDiscard([conflictPaths[0]]);
  await git(root, "merge", "--abort"); await assert.rejects(git(root, "merge", "--no-edit", "incoming"));
  const before = await git(root, "ls-files", "--unmerged");
  await assert.rejects((service as any).discard([conflictPaths[0]], preview), /changed|again/i);
  assert.equal(await git(root, "ls-files", "--unmerged"), before);
  assert.match(await readFile(join(root, conflictPaths[0]), "utf8"), /<<<<<<< /);
});

test("discard rechecks conflict stages after reading HEAD paths before any restore", async t => {
  const { root, service } = await conflictedFixture(t), spawn = childProcess.spawn;
  let changed = false, mutationError: unknown;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const child = (spawn as Function)(...args);
    if (!changed && args[0] === "git" && args[1][gitCommandIndex(args[1])] === "ls-tree") {
      changed = true;
      const emit = child.emit;
      // Native 조회가 끝난 직후 외부 에디터가 해결 내용을 stage하는 경계를 재현한다.
      child.emit = function(event: string, ...values: any[]) {
        if (event !== "close") return emit.call(child, event, ...values);
        void (async () => {
          try {
            await writeFile(join(root, conflictPaths[0]), "newly resolved and staged\n");
            await git(root, "add", "--", conflictPaths[0]);
          } catch (error) { mutationError = error; }
          finally { emit.call(child, event, ...values); }
        })();
        return true;
      };
    }
    return child;
  });
  await assert.rejects(service.discard([conflictPaths[0]]), /changed.*discard|discard.*again/i);
  assert.equal(changed, true); assert.equal(mutationError, undefined);
  assert.equal(await readFile(join(root, conflictPaths[0]), "utf8"), "newly resolved and staged\n");
  assert.equal(await git(root, "show", `:${conflictPaths[0]}`), "newly resolved and staged");
});

test("literal untracked names containing index-like text, pathspec syntax, tabs and newlines are only deleted when selected", async t => {
  const { root } = await safetyFixture(t, "discard-literal-untracked"), service = new GitService(root);
  const selected = ["100644 " + "a".repeat(40) + " 1\tfake.txt", ":(glob)*.txt", "한글\tline\n.txt"];
  for (const name of [...selected, "keep.txt"]) await writeFile(join(root, name), name);
  await service.discard(selected);
  for (const name of selected) await assert.rejects(readFile(join(root, name)), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "keep.txt");
});

test("discard refuses paths outside the selected repository before deleting files", async t => {
  const { root, directory } = await safetyFixture(t, "discard-outside"), outside = join(directory, "outside.txt");
  await writeFile(outside, "keep outside\n");
  await assert.rejects(new GitService(root).discard(["../outside.txt"]), /outside|relative|invalid/i);
  assert.equal(await readFile(outside, "utf8"), "keep outside\n");
});
