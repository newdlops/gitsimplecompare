import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { refreshFileHistory, cancelFileHistoryRefresh } from "../src/commands/fileHistory";
import { beginFileHistoryReadLifetime, type FileHistoryReader } from "../src/git/fileHistoryReadCache";
import { Uri } from "./helpers/vscodeMock";
import type { FileHistoryEntry } from "../src/git/fileHistoryService";

/** 오래된 registry/log 응답의 완료를 따로 제어할 수 있는 promise다. */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
/** 소비자 연결과 abort가 처리되도록 microtask 뒤 한 번만 양보한다. */
async function settle() { await new Promise<void>(resolve => setImmediate(resolve)); }

/** 실제 명령·실제 공유 수명을 사용하고 저장소/원격 데이터만 대체한다. */
function fixture(t: TestContext) {
  cancelFileHistoryRefresh("test-start");
  const posted: any[] = [], reads: string[] = [];
  const reader: FileHistoryReader = {
    context: async () => ({ revision: "a".repeat(40), key: "current-context" }),
    history: async (_root, file) => { reads.push(file); return [{ hash: "a".repeat(40), title: file, path: file } as FileHistoryEntry]; },
    dates: async (_root, entries) => entries,
  };
  const service = { repoRoot: "/repo", toRepoRelative: (file: string) => file.slice("/repo/".length) };
  const deps: any = { registry: { resolve: async () => service }, changesView: { setFileHistory: (value: any) => posted.push(value) } };
  const stop = beginFileHistoryReadLifetime(() => true, () => undefined, undefined, reader);
  t.after(async () => { cancelFileHistoryRefresh("test-end"); await stop(); });
  return { reader, deps, service, posted, reads };
}

test("switching files cancels the former consumer and a late Git error cannot replace the current history", async t => {
  const f = fixture(t), old = deferred<FileHistoryEntry[]>(), original = f.reader.history;
  let cancelled = false;
  f.reader.history = async (...args) => {
    if (args[1] === "old.ts") { args[3].addEventListener("abort", () => { cancelled = true; }); return old.promise; }
    return original(...args);
  };
  const first = refreshFileHistory(f.deps, { uri: Uri.file("/repo/old.ts") as any, reason: "activeEditor" });
  await settle();
  await refreshFileHistory(f.deps, { uri: Uri.file("/repo/new.ts") as any, reason: "activeEditor" });
  assert.equal(cancelled, true); assert.equal(f.posted.at(-1).path, "new.ts");
  old.reject(new Error("old command failed after switching tabs")); await first; await settle();
  assert.equal(f.posted.length, 1); assert.equal(f.posted[0].commits[0].title, "new.ts");
});

test("an older repository lookup completing after a newer file does not even start its Git history", async t => {
  const f = fixture(t), old = deferred<typeof f.service>();
  let resolveCount = 0;
  f.deps.registry.resolve = async () => ++resolveCount === 1 ? old.promise : f.service;
  const first = refreshFileHistory(f.deps, { uri: Uri.file("/repo/old.ts") as any });
  await settle(); await refreshFileHistory(f.deps, { uri: Uri.file("/repo/new.ts") as any });
  old.resolve(f.service); await first;
  assert.deepEqual(f.reads, ["new.ts"]); assert.equal(f.posted.length, 1); assert.equal(f.posted[0].path, "new.ts");
});

test("refresh reasons alone do not discard unchanged histories while explicit force still reloads", async t => {
  const f = fixture(t), uri = Uri.file("/repo/file.ts") as any;
  await refreshFileHistory(f.deps, { uri, reason: "activeEditor" });
  await refreshFileHistory(f.deps, { uri, reason: "command" });
  await refreshFileHistory(f.deps, { uri, reason: "git:index" });
  assert.equal(f.reads.length, 1); assert.equal(f.posted.at(-1).source, "memory");
  await refreshFileHistory(f.deps, { uri, reason: "command", force: true });
  assert.equal(f.reads.length, 2); assert.equal(f.posted.at(-1).source, "git");
});
