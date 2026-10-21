// 비교 시간/CPU와 분리한 메모리 실행에서만 외부 observer를 사용한다. 설치 확장에는 포함하지 않는다.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

interface MemorySample {
  afterStartMs: number; scanMs: number; nodeRssBytes: number; chromiumRssBytes: number;
  otherOwnedRssBytes: number; sumRssBytes: number; pids: number[];
}
export interface PhaseMemoryResult {
  complete: boolean; rootPid: number; observerPid: number; intervalMs: number; samples: MemorySample[]; errors: string[]; scope: string;
}

/** 한 작업의 첫 표본 준비와 마지막 실제 observer close까지 소유한다. */
export class PhaseMemorySampler {
  private stopped = false;
  private readonly result: Promise<PhaseMemoryResult>;
  readonly ready: Promise<void>;

  /** 준비/결과 JSON을 분리하고 잘못된 종료·부분 출력을 성공 결과로 처리하지 않는다. */
  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    let result: PhaseMemoryResult | undefined, stderr = "";
    this.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
    const lines = createInterface({ input: child.stdout });
    let failure: Error | undefined;
    child.stdin.on("error", error => { failure ??= error; rejectReady(error); });
    lines.on("line", line => {
      try {
        const value = JSON.parse(line);
        if (value.ready) {
          assert.equal(value.initialSampleComplete, true, "The first memory sample must be complete"); resolveReady();
        } else {
          assert.ok(Array.isArray(value.samples) && Array.isArray(value.errors)); result = value;
        }
      } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); rejectReady(failure); child.stdin.end("stop\n"); }
    });
    this.result = new Promise((resolve, reject) => {
      child.once("error", error => { rejectReady(error); reject(error); });
      child.once("close", code => {
        lines.close();
        if (failure || code !== 0 || !result) {
          const error = failure ?? new Error(`Memory sampler failed (${code}): ${stderr}`); rejectReady(error); reject(error);
        } else resolve(result);
      });
    });
    // start가 거부된 경우에도 close까지 회수할 수 있게 오류를 관찰한다.
    void this.result.catch(() => undefined);
  }

  /** 측정 전 첫 표본을 기다리고, 시작 실패 때도 소유 자식을 close까지 회수한다. */
  static async start(browserPids: readonly number[]): Promise<PhaseMemorySampler> {
    const script = path.join(process.env.GSC_BENCH_WORKSPACE_ROOT ?? process.cwd(), "scripts/sample-phase-memory.py");
    const child = spawn("/usr/bin/python3", [script, String(process.pid), JSON.stringify(browserPids), "0.05"], { stdio: "pipe" });
    const sampler = new PhaseMemorySampler(child);
    try { await sampler.ready; return sampler; }
    catch (error) { await sampler.stop().catch(() => undefined); throw error; }
  }

  /** 실제 작업 완료 뒤 마지막 표본과 observer의 정상 close를 기다린다. 중복 중지도 같은 결과를 받는다. */
  async stop(): Promise<PhaseMemoryResult> {
    if (!this.stopped) { this.stopped = true; if (!this.child.stdin.destroyed) this.child.stdin.end("stop\n"); }
    return this.result;
  }
}
