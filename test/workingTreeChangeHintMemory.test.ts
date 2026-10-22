import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { forgetWorkingTreeChangeHints, recentWorkingTreeChangeHints, rememberWorkingTreeChangeHints } from "../src/git/workingTreeChangeHints";

/**
 * Native 상태 parser처럼 큰 출력의 부분 문자열을 넘긴 뒤, 그 출력 자체의 생존 여부를 별도 Node에서 확인한다.
 * @returns 명시적 GC 후 registry에 남은 heap 차이. peak/RSS나 생산 프로세스 전체 메모리로 주장하지 않는다.
 */
async function inspectRetention() {
  const collect = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  assert.ok(collect, "The isolated ownership probe requires explicit GC");
  const root = `/private/tmp/gsc-hint-string-ownership-${process.pid}`, expected = "remembered-known-file.txt";
  collect(); collect(); const before = process.memoryUsage().heapUsed;
  /** 반환된 짧은 path만 registry로 전달하고 큰 원문에 대한 다른 참조는 남기지 않는다. */
  function recordSlice() {
    const prefix = "x".repeat(32 * 1024 * 1024), output = prefix + expected + prefix;
    rememberWorkingTreeChangeHints(root, [{ xy: "??", path: output.slice(prefix.length, prefix.length + expected.length) }]);
  }
  recordSlice();
  await new Promise<void>(resolve => setImmediate(resolve));
  collect(); collect(); const retained = process.memoryUsage().heapUsed - before;
  assert.deepEqual(recentWorkingTreeChangeHints(root), [expected]);
  forgetWorkingTreeChangeHints(root); collect(); collect();
  return { retainedBytes: retained, afterReleaseBytes: process.memoryUsage().heapUsed - before, pathBytes: Buffer.byteLength(expected) };
}

if (process.env.GSC_HINT_STRING_OWNERSHIP_PROBE === "1") {
  void inspectRetention().then(result => process.stdout.write(JSON.stringify(result)), error => { throw error; });
} else {
  test("a short recent path does not retain its much larger Native status backing string", async t => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", __filename], {
      env: { ...process.env, GSC_HINT_STRING_OWNERSHIP_PROBE: "1" }, timeout: 30000, maxBuffer: 4096,
    });
    const result = JSON.parse(stdout);
    t.diagnostic(JSON.stringify(result));
    assert.ok(result.retainedBytes < 4 * 1024 * 1024, "The registry retained the original 64MiB Native status output");
  });
}
