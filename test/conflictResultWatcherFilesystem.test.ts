import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { watchConflictResultFile } from "../src/providers/conflictResultWatcher";

/**
 * 실제 fs.watch로 Unicode·특수문자 경로와 atomic save 후 재생성을 검증한다.
 * - 운영체제별 이벤트 수나 change/rename 순서는 가정하지 않고 최신 파일 내용의 알림을 기다린다.
 * - native handle 수만 고정 검증해 시스템 부하에 따른 경과 시간 차이는 성능 실패로 취급하지 않는다.
 */
test("shared native watchers detect writes, atomic replacement and recreation on the real filesystem", { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "gsc-result-watch-"));
  const subscriptions: Array<{ dispose(): void }> = [];
  t.after(async () => {
    subscriptions.forEach(subscription => subscription.dispose());
    await rm(directory, { recursive: true, force: true });
  });
  const literal = process.platform === "win32" ? "literal[1].txt" : "literal[?]*\n.txt";
  const names = [literal, "한글 café.txt", "sibling.txt"];
  for (const name of names) await writeFile(join(directory, name), "initial\n");
  const native = fs.watch;
  let handles = 0;
  let closes = 0;
  t.mock.method(fs, "watch", ((...args: Parameters<typeof fs.watch>) => {
    handles++;
    const watcher = Reflect.apply(native, fs, args) as fs.FSWatcher;
    const close = watcher.close.bind(watcher);
    t.mock.method(watcher, "close", () => { closes++; close(); });
    return watcher;
  }) as typeof fs.watch);
  const waiting = new Map<string, { content: string; done(): void }>();
  const notifications: string[] = [];
  for (const name of names) {
    subscriptions.push(watchConflictResultFile(join(directory, name), async () => {
      notifications.push(name);
      const waiter = waiting.get(name);
      if (!waiter) return;
      try {
        if (await readFile(join(directory, name), "utf8") === waiter.content) waiter.done();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }, { debounceMs: 10 }));
  }
  assert.equal(handles, 1);

  /** 이벤트를 기다리기 전에 기대 내용을 등록해 매우 빠른 OS 알림도 놓치지 않는다. */
  async function expectChange(name: string, content: string, action: () => Promise<void>): Promise<void> {
    let done!: () => void;
    let fail!: (error: Error) => void;
    const changed = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
    waiting.set(name, { content, done });
    const timeout = setTimeout(() => fail(new Error(`No change notification for ${JSON.stringify(name)}`)), 5_000);
    try { await action(); await changed; }
    finally { clearTimeout(timeout); waiting.delete(name); }
  }

  for (const name of names) {
    await expectChange(name, "edited\n", () => writeFile(join(directory, name), "edited\n"));
  }
  await expectChange(literal, "atomic replacement\n", async () => {
    const temporary = join(directory, "atomic-save.tmp");
    await writeFile(temporary, "atomic replacement\n");
    await rename(temporary, join(directory, literal));
  });
  await expectChange(literal, "recreated\n", async () => {
    await rm(join(directory, literal));
    await writeFile(join(directory, literal), "recreated\n");
  });
  subscriptions[0].dispose();
  assert.equal(closes, 0, "Other files in this directory still need the shared native watcher");
  await expectChange("sibling.txt", "still watched\n", () => writeFile(join(directory, "sibling.txt"), "still watched\n"));
  for (const subscription of subscriptions) subscription.dispose();
  assert.equal(closes, 1);
  assert.ok(names.every(name => notifications.includes(name)));
  t.diagnostic(JSON.stringify({ files: names.length, handles, closes, notifications: notifications.length }));
});
