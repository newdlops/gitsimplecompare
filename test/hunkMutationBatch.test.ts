import assert from "node:assert/strict";
import { readFile, mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { unlinkSync, writeFileSync } from "node:fs";
import childProcess from "node:child_process";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { DiffHunkService, type DiffFile, type HunkSelection } from "../src/git/diffHunkService";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 두 개의 독립 hunk를 가진 내용을 만들어 첫 선택과 남는 작업 변경을 구분한다. */
function text(name: string, first = "original", last = "original"): string {
  return [`${name} ${first} first`, ...Array.from({ length: 30 }, (_, i) => `${name} context ${i}`),
    `${name} ${last} last`, ""].join("\n");
}

/** 선택 파일과 이웃 파일을 함께 수정하되 실제 사용자 저장소는 사용하지 않는다. */
async function fixture(t: TestContext, names = Array.from({ length: 8 }, (_, i) => `selected-${i}.txt`)) {
  const f = await safetyFixture(t, "hunk-mutation-batch");
  const unrelated = ["neighbor-a.txt", "neighbor-b.txt"];
  for (const name of [...names, ...unrelated]) {
    await mkdir(dirname(join(f.root, name)), { recursive: true });
    await writeFile(join(f.root, name), text(name));
  }
  await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "hunk fixture");
  for (const name of [...names, ...unrelated]) await writeFile(join(f.root, name), text(name, "changed", "changed"));
  return { ...f, names, unrelated, service: new DiffHunkService(f.root) };
}

/** 첫 hunk만 선택해 전체 파일 stage/checkout으로 대체되는 회귀를 잡는다. */
function selections(files: DiffFile[], names: string[], stage: "staged" | "unstaged"): HunkSelection[] {
  return files.filter(file => file.stage === stage && names.includes(file.path)).map(file => {
    assert.equal(file.hunks.length, 2);
    return { stage, path: file.path, binary: false, hunkIds: [file.hunks[0].id] };
  });
}

/** 실제 Git을 유지하면서 검증/변경 작업에 필요한 프로세스 수만 기록한다. */
async function observed(operation: () => Promise<void>): Promise<string[]> {
  const commands: string[] = [], release = setGitExecutionObserver(call => commands.push(call.command));
  try { await operation(); return commands; } finally { release(); }
}

/** 작업 전후의 HEAD와 index 원본을 비교해 거절된 작업이 쓰기를 남기지 않는지 확인한다. */
async function identity(root: string) {
  return { head: await git(root, "rev-parse", "HEAD"), index: await readFile(join(root, ".git/index")) };
}

for (const action of ["stage", "unstage", "discard", "commit"] as const) {
  test(`multi-file partial ${action} retains exact selected changes with a bounded Git read budget`, async t => {
    const f = await fixture(t);
    if (action === "unstage") await git(f.root, "add", ".");
    const files = await f.service.getWorkingDiff(), stage = action === "unstage" ? "staged" : "unstaged";
    const picked = selections(files, f.names, stage);
    const commands = await observed(() => action === "stage" ? f.service.stageSelections(files, picked)
      : action === "unstage" ? f.service.unstageSelections(files, picked)
      : action === "discard" ? f.service.discardSelections(files, picked)
      : f.service.commit(files, picked, "selected first hunks"));
    for (const name of f.names) {
      const index = await git(f.root, "show", `:${name}`);
      assert.equal(index, text(name, action === "stage" || action === "commit" ? "changed" : "original",
        action === "unstage" ? "changed" : "original").trim());
      assert.equal(await readFile(join(f.root, name), "utf8"),
        text(name, action === "discard" ? "original" : "changed", "changed"));
      if (action === "commit") assert.equal(await git(f.root, "show", `HEAD:${name}`), text(name, "changed").trim());
    }
    for (const name of f.unrelated) {
      assert.equal(await readFile(join(f.root, name), "utf8"), text(name, "changed", "changed"));
      assert.equal(await git(f.root, "show", `:${name}`),
        text(name, action === "unstage" ? "changed" : "original", action === "unstage" ? "changed" : "original").trim());
    }
    assert.ok(commands.length <= (action === "commit" ? 11 : 5), `${commands.length} Git executions for ${f.names.length} selected files`);
  });

  test(`a changed selection rejects multi-file ${action} without altering HEAD, index or working files`, async t => {
    const f = await fixture(t);
    if (action === "unstage") await git(f.root, "add", ".");
    const files = await f.service.getWorkingDiff();
    const picked = selections(files, f.names, action === "unstage" ? "staged" : "unstaged");
    await writeFile(join(f.root, f.names[0]), "later external edit\n");
    if (action === "unstage") await git(f.root, "add", f.names[0]);
    const before = await identity(f.root);
    await assert.rejects(() => action === "stage" ? f.service.stageSelections(files, picked)
      : action === "unstage" ? f.service.unstageSelections(files, picked)
      : action === "discard" ? f.service.discardSelections(files, picked)
      : f.service.commit(files, picked, "must not commit"), /변경 내용이 바뀌어/);
    assert.deepEqual(await identity(f.root), before);
    assert.equal(await readFile(join(f.root, f.names[0]), "utf8"), "later external edit\n");
    assert.equal(await readFile(join(f.root, f.names[1]), "utf8"), text(f.names[1], "changed", "changed"));
  });
}

test("long selected paths remain complete across bounded argument chunks", async t => {
  const prefix = Array.from({ length: 4 }, (_, i) => `${i}-${"p".repeat(138)}`).join("/");
  const names = Array.from({ length: 12 }, (_, i) => `${prefix}/file-${i}-${"p".repeat(135)}.txt`);
  const f = await fixture(t, names), files = await f.service.getWorkingDiff();
  const commands = await observed(() => f.service.stageSelections(files, selections(files, names, "unstaged")));
  const staged = (await git(f.root, "diff", "--cached", "--name-only", "-z")).split("\0").filter(Boolean);
  assert.deepEqual(staged.sort(), [...names].sort());
  for (const name of [names[0], names.at(-1)!]) assert.equal(await git(f.root, "show", `:${name}`), text(name, "changed").trim());
  assert.ok(commands.length <= 8, `${commands.length} Git executions for long path selections`);
});

test("batched literal path selections do not stage wildcard neighbors", async t => {
  const names = ["[ab].txt", "ordinary.txt"], f = await fixture(t, [...names, "a.txt", "b.txt"]);
  const files = await f.service.getWorkingDiff();
  const commands = await observed(() => f.service.stageSelections(files, selections(files, names, "unstaged")));
  assert.deepEqual((await git(f.root, "diff", "--cached", "--name-only")).split("\n").sort(), [...names].sort());
  for (const name of ["a.txt", "b.txt"]) assert.equal(await git(f.root, "show", `:${name}`), text(name).trim());
  assert.ok(commands.length <= 5);
});

test("a lock retry revalidates selected files instead of reusing the earlier batch", async t => {
  const f = await fixture(t), files = await f.service.getWorkingDiff();
  const before = await identity(f.root), lock = join(f.root, ".git/index.lock");
  await writeFile(lock, "owned fixture lock\n");
  let failures = 0, applies = 0;
  const release = setGitExecutionObserver(call => {
    if (call.command !== "apply") return;
    applies++;
    if (call.outcome === "error" && ++failures === 1) {
      writeFileSync(join(f.root, f.names[0]), "changed during lock wait\n");
      unlinkSync(lock);
    }
  });
  try {
    await assert.rejects(() => f.service.stageSelections(files, selections(files, f.names, "unstaged")), /변경 내용이 바뀌어/);
  } finally { release(); }
  assert.equal(failures, 1); assert.equal(applies, 1);
  assert.deepEqual(await identity(f.root), before);
  assert.equal(await readFile(join(f.root, f.names[0]), "utf8"), "changed during lock wait\n");
});

test("an unrelated real merge conflict still blocks partial staging before writes", async t => {
  const f = await fixture(t), files = await f.service.getWorkingDiff();
  await git(f.root, "switch", "-qc", "side");
  await writeFile(join(f.root, "tracked.txt"), "side\n"); await git(f.root, "commit", "-qm", "side", "tracked.txt");
  await git(f.root, "switch", "main");
  await writeFile(join(f.root, "tracked.txt"), "main\n"); await git(f.root, "commit", "-qm", "main", "tracked.txt");
  await assert.rejects(git(f.root, "merge", "side"));
  const before = await identity(f.root), conflict = await readFile(join(f.root, "tracked.txt"));
  await assert.rejects(() => f.service.stageSelections(files, selections(files, f.names, "unstaged")), /충돌 상태인 파일/);
  assert.deepEqual(await identity(f.root), before); assert.deepEqual(await readFile(join(f.root, "tracked.txt")), conflict);
});

test("empty and repeated read scopes never expand to unrelated files or modify the index", async t => {
  const f = await fixture(t), before = await identity(f.root);
  let result: DiffFile[] = [];
  const none = await observed(async () => { result = await f.service.getFilesWorkingDiff([]); });
  assert.deepEqual(result, []); assert.deepEqual(none, []);
  const names = f.names.slice(0, 2), expected = (await f.service.getWorkingDiff()).filter(file => names.includes(file.path));
  const calls = await observed(async () => { result = await f.service.getFilesWorkingDiff([...names, names[0]]); });
  assert.deepEqual(result, expected); assert.equal(calls.length, 3);
  assert.deepEqual(await identity(f.root), before);
});

test("cancelling a scoped read closes the active batch without starting remaining chunks", async t => {
  const prefix = Array.from({ length: 4 }, (_, i) => `${i}-${"p".repeat(138)}`).join("/");
  const names = Array.from({ length: 12 }, (_, i) => `${prefix}/file-${i}-${"p".repeat(135)}.txt`);
  const f = await fixture(t, names), before = await identity(f.root), controller = new AbortController();
  const spawn = childProcess.spawn, closed: Promise<unknown>[] = [];
  let started = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const child = (spawn as Function)(...args);
    if (args[0] === "git") { started++; closed.push(new Promise(resolve => child.once("close", resolve))); }
    return child;
  });
  const release = setGitExecutionObserver(() => controller.abort());
  try {
    await assert.rejects(() => f.service.getFilesWorkingDiff(names, controller.signal), (error: unknown) =>
      error instanceof Error && (error.name === "AbortError" ||
        (error as Error & { code?: string }).code === "ABORT_ERR"));
  }
  finally { release(); await Promise.allSettled(closed); }
  assert.equal(started, 3, "only the three reads in the first chunk may start");
  assert.deepEqual(await identity(f.root), before);
});

/** 전체 diff에서는 rename 한도를 넘지만 선택 두 경로만 읽으면 rename으로 인식되는 실제 저장소다. */
async function renameLimitFixture(t: TestContext) {
  const f = await safetyFixture(t, "hunk-rename-limit");
  await git(f.root, "config", "diff.renames", "true");
  await git(f.root, "config", "diff.renameLimit", "1");
  const originals = new Map<string, string>();
  for (const folder of ["selected", "other"]) {
    await mkdir(join(f.root, folder));
    const content = Array.from({ length: 80 }, (_, i) => `${folder} line ${i} stable text\n`).join("");
    originals.set(folder, content); await writeFile(join(f.root, folder, "old.txt"), content);
  }
  for (let i = 0; i < 3; i++) await writeFile(join(f.root, `selected/regular-${i}.txt`), text(`regular-${i}`));
  await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "rename originals");
  for (const [folder, content] of originals) {
    await writeFile(join(f.root, folder, "old.txt"), content.replace("line 40 stable", "line 40 edited"));
    await rename(join(f.root, folder, "old.txt"), join(f.root, folder, "new.txt"));
  }
  for (let i = 0; i < 3; i++) await writeFile(join(f.root, `selected/regular-${i}.txt`), text(`regular-${i}`, "changed", "changed"));
  await git(f.root, "add", "-A");
  const service = new DiffHunkService(f.root), files = await service.getWorkingDiff();
  const selected = files.filter(file => file.path.startsWith("selected/"));
  assert.deepEqual(selected.map(file => file.path), ["selected/new.txt", "selected/old.txt",
    "selected/regular-0.txt", "selected/regular-1.txt", "selected/regular-2.txt"]);
  assert.equal(selected.some(file => file.header.includes("rename from")), false);
  const picked: HunkSelection[] = selected.map(file => ({
    stage: file.stage, path: file.path, binary: file.binary, hunkIds: file.hunks.map(hunk => hunk.id),
  }));
  return { ...f, service, files, picked, originals };
}

test("an unchanged A/D selection remains valid when its smaller scope detects a rename", async t => {
  const f = await renameLimitFixture(t);
  const head = await git(f.root, "rev-parse", "HEAD");
  const calls = await observed(() => f.service.unstageSelections(f.files, f.picked));
  assert.equal(await git(f.root, "rev-parse", "HEAD"), head);
  assert.deepEqual((await git(f.root, "diff", "--cached", "--no-renames", "--name-only")).split("\n"), ["other/new.txt", "other/old.txt"]);
  assert.equal(await git(f.root, "show", ":selected/old.txt"), f.originals.get("selected")!.trim());
  assert.equal(await readFile(join(f.root, "selected/new.txt"), "utf8"),
    f.originals.get("selected")!.replace("line 40 stable", "line 40 edited"));
  await assert.rejects(readFile(join(f.root, "selected/old.txt")), { code: "ENOENT" });
  assert.ok(calls.length <= 12, `${calls.length} Git calls: matching regular files must not be read again`);
});

test("rename-scope fallback still rejects an actual index change without writes", async t => {
  const f = await renameLimitFixture(t);
  await writeFile(join(f.root, "selected/new.txt"), "new index content\n");
  await git(f.root, "add", "selected/new.txt");
  const before = await identity(f.root);
  await assert.rejects(() => f.service.unstageSelections(f.files, f.picked), /변경 내용이 바뀌어/);
  assert.deepEqual(await identity(f.root), before);
  assert.equal(await readFile(join(f.root, "selected/new.txt"), "utf8"), "new index content\n");
});

test("unstaging a whole deleted file restores only its index entry and leaves the working deletion", async t => {
  const f = await safetyFixture(t, "hunk-unstage-deleted");
  await unlink(join(f.root, "tracked.txt")); await git(f.root, "add", "tracked.txt");
  const service = new DiffHunkService(f.root), files = await service.getWorkingDiff();
  await service.unstageSelections(files, files.map(file => ({
    stage: file.stage, path: file.path, binary: false, hunkIds: file.hunks.map(hunk => hunk.id),
  })));
  assert.equal(await git(f.root, "show", ":tracked.txt"), "base");
  assert.equal(await git(f.root, "diff", "--cached", "--name-only"), "");
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
  await assert.rejects(readFile(join(f.root, "tracked.txt")), { code: "ENOENT" });
});

test("whole new-file and binary unstage uses one literal reset without changing working contents", async t => {
  const f = await safetyFixture(t, "hunk-reset-batch");
  const binaries = ["[ab].bin", "chosen.bin", "a.bin", "b.bin"];
  const original = Buffer.from([0, 1, 2]), edited = Buffer.from([0, 3, 4]);
  for (const name of binaries) await writeFile(join(f.root, name), original);
  await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "binary originals");
  const added = Array.from({ length: 12 }, (_, i) => `new-${i}.txt`);
  for (const name of added) await writeFile(join(f.root, name), "one\ntwo\n");
  for (const name of binaries) await writeFile(join(f.root, name), edited);
  await git(f.root, "add", ".");
  const service = new DiffHunkService(f.root), files = await service.getWorkingDiff();
  const names = new Set([...added, ...binaries.slice(0, 2)]);
  const picked = files.filter(file => names.has(file.path)).map(file => ({
    stage: file.stage, path: file.path, binary: file.binary, hunkIds: file.hunks.map(hunk => hunk.id),
  }));
  const calls = await observed(() => service.unstageSelections(files, picked));
  assert.deepEqual((await git(f.root, "diff", "--cached", "--name-only")).split("\n"), ["a.bin", "b.bin"]);
  for (const name of added) assert.equal(await readFile(join(f.root, name), "utf8"), "one\ntwo\n");
  for (const name of binaries) assert.deepEqual(await readFile(join(f.root, name)), edited);
  for (const name of binaries.slice(0, 2)) assert.equal(await git(f.root, "rev-parse", `:${name}`), await git(f.root, "rev-parse", `HEAD:${name}`));
  assert.ok(calls.length <= 5, `${calls.length} Git executions for full-file unstage`);
});

test("line selections take precedence over hunk ids when unstaging a new file", async t => {
  const f = await safetyFixture(t, "hunk-partial-new");
  await writeFile(join(f.root, "new.txt"), "one\ntwo\n"); await git(f.root, "add", "new.txt");
  const service = new DiffHunkService(f.root), files = await service.getWorkingDiff();
  const file = files.find(file => file.path === "new.txt")!, hunk = file.hunks[0];
  await service.unstageSelections(files, [{ stage: "staged", path: "new.txt", binary: false,
    hunkIds: [hunk.id], lineIds: [`${hunk.id}:0`] }]);
  assert.equal(await git(f.root, "ls-files", "--", "new.txt"), "new.txt", "the unselected line must remain staged");
  assert.equal(await git(f.root, "show", ":new.txt"), "two");
  assert.equal(await readFile(join(f.root, "new.txt"), "utf8"), "one\ntwo\n");
});

for (const direction of ["regular-to-link", "link-to-regular"] as const) {
  test(`a ${direction} selection retains both native diff sections and stages the complete type change`,
    { skip: process.platform === "win32" }, async t => {
      const f = await safetyFixture(t, "hunk-type-change");
      await writeFile(join(f.root, "target.txt"), "link target\n");
      if (direction === "regular-to-link") await writeFile(join(f.root, "kind.txt"), "original regular file\n");
      else await symlink("target.txt", join(f.root, "kind.txt"));
      await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "type original");
      await unlink(join(f.root, "kind.txt"));
      if (direction === "regular-to-link") await symlink("target.txt", join(f.root, "kind.txt"));
      else await writeFile(join(f.root, "kind.txt"), "new regular file\n");
      await writeFile(join(f.root, "tracked.txt"), "unselected edit\n");
      const service = new DiffHunkService(f.root), files = await service.getWorkingDiff();
      const picked = files.filter(file => file.path === "kind.txt").map(file => ({
        stage: file.stage, path: file.path, binary: file.binary, hunkIds: file.hunks.map(hunk => hunk.id),
      }));
      await service.stageSelections(files, picked);
      const entry = await git(f.root, "ls-files", "-s", "--", "kind.txt");
      assert.ok(entry.startsWith(direction === "regular-to-link" ? "120000 " : "100644 "));
      assert.equal(await git(f.root, "show", ":kind.txt"), direction === "regular-to-link" ? "target.txt" : "new regular file");
      assert.equal(await git(f.root, "show", ":tracked.txt"), "base");
      assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "unselected edit\n");
    });
}

test("a partial type-change unstage is rejected before changing the index or working file",
  { skip: process.platform === "win32" }, async t => {
    const f = await safetyFixture(t, "hunk-partial-type-change");
    await symlink("tracked.txt", join(f.root, "kind.txt"));
    await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "original link");
    await unlink(join(f.root, "kind.txt"));
    await writeFile(join(f.root, "kind.txt"), "one\ntwo\n");
    await git(f.root, "add", "kind.txt");
    const service = new DiffHunkService(f.root), files = await service.getWorkingDiff();
    const before = await identity(f.root);
    await assert.rejects(() => service.unstageSelections(files, [{ stage: "staged", path: "kind.txt", binary: false,
      hunkIds: [], lineIds: ["staged:kind.txt#0:0"] }]), /whole file/);
    assert.deepEqual(await identity(f.root), before);
    assert.equal(await git(f.root, "show", ":kind.txt"), "one\ntwo");
    assert.equal(await readFile(join(f.root, "kind.txt"), "utf8"), "one\ntwo\n");
  });

for (const direction of ["regular-to-link", "link-to-regular"] as const) {
  test(`a whole ${direction} unstage restores the original index type and preserves the working change`,
    { skip: process.platform === "win32" }, async t => {
      const f = await safetyFixture(t, "hunk-whole-type-change");
      if (direction === "regular-to-link") await writeFile(join(f.root, "kind.txt"), "original\n");
      else await symlink("tracked.txt", join(f.root, "kind.txt"));
      await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "original type");
      await unlink(join(f.root, "kind.txt"));
      if (direction === "regular-to-link") await symlink("tracked.txt", join(f.root, "kind.txt"));
      else await writeFile(join(f.root, "kind.txt"), "one\ntwo\n");
      await git(f.root, "add", "kind.txt");
      const service = new DiffHunkService(f.root), files = await service.getWorkingDiff();
      const hunkIds = [...new Set(files.flatMap(file => file.hunks.map(hunk => hunk.id)))];
      await service.unstageSelections(files, [{ stage: "staged", path: "kind.txt", binary: false, hunkIds }]);
      assert.equal(await git(f.root, "diff", "--cached", "--name-only"), "");
      assert.equal(await git(f.root, "show", ":kind.txt"), direction === "regular-to-link" ? "original" : "tracked.txt");
      assert.ok((await git(f.root, "ls-files", "-s", "--", "kind.txt")).startsWith(
        direction === "regular-to-link" ? "100644 " : "120000 "));
      assert.equal(await readFile(join(f.root, "kind.txt"), "utf8"), direction === "regular-to-link" ? "base\n" : "one\ntwo\n");
    });
}
