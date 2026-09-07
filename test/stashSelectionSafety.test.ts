import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GitService } from "../src/git/gitService";
import { GitError } from "../src/git/gitExec";
import { applyStash, branchStash, dropStash, loadStashFilesForView, openStashFile } from "../src/commands/stash";
import type { CommandDeps } from "../src/commands/shared";
import * as vscode from "./helpers/vscodeMock";
import { git, safetyFixture, commitText } from "./helpers/gitSafetyFixture";

/** 실제 Git stash를 만들고 전체 OID와 당시 표시 번호를 함께 읽는다. */
async function stash(root: string, message: string, file = "tracked.txt") {
  await writeFile(join(root, file), `${message}\n`);
  await git(root, "stash", "push", "-qum", message);
  return (await new GitService(root).listStashes())[0];
}

/** 확인창 도중 활성 저장소를 바꿀 수 있는 최소 command 의존성을 구성한다. */
function commandDeps(roots: string[]) {
  let active = roots[0];
  const services = new Map(roots.map(root => [root, new GitService(root)]));
  const deps = { changesView: { getActiveRepo: () => active }, registry: { get: (root: string) => services.get(root) } } as unknown as CommandDeps;
  return { deps, activate: (root: string) => { active = root; } };
}

test("legacy stash drop pins its hash before confirmation changes stash numbers", async (t) => {
  const { root } = await safetyFixture(t, "stash-confirmation");
  const selected = await stash(root, "selected old stash");
  let unrelatedHash = "";
  t.mock.method(vscode.window, "showWarningMessage", async () => {
    unrelatedHash = (await stash(root, "unrelated new stash")).hash;
    return "Drop Stash";
  });
  vscode.__resetWindowMessages();
  await dropStash(commandDeps([root]).deps, selected.ref, selected.message);
  assert.deepEqual(vscode.__errorMessages, []);
  assert.deepEqual((await new GitService(root).listStashes()).map(entry => entry.hash), [unrelatedHash]);
});

test("a rendered stash hash survives both stale numbering and an active repository change", async (t) => {
  const first = await safetyFixture(t, "stash-rendered-first");
  const second = await safetyFixture(t, "stash-rendered-second");
  const selected = await stash(first.root, "selected rendered stash");
  const newEntry = await stash(first.root, "new first repository stash");
  const secondEntry = await stash(second.root, "second repository stash");
  const { deps, activate } = commandDeps([first.root, second.root]);
  activate(second.root);
  vscode.__resetWindowMessages();
  await applyStash(deps, { repoRoot: first.root, ref: selected.ref, hash: selected.hash });
  assert.deepEqual(vscode.__errorMessages, []);
  assert.equal(await readFile(join(first.root, "tracked.txt"), "utf8"), "selected rendered stash\n");
  assert.equal(await readFile(join(second.root, "tracked.txt"), "utf8"), "base\n");
  assert.deepEqual((await new GitService(first.root).listStashes()).map(entry => entry.hash), [newEntry.hash, selected.hash]);
  assert.equal((await new GitService(second.root).listStashes())[0].hash, secondEntry.hash);
});

test("a stash removed during confirmation never deletes its replacement", async (t) => {
  const { root } = await safetyFixture(t, "stash-removed-confirmation");
  const selected = await stash(root, "selected stash");
  let replacement = "";
  t.mock.method(vscode.window, "showWarningMessage", async () => {
    await git(root, "stash", "drop", selected.ref);
    replacement = (await stash(root, "replacement stash")).hash;
    return "Drop Stash";
  });
  vscode.__resetWindowMessages();
  await dropStash(commandDeps([root]).deps, { repoRoot: root, ref: selected.ref, hash: selected.hash });
  assert.match(vscode.__errorMessages.join("\n"), /no longer uniquely available/);
  assert.deepEqual((await new GitService(root).listStashes()).map(entry => entry.hash), [replacement]);
});

test("stash branch applies the selected hash after the input box changes the list and repository", async (t) => {
  const first = await safetyFixture(t, "stash-branch-first");
  const second = await safetyFixture(t, "stash-branch-second");
  const selected = await stash(first.root, "selected branch content");
  const { deps, activate } = commandDeps([first.root, second.root]);
  let newer = "";
  t.mock.method(vscode.window, "showInputBox", async () => {
    newer = (await stash(first.root, "newer stash content")).hash;
    activate(second.root);
    return "from-selected-stash";
  });
  vscode.__resetWindowMessages();
  await branchStash(deps, { repoRoot: first.root, ref: selected.ref, hash: selected.hash });
  assert.deepEqual(vscode.__errorMessages, []);
  assert.equal(await git(first.root, "branch", "--show-current"), "from-selected-stash");
  assert.equal(await readFile(join(first.root, "tracked.txt"), "utf8"), "selected branch content\n");
  assert.equal(await git(second.root, "branch", "--show-current"), "main");
  assert.deepEqual((await new GitService(first.root).listStashes()).map(entry => entry.hash), [newer]);
});

test("pop removes only the selected hash after its display number changes", async (t) => {
  const { root } = await safetyFixture(t, "stash-pop-reordered");
  const selected = await stash(root, "selected pop content");
  const newer = await stash(root, "newer pop content");
  const service = new GitService(root);
  await service.stashPop(selected);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "selected pop content\n");
  assert.deepEqual((await service.listStashes()).map(entry => entry.hash), [newer.hash]);
});

test("a failed pop keeps the selected stash and its conflict contents", async (t) => {
  const { root } = await safetyFixture(t, "stash-pop-conflicts");
  const selected = await stash(root, "stashed content");
  await commitText(root, "conflicting new commit\n", "later commit");
  const service = new GitService(root);
  await assert.rejects(() => service.stashPop(selected));
  assert.equal((await service.listStashes())[0].hash, selected.hash);
  assert.equal(await git(root, "diff", "--name-only", "--diff-filter=U"), "tracked.txt");
  assert.match(await readFile(join(root, "tracked.txt"), "utf8"), /stashed content/);
});

test("lazy stash files and opened diffs keep the rendered hash after reordering", async (t) => {
  const { root } = await safetyFixture(t, "stash-files-reordered");
  const selected = await stash(root, "selected file", "selected.txt");
  await stash(root, "newer file", "newer.txt");
  const { deps } = commandDeps([root]);
  const target = { repoRoot: root, ref: selected.ref, hash: selected.hash };
  const result = await loadStashFilesForView(deps, target);
  assert.equal(result?.key, `${root}@${selected.hash}`);
  assert.deepEqual(result?.files.map(file => file.path), ["selected.txt"]);
  vscode.__resetWindowMessages();
  await openStashFile(deps, { ...target, path: "selected.txt" });
  const diff = vscode.__executedCommands.find(command => command.id === "vscode.diff");
  assert.ok(diff);
  assert.match(JSON.stringify(diff.args), new RegExp(selected.hash));
});

test("cancelling a stash confirmation leaves every entry unchanged", async (t) => {
  const { root } = await safetyFixture(t, "stash-cancel");
  const selected = await stash(root, "cancel this deletion");
  vscode.__resetWindowMessages();
  await dropStash(commandDeps([root]).deps, selected.ref);
  assert.equal((await new GitService(root).listStashes())[0].hash, selected.hash);
});

test("missing stash and file queries reject while an empty stack remains a successful empty result", async (t) => {
  const { root, directory } = await safetyFixture(t, "stash-read-errors");
  const service = new GitService(root);
  assert.deepEqual(await service.listStashes(), []);
  await assert.rejects(() => service.stashShowFiles("a".repeat(40)), GitError);
  const emptyBin = join(directory, "empty-bin");
  await mkdir(emptyBin);
  const previous = process.env.PATH;
  try {
    process.env.PATH = emptyBin;
    await assert.rejects(() => service.listStashes(), GitError);
  } finally { process.env.PATH = previous; }
});
