import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitProcessRegistry } from "../src/git/gitProcessRegistry";

/** 실제 PID나 신호를 사용하지 않고 close가 확인될 자식의 최소 수명만 제공한다. */
function completedChild(): ChildProcess {
  return Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null, kill: () => false }) as unknown as ChildProcess;
}

/** 임시 worktree가 반복 생성·종료되는 상황을 Git 프로세스나 실제 디렉터리 없이 재현한다. */
async function finishRoots(registry: GitProcessRegistry, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    const id = registry.register(completedChild(), join(tmpdir(), `gsc-completed-activity-${index}`), "status", true, false);
    await registry.closed(id);
  }
}

test("completed temporary worktrees retain only the latest 512 activity roots", async () => {
  const registry = new GitProcessRegistry();
  await finishRoots(registry, 2000);
  assert.equal(registry.roots().length, 512);
  assert.equal(registry.lastUsed(join(tmpdir(), "gsc-completed-activity-0")), undefined);
  assert.equal(typeof registry.lastUsed(join(tmpdir(), "gsc-completed-activity-1999")), "number");
  assert.equal(registry.isBusy(tmpdir()), false);
});

test("activity eviction preserves a live write without cancelling it", async () => {
  const registry = new GitProcessRegistry(), root = join(tmpdir(), "gsc-protected-activity");
  let killed = false;
  const child = Object.assign(completedChild(), { kill: () => { killed = true; return true; } });
  const id = registry.register(child, root, "rebase", false, false);
  const started = registry.lastUsed(root);
  await finishRoots(registry, 2000);
  assert.equal(registry.lastUsed(root), started);
  assert.equal(registry.isBusy(root), true);
  assert.ok(registry.roots().includes(root));
  assert.ok(registry.roots().length <= 513);
  await registry.requestStop(id, "test-preserve-write");
  assert.equal(killed, false);
  await registry.closed(id);
  assert.equal(registry.isBusy(root), false);
  assert.equal(registry.roots().length, 512);
});

test("an owned monitor keeps its alias and canonical last-use evidence while temporary roots are evicted", async t => {
  const parent = await mkdtemp(join(tmpdir(), "gsc-monitor-activity-")), directory = join(parent, "repo"), alias = join(parent, "alias");
  await mkdir(directory); await symlink(directory, alias, "dir");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const canonical = await realpath(directory), registry = new GitProcessRegistry();
  let now = 1000; t.mock.method(Date, "now", () => ++now);
  const monitor = registry.register(completedChild(), alias, "fsmonitor--daemon", false, false, true);
  t.after(() => registry.closed(monitor));
  const initial = registry.lastUsed(canonical)!;
  const read = registry.register(completedChild(), canonical, "status", true, false);
  await registry.closed(read);
  const lastUse = registry.lastUsed(canonical)!;
  assert.ok(lastUse > initial);
  await finishRoots(registry, 2000);
  assert.equal(registry.lastUsed(alias), lastUse);
  assert.equal(registry.lastUsed(canonical), lastUse);
  assert.ok(registry.roots().includes(alias));
  assert.ok(registry.roots().includes(canonical));
  assert.ok(registry.roots().length <= 514);
});
