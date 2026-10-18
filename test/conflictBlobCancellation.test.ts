import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import { ConflictBlobReader } from "../src/git/conflictBlobReader";

/**
 * SIGTERM 뒤 정리가 늦은 소유 자식 프로세스로 취소 완료와 실제 close 순서를 검증한다.
 * - 실제 사용자 Git 대신 이 테스트가 만든 Node 프로세스만 실행·종료한다.
 */
test("the final blob batch consumer waits for its owned process to close before yielding its read slot", {
  skip: process.platform === "win32", timeout: 10_000,
}, async t => {
  const spawn = childProcess.spawn;
  let child: childProcess.ChildProcess | undefined;
  let closed = false;
  let started!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const stopped = new Promise<void>(resolve => { finish = resolve; });
  const script = 'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100)); setInterval(() => {}, 1000); process.stderr.write("fixture-ready\\n");';
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    assert.equal(args[0], "git");
    assert.equal(args[1][0], "cat-file");
    child = spawn(process.execPath, ["-e", script], args[2]);
    child.stderr!.once("data", started);
    child.once("close", () => { closed = true; finish(); });
    return child;
  });
  t.after(async () => { if (!closed) child?.kill("SIGTERM"); await stopped; });
  const controller = new AbortController();
  const reading = new ConflictBlobReader().readMany(tmpdir(), ["a".repeat(40), "b".repeat(40), "c".repeat(40)], controller.signal);
  await ready;
  const rejected = assert.rejects(reading, { name: "AbortError" });
  controller.abort();
  await rejected;
  t.diagnostic(`Owned process closed when cancellation completed: ${closed}`);
  assert.equal(closed, true);
});
