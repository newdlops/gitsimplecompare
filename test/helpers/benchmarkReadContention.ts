// 소유 benchmark Node의 Git 읽기 시작만 늦춘다. 머신 전체 CPU/I/O에 별도 부하를 만들지 않는다.
import assert from "node:assert/strict";
import { gitCommandPolicy } from "../../src/git/gitCommandPolicy";
import { setGitProcessPreparation } from "../../src/git/gitProcessRunner";

interface WaitingRead { resolve: () => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }

/**
 * opt-in에서만 제한된 read-start 대기를 주입한다. Native Git과 argv·환경·결과는 그대로다.
 * @returns 실제 주입 조건/관측 수와 명시적 종료 함수. 미설정이면 undefined
 */
export function installBenchmarkReadContention() {
  const delayMs = Number(process.env.GSC_BENCH_READ_START_DELAY_MS || 0);
  if (!delayMs) return undefined;
  const slots = Number(process.env.GSC_BENCH_READ_START_SLOTS || 3);
  assert.ok(Number.isFinite(delayMs) && delayMs > 0 && delayMs <= 5000);
  assert.ok(Number.isSafeInteger(slots) && slots > 0 && slots <= 32);
  assert.notEqual(process.env.GSC_BENCH_MONITOR_POLICY, "1", "Do not replace an active monitor preparation policy");
  const queue: WaitingRead[] = [], active = new Set<WaitingRead>();
  let disposed = false, readStarts = 0, maxQueued = 0;
  /** 읽기 시작 예산을 FIFO로 전달하고 준비 slot은 delay 종료 즉시 반환한다. */
  function drain(): void {
    while (!disposed && active.size < slots && queue.length) {
      const item = queue.shift()!; active.add(item); readStarts++;
      item.timer = setTimeout(() => { active.delete(item); item.resolve(); drain(); }, delayMs);
    }
  }
  const restore = setGitProcessPreparation(async (args, _cwd, options) => {
    if (gitCommandPolicy(args).readOnly && !options.signal?.aborted) await new Promise<void>((resolve, reject) => {
      if (disposed) { reject(new Error("Benchmark read-start gate closed")); return; }
      queue.push({ resolve, reject }); maxQueued = Math.max(maxQueued, queue.length); drain();
    });
    return { options };
  });
  return {
    /** 인위적인 조건을 Native/실환경 성능과 구분해 보고서에 명시한다. */
    stats: () => ({ delayMs, slots, readStarts, maxQueued, pending: queue.length + active.size,
      scope: "Simulated read-start waiting in the owned benchmark Node; slots are preparation slots, not an OS/CPU or live-process limit. No machine-wide load was generated." }),
    /** 실패 때도 모든 timer와 기다리는 Promise를 회수하고 원래 실행 경계를 해제한다. */
    dispose: () => {
      disposed = true; restore();
      for (const item of [...queue, ...active]) { clearTimeout(item.timer); item.reject(new Error("Benchmark read-start gate closed")); }
      queue.length = 0; active.clear();
    },
  };
}
