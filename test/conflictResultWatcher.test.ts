import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
  watchConflictResultFile,
  type ConflictResultWatchCallback,
  type ConflictResultWatchReason,
  type ConflictResultWatcherOptions,
} from "../src/providers/conflictResultWatcher";
import { __outputLines } from "./helpers/vscodeMock";

/** 이벤트 전달·close 순서를 테스트가 직접 제어하는 Node 감시기 대역이다. */
class NativeWatcher extends EventEmitter {
  closed = false;
  closes = 0;
  emitClose = true;

  /** close 횟수를 기록하고 운영체제의 뒤늦은 close 이벤트도 별도로 재현한다. */
  close(): void {
    this.closes++;
    this.closed = true;
    if (this.emitClose) this.emit("close");
  }
}

/**
 * 실제 파일별 watcher API에 감시기 대역과 가상 시간을 연결한다.
 * @param t native 감시기·timer·구독을 테스트 종료 때 정리할 컨텍스트
 * @returns 폴더 이벤트를 전달하고 native callback 수를 관찰하는 도구
 */
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const native: Array<{
    parent: string;
    watcher: NativeWatcher;
    callback: (reason: ConflictResultWatchReason, filename: string | Buffer | null) => void;
  }> = [];
  const subscriptions: Array<{ dispose(): void }> = [];
  let deliveries = 0;
  let failNextStart = false;
  t.mock.method(fs, "watch", ((parent, _options, callback) => {
    if (failNextStart) {
      failNextStart = false;
      throw new Error("watch unavailable");
    }
    const watcher = new NativeWatcher();
    native.push({ parent: String(parent), watcher, callback });
    return watcher as unknown as fs.FSWatcher;
  }) as typeof fs.watch);
  t.after(() => subscriptions.forEach(subscription => subscription.dispose()));
  return {
    native,
    get deliveries() { return deliveries; },
    failStart() { failNextStart = true; },
    /** 부모 폴더의 OS 이벤트를 같은 폴더의 native 감시기 전체에 전달한다. */
    event(parent: string, filename: string | Buffer | null, reason: ConflictResultWatchReason = "change") {
      for (const record of native) {
        if (!record.watcher.closed && record.parent === parent) {
          deliveries++;
          record.callback(reason, filename);
        }
      }
    },
    /** 지정 파일의 실제 API 구독을 만들고 누락된 dispose도 테스트 종료 시 보완한다. */
    watch(file: string, callback: ConflictResultWatchCallback, options?: ConflictResultWatcherOptions) {
      const subscription = watchConflictResultFile(file, callback, options);
      subscriptions.push(subscription);
      return subscription;
    },
  };
}

test("one directory watcher routes a hundred file changes without native callback fan-out", t => {
  const f = fixture(t);
  const parent = path.resolve("/repo/result-watchers");
  const changes: string[] = [];
  const files = Array.from({ length: 100 }, (_, index) => `result-${index}.txt`);
  for (const file of files) f.watch(path.join(parent, file), () => { changes.push(file); });
  for (const file of files) f.event(parent, Buffer.from(file));
  t.mock.timers.tick(80);
  assert.deepEqual(changes, files);
  t.diagnostic(JSON.stringify({ files: files.length, nativeWatchers: f.native.length, nativeCallbacks: f.deliveries }));
  assert.equal(f.native.length, 1);
  assert.equal(f.deliveries, 100);
});

test("different parents and exact literal basenames stay isolated", t => {
  const f = fixture(t);
  const first = path.resolve("/repo/result-watchers/a");
  const second = path.resolve("/repo/result-watchers/b");
  const literal = "한글[?]*\n.txt";
  const changes: string[] = [];
  f.watch(path.join(first, literal), () => { changes.push("first"); });
  f.watch(path.join(first, "other.txt"), () => { changes.push("other"); });
  f.watch(path.join(second, literal), () => { changes.push("second"); });
  f.event(first, "한글x.txt");
  f.event(first, Buffer.from(literal));
  f.event(second, literal);
  t.mock.timers.tick(80);
  assert.deepEqual(changes, ["first", "second"]);
  assert.equal(f.native.length, 2);
});

test("raw invalid UTF-8 and case differences cannot match another filename", t => {
  const f = fixture(t);
  const parent = path.resolve("/repo/result-watchers");
  const changes: string[] = [];
  f.watch(path.join(parent, "�.txt"), () => { changes.push("replacement"); });
  f.watch(path.join(parent, "Case.txt"), () => { changes.push("case"); });
  f.event(parent, Buffer.concat([Buffer.from([0xff]), Buffer.from(".txt")]));
  f.event(parent, "case.txt");
  t.mock.timers.tick(80);
  assert.deepEqual(changes, []);
  f.event(parent, Buffer.from("�.txt"));
  f.event(parent, "Case.txt");
  t.mock.timers.tick(80);
  assert.deepEqual(changes, ["replacement", "case"]);
});

test("consumers of the same file keep their own debounce and independent disposal", t => {
  const f = fixture(t);
  const parent = path.resolve("/repo/result-watchers");
  const calls: string[] = [];
  const fast = f.watch(path.join(parent, "shared.txt"), reason => { calls.push(`fast:${reason}`); }, { debounceMs: 10 });
  const slow = f.watch(path.join(parent, "shared.txt"), reason => { calls.push(`slow:${reason}`); }, { debounceMs: 80 });
  f.event(parent, "shared.txt", "change");
  t.mock.timers.tick(10);
  assert.deepEqual(calls, ["fast:change"]);
  fast.dispose();
  fast.dispose();
  assert.equal(f.native[0].watcher.closes, 0);
  f.event(parent, "shared.txt", "rename");
  t.mock.timers.tick(79);
  assert.deepEqual(calls, ["fast:change"]);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, ["fast:change", "slow:rename"]);
  slow.dispose();
  slow.dispose();
  assert.equal(f.native[0].watcher.closes, 1);
});

test("atomic-save bursts coalesce per file while other files retain their deadline", t => {
  const f = fixture(t);
  const parent = path.resolve("/repo/result-watchers");
  const calls: string[] = [];
  f.watch(path.join(parent, "atomic.txt"), reason => { calls.push(`atomic:${reason}`); });
  f.watch(path.join(parent, "other.txt"), reason => { calls.push(`other:${reason}`); });
  f.event(parent, "atomic.txt", "rename");
  f.event(parent, "other.txt", "change");
  t.mock.timers.tick(60);
  f.event(parent, "atomic.txt", "change");
  t.mock.timers.tick(20);
  assert.deepEqual(calls, ["other:change"]);
  t.mock.timers.tick(60);
  assert.deepEqual(calls, ["other:change", "atomic:change"]);
  f.event(parent, "atomic.txt", "rename");
  t.mock.timers.tick(80);
  assert.deepEqual(calls, ["other:change", "atomic:change", "atomic:rename"]);
});

test("closing the last tab cancels its pending refresh and permits a fresh watcher", t => {
  const f = fixture(t);
  const parent = path.resolve("/repo/result-watchers");
  let calls = 0;
  const old = f.watch(path.join(parent, "result.txt"), () => { calls++; });
  const oldWatcher = f.native[0].watcher;
  oldWatcher.emitClose = false;
  f.event(parent, "result.txt");
  old.dispose();
  f.watch(path.join(parent, "result.txt"), () => { calls++; });
  oldWatcher.emit("close");
  oldWatcher.emit("error", new Error("late error"));
  f.watch(path.join(parent, "other.txt"), () => { calls += 10; });
  t.mock.timers.tick(80);
  assert.equal(calls, 0);
  assert.equal(f.native.length, 2, "An old close cannot remove the replacement directory entry");
  f.event(parent, "result.txt");
  f.event(parent, "other.txt");
  t.mock.timers.tick(80);
  assert.equal(calls, 11);
});

test("native errors cancel all queued callbacks without disturbing replacement consumers", t => {
  const f = fixture(t);
  const parent = path.resolve("/repo/result-watchers");
  const calls: string[] = [];
  const first = f.watch(path.join(parent, "first.txt"), () => { calls.push("old first"); });
  const second = f.watch(path.join(parent, "second.txt"), () => { calls.push("old second"); });
  f.event(parent, "first.txt");
  f.event(parent, "second.txt");
  const oldWatcher = f.native[0].watcher;
  oldWatcher.emitClose = false;
  oldWatcher.emit("error", new Error("watch stopped"));
  assert.equal(oldWatcher.closes, 1);
  const replacement = f.watch(path.join(parent, "first.txt"), () => { calls.push("new first"); });
  first.dispose();
  second.dispose();
  oldWatcher.emit("close");
  t.mock.timers.tick(80);
  assert.deepEqual(calls, []);
  f.event(parent, "first.txt");
  t.mock.timers.tick(80);
  assert.deepEqual(calls, ["new first"]);
  replacement.dispose();
  assert.equal(f.native[1].watcher.closes, 1);
});

test("unexpected native close drops queued work and does not poison subsequent opens", t => {
  const f = fixture(t);
  const parent = path.resolve("/repo/result-watchers");
  let calls = 0;
  const old = f.watch(path.join(parent, "result.txt"), () => { calls++; });
  f.event(parent, "result.txt");
  f.native[0].watcher.closed = true;
  f.native[0].watcher.emit("close");
  f.watch(path.join(parent, "result.txt"), () => { calls++; });
  old.dispose();
  t.mock.timers.tick(80);
  assert.equal(calls, 0);
  f.event(parent, "result.txt");
  t.mock.timers.tick(80);
  assert.equal(calls, 1);
  assert.equal(f.native.length, 2);
});

test("missing filenames produce one directory warning and no guessed file refresh", t => {
  const f = fixture(t);
  const parent = path.resolve("/repo/result-watchers");
  let calls = 0;
  for (let index = 0; index < 20; index++) {
    f.watch(path.join(parent, `result-${index}.txt`), () => { calls++; });
  }
  const before = __outputLines.length;
  f.event(parent, null);
  t.mock.timers.tick(80);
  assert.equal(calls, 0);
  assert.equal(__outputLines.slice(before).filter(line => line.includes("filenameUnavailable")).length, 1);
});

test("callback failures and disposal inside a callback are isolated from siblings", async t => {
  const f = fixture(t);
  const parent = path.resolve("/repo/result-watchers");
  let calls = 0;
  f.watch(path.join(parent, "shared.txt"), () => { throw new Error("sync failure"); });
  f.watch(path.join(parent, "shared.txt"), async () => { throw new Error("async failure"); });
  f.watch(path.join(parent, "shared.txt"), () => { calls++; disposed.dispose(); });
  const disposed = f.watch(path.join(parent, "shared.txt"), () => { calls += 100; });
  const before = __outputLines.length;
  f.event(parent, "shared.txt");
  t.mock.timers.tick(80);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(__outputLines.slice(before).filter(line => line.includes("watcher callback failed")).length, 2);
  assert.equal(f.native[0].watcher.closes, 0);
});

test("a failed start does not retain a registry entry or affect the next subscription", t => {
  const f = fixture(t);
  const parent = path.resolve("/repo/result-watchers");
  let calls = 0;
  f.failStart();
  const failed = f.watch(path.join(parent, "result.txt"), () => { calls += 100; });
  f.watch(path.join(parent, "result.txt"), () => { calls++; });
  failed.dispose();
  f.event(parent, "result.txt");
  t.mock.timers.tick(80);
  assert.equal(calls, 1);
  assert.equal(f.native.length, 1);
  assert.equal(f.native[0].watcher.closes, 0);
});
