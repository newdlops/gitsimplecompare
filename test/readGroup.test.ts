import assert from "node:assert/strict";
import test from "node:test";
import { allReads } from "../src/utils/readGroup";

/** 읽기가 실제로 끝나는 시점을 테스트가 제어한다. */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
/** 타이머 대기 없이 현재 Promise 정리 상태만 관찰한다. */
function settle(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }

test("parallel reads preserve tuple values and input order", async () => {
  const result = await allReads([Promise.resolve(42), Promise.resolve("metadata"), true] as const);
  assert.deepEqual(result, [42, "metadata", true]);
});

test("an aborted read group retains its slot until every owned read settles", async () => {
  const controller = new AbortController(), first = deferred<number>(), last = deferred<string>();
  const failure = Object.assign(new Error("read cancelled"), { name: "AbortError" });
  let finished = false;
  const pending = allReads([first.promise, last.promise] as const, controller.signal);
  const rejected = assert.rejects(pending, error => error === failure).then(() => { finished = true; });
  controller.abort(); first.reject(failure); await settle();
  assert.equal(finished, false); last.resolve("child closed"); await rejected; assert.equal(finished, true);
});

test("secondary cancelled read errors are observed while the original error is preserved", async () => {
  const controller = new AbortController(), first = deferred<number>(), last = deferred<string>();
  const failure = new Error("first error");
  const pending = allReads([first.promise, last.promise] as const, controller.signal);
  const rejected = assert.rejects(pending, error => error === failure);
  controller.abort(); first.reject(failure); await settle(); last.reject(new Error("late child close error")); await rejected;
});

test("ordinary failures remain immediate and later read errors cannot leak an unhandled rejection", async () => {
  const first = deferred<number>(), last = deferred<string>(), failure = new Error("read failed");
  const pending = allReads([first.promise, last.promise] as const);
  const rejected = assert.rejects(pending, error => error === failure);
  first.reject(failure); await rejected; last.reject(new Error("later error")); await settle();
});

test("cancellation arriving after IO completion still prevents a stale successful result", async () => {
  const controller = new AbortController(), pending = allReads([Promise.resolve("read completed")] as const, controller.signal);
  controller.abort(); await assert.rejects(pending, { name: "AbortError" });
});
