import assert from "node:assert/strict";
import test from "node:test";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileReadLimitError, readBoundedHandle } from "../src/utils/boundedFileRead";
import { DiffHunkService } from "../src/git/diffHunkService";
import { DeferredUntrackedSession } from "../src/git/deferredUntrackedSession";
import { GitService } from "../src/git/gitService";
import { clearStashListSnapshots, readStashListForDisplay } from "../src/git/stashListSnapshot";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { refreshStashes } from "../src/commands/stash";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 서비스의 Git 실행 수만 기록하며 계측 구간 밖의 fixture 조작은 결과에 포함하지 않는다. */
async function observed<T>(action: () => Promise<T>) {
  const commands: string[] = [], release = setGitExecutionObserver(call => commands.push(call.command));
  try { return { value: await action(), commands }; } finally { release(); }
}

/** 복사된 파일 목록을 현재 provider 상태로 보관하는 최소 명령 조립 경계다. */
function dependencies(service: GitService) {
  const state: { items: any[]; pagination?: any } = { items: [] };
  return { state, deps: { registry: { get: () => service }, changesView: { getActiveRepo: () => service.repoRoot,
    setStashes: (items?: any[], pagination?: any) => { if (items) state.items = items; state.pagination = pagination; } } } as any };
}

test("bounded reading uses nine reads for 4 MiB and preserves exact bytes", async t => {
  const { root } = await safetyFixture(t, "bounded-buffer-reuse"), file = join(root, "large.bin");
  const bytes = Buffer.alloc(4 * 1024 * 1024, 0x5a); await writeFile(file, bytes);
  const handle = await open(file, "r"), native = handle.read.bind(handle); let reads = 0;
  t.mock.method(handle, "read", (async (...args: any[]) => { reads++; return (native as any)(...args); }) as any);
  try {
    assert.deepEqual(await readBoundedHandle(handle, bytes.length, undefined, bytes.length), bytes);
    assert.equal(reads, 9, "eight 512 KiB chunks and one EOF/overflow probe");
  } finally { await handle.close(); }
});

test("small hints, zero limits and short reads never bypass the actual byte limit", async t => {
  const { root } = await safetyFixture(t, "bounded-hint-growth"), file = join(root, "text.txt");
  await writeFile(file, "한글🙂\n"); const bytes = await readFile(file);
  for (const limit of [0, 1, bytes.length - 1, bytes.length]) {
    const handle = await open(file, "r"), native = handle.read.bind(handle);
    t.mock.method(handle, "read", (async (buffer: Buffer, offset: number, length: number, position: number | null) =>
      (native as any)(buffer, offset, Math.min(length, 3), position)) as any);
    try {
      if (limit < bytes.length) await assert.rejects(readBoundedHandle(handle, limit, undefined, 0), FileReadLimitError);
      else assert.deepEqual(await readBoundedHandle(handle, limit, undefined, 0), bytes);
    } finally { await handle.close(); }
  }
});

test("deferred body reads use one classification while ordinary file reads remain authoritative", async t => {
  const { root } = await safetyFixture(t, "deferred-body-fast");
  await writeFile(join(root, "new.txt"), "first\n"); const service = new DiffHunkService(root);
  await service.getWorkingDiff({ syntheticByteBudget: 0 });
  const first = await observed(() => service.getDeferredFileWorkingDiff("new.txt"));
  assert.deepEqual(first.commands, ["ls-files"]); assert.match(first.value[0].hunks[0].text, /\+first/);
  await writeFile(join(root, "new.txt"), "second\n");
  const second = await observed(() => service.getDeferredFileWorkingDiff("new.txt"));
  assert.deepEqual(second.commands, ["ls-files"]); assert.match(second.value[0].hunks[0].text, /\+second/);
  const fresh = await observed(() => service.getFileWorkingDiff("new.txt"));
  assert.deepEqual(fresh.value, second.value); assert.equal(fresh.commands.length, 3);
});

test("a changed index invalidates deferred classification and stale selections still reject", async t => {
  const { root } = await safetyFixture(t, "deferred-index-change");
  await writeFile(join(root, "new.txt"), "selected\n"); const service = new DiffHunkService(root);
  await service.getWorkingDiff({ syntheticByteBudget: 0 });
  const selected = await service.getDeferredFileWorkingDiff("new.txt");
  await git(root, "add", "new.txt");
  const current = await observed(() => service.getDeferredFileWorkingDiff("new.txt"));
  assert.equal(current.commands.length, 3); assert.ok(current.value.every(file => file.stage === "staged"));
  const before = await git(root, "write-tree");
  await assert.rejects(service.stageSelections(selected, [{ stage: "unstaged", path: "new.txt", binary: false,
    hunkIds: selected[0].hunks.map(hunk => hunk.id) }]), /변경 내용이 바뀌어/);
  assert.equal(await git(root, "write-tree"), before);
});

test("an ignore change cannot make a display-only untracked snapshot pass a mutation guard", async t => {
  const { root } = await safetyFixture(t, "deferred-ignore-guard");
  await writeFile(join(root, "new.txt"), "selected\n"); const service = new DiffHunkService(root);
  await service.getWorkingDiff({ syntheticByteBudget: 0 });
  const files = await service.getDeferredFileWorkingDiff("new.txt");
  await writeFile(join(root, ".gitignore"), "new.txt\n");
  await assert.rejects(service.stageSelections(files, [{ stage: "unstaged", path: "new.txt", binary: false,
    hunkIds: files[0].hunks.map(hunk => hunk.id) }]), /변경 내용이 바뀌어/);
  assert.equal(await git(root, "diff", "--cached", "--name-only"), "");
});

test("an index change during a deferred body read discards that body and requests fresh classification", async t => {
  const { root } = await safetyFixture(t, "deferred-mid-read-change");
  await writeFile(join(root, "new.txt"), "new\n");
  const files = await new DiffHunkService(root).getWorkingDiff({ syntheticByteBudget: 0 });
  const session = new DeferredUntrackedSession(root), ticket = await session.start();
  await session.remember(ticket, files);
  let fresh = 0;
  const result = await session.read("new.txt", undefined, async () => {
    await git(root, "add", "new.txt"); return files;
  }, async () => { fresh++; return []; });
  assert.deepEqual(result, []); assert.equal(fresh, 1);
});

test("deferred requests for unknown paths and custom indexes fall back to native Git", async t => {
  const { root } = await safetyFixture(t, "deferred-custom-index");
  await writeFile(join(root, "new.txt"), "new\n"); const service = new DiffHunkService(root);
  await service.getWorkingDiff({ syntheticByteBudget: 0 });
  const unknown = await observed(() => service.getDeferredFileWorkingDiff("missing.txt"));
  assert.deepEqual(unknown.value, []); assert.equal(unknown.commands.length, 3);
  const previous = process.env.GIT_INDEX_FILE; process.env.GIT_INDEX_FILE = join(root, ".git", "custom-index");
  try {
    await service.getWorkingDiff({ syntheticByteBudget: 0 });
    const current = await observed(() => service.getDeferredFileWorkingDiff("new.txt"));
    assert.equal(current.commands.length, 3); assert.ok(current.value.some(file => file.path === "new.txt"));
  } finally { if (previous === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = previous; }
});

test("five hundred stash rows use a bounded initial read and one reusable full metadata read", async t => {
  const { root } = await safetyFixture(t, "stash-list-snapshot"); clearStashListSnapshots(); t.after(clearStashListSnapshots);
  await writeFile(join(root, "tracked.txt"), "saved\n"); await git(root, "stash", "push", "-qm", "saved");
  const log = join(root, ".git", "logs", "refs", "stash"), line = await readFile(log, "utf8");
  await writeFile(log, Array.from({ length: 500 }, (_, i) => line.replace(/\t[^\n]*\n?$/, `\tOn main: saved ${i}\n`)).join(""));
  const service = new GitService(root), { state, deps } = dependencies(service);
  const limits: number[] = [], native = service.listStashes.bind(service);
  t.mock.method(service, "listStashes", async limit => { limits.push(limit!); return native(limit); });
  const result = await observed(async () => {
    await refreshStashes(deps); assert.equal(state.items.length, 50); assert.equal(state.pagination.hasMore, true);
    while (state.pagination.hasMore) await refreshStashes(deps, true, root);
  });
  assert.equal(state.items.length, 500);
  assert.deepEqual(result.commands, ["show-ref", "reflog", "show-ref", "reflog"]);
  assert.deepEqual(limits, [51, 10000]);
  const explicit = await observed(() => refreshStashes(deps)); assert.deepEqual(explicit.commands, ["show-ref", "reflog"]);
});

test("external stash changes invalidate display metadata and removed selections never use its cache", async t => {
  const { root } = await safetyFixture(t, "stash-list-invalidation"); clearStashListSnapshots(); t.after(clearStashListSnapshots);
  await writeFile(join(root, "tracked.txt"), "old\n"); await git(root, "stash", "push", "-qm", "old");
  const service = new GitService(root), { state, deps } = dependencies(service);
  await refreshStashes(deps); const old = state.items[0];
  await writeFile(join(root, "tracked.txt"), "new\n"); await git(root, "stash", "push", "-qm", "new");
  const changed = await observed(() => refreshStashes(deps, true, root));
  assert.deepEqual(changed.commands, ["show-ref", "reflog"]); assert.notEqual(state.items[0].hash, old.hash);
  assert.equal(state.items[1].hash, old.hash);
  await git(root, "stash", "drop", "-q", "stash@{1}");
  await assert.rejects(service.resolveStash({ ref: old.ref, hash: old.hash }));
});

test("stash snapshots return copies and uncertain metadata never becomes a reusable cache", async t => {
  const { root } = await safetyFixture(t, "stash-snapshot-copy"); clearStashListSnapshots(); t.after(clearStashListSnapshots);
  await writeFile(join(root, "tracked.txt"), "saved\n"); await git(root, "stash", "push", "-qm", "saved");
  const service = new GitService(root); let reads = 0;
  const load = async () => { reads++; return service.listStashes(); };
  const first = await readStashListForDisplay(root, load); first[0].message = "caller mutation";
  const again = await readStashListForDisplay(root, load);
  assert.notEqual(again[0].message, "caller mutation"); assert.equal(reads, 1);
  await readStashListForDisplay("/unsupported/repository", load);
  await readStashListForDisplay("/unsupported/repository", load);
  assert.equal(reads, 3);
});
