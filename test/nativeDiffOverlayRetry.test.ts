import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeOverlayConnectionRetry,
  NativeOverlayRenderDrain,
  waitAtMost,
} from "../src/providers/nativeDiffOverlayRetry";
import { overlayBridgeReleaseExpression } from "../src/providers/nativeDiffOverlayMain";

/** 외부에서 완료 시점을 정할 수 있는 Promise를 만든다. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** timer 기반 retry 검증에서 event loop를 짧게 진행한다. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("renderer drain은 진행 중 이벤트에서 마지막 원인만 처리한다", async () => {
  const gate = deferred();
  const seen: string[] = [];
  const errors: string[] = [];
  const drain = new NativeOverlayRenderDrain();
  drain.enqueue(
    "first",
    async (reason) => {
      seen.push(reason);
      await gate.promise;
    },
    (error) => errors.push(String(error))
  );
  drain.enqueue("middle", async (reason) => { seen.push(reason); }, () => undefined);
  drain.enqueue("latest", async (reason) => { seen.push(reason); }, () => undefined);
  gate.resolve();
  await drain.completion();

  assert.deepEqual(seen, ["first", "latest"]);
  assert.deepEqual(errors, []);
});

test("connection retry는 같은 deadline에 하나만 실행되고 clear로 취소된다", async () => {
  const retry = new NativeOverlayConnectionRetry();
  let calls = 0;
  retry.schedule(10, () => { calls++; });
  retry.schedule(0, () => { calls++; });
  await delay(30);
  assert.equal(calls, 1);

  retry.schedule(30, () => { calls++; });
  retry.clear();
  await delay(50);
  assert.equal(calls, 1);
});

test("bounded wait와 main-process cleanup expression이 종료 경로를 보장한다", async () => {
  const started = Date.now();
  await waitAtMost(new Promise<void>(() => undefined), 15);
  assert.ok(Date.now() - started < 500);

  const expression = overlayBridgeReleaseExpression({
    paths: ["/workspace"],
    names: ["workspace"],
  });
  assert.doesNotThrow(() => new Function(`return ${expression};`));
});
