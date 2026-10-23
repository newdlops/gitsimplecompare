// 두 source의 측정을 작업별로 번갈아 실행한다. 대기 source는 polling이나 브라우저를 만들지 않는다.
import { watch } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** 소유 임시 디렉터리의 단일 실행 권한만 교환하는 benchmark 전용 수명이다. */
export class BenchmarkTurnGate {
  /**
   * @param directory coordinator가 만든 임시 경계 @param identity 파일 이름으로 사용할 검증된 source ID
   * @param timeoutMs 대기 source를 회수할 최대 시간. 측정 중인 Native 작업의 timeout은 변경하지 않는다.
   */
  private constructor(private readonly directory: string, private readonly identity: string, private readonly timeoutMs: number) {}

  /** 명시적인 coordinator 환경에서만 활성화한다. 일반 benchmark의 대기·실행 경로는 유지한다. */
  static fromEnvironment(): BenchmarkTurnGate | undefined {
    const directory = process.env.GSC_BENCH_TURN_DIRECTORY, identity = process.env.GSC_BENCH_TURN_ID;
    if (!directory && !identity) return undefined;
    if (!directory || !path.isAbsolute(directory) || !identity || !/^[a-z][a-z0-9-]{0,31}$/.test(identity)) {
      throw new Error("Invalid benchmark turn coordination environment.");
    }
    const timeoutMs = Number(process.env.GSC_BENCH_TURN_TIMEOUT_MS ?? 120000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30 * 60 * 1000) {
      throw new Error("Invalid benchmark turn timeout.");
    }
    return new BenchmarkTurnGate(directory, identity, timeoutMs);
  }

  /** 호출자가 준비한 실행 목록을 공유한다. coordinator는 두 source의 이 경계가 확인된 뒤 측정을 허용한다. */
  async ready(operations: readonly string[]): Promise<void> { await this.publish("ready", { operations }); }

  /**
   * 이 작업의 권한을 fs.watch로 기다린다. 실제 서비스 준비와 Native 실행은 허용 뒤에 시작한다.
   * @param index 동일한 작업 순서의 0부터 시작하는 번호 @param operation 양쪽 source가 공유하는 작업 이름
   */
  async wait(index: number, operation: string): Promise<void> {
    const grant = path.join(this.directory, `${this.identity}-${index}.go.json`), abort = path.join(this.directory, "abort.json");
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      /** 성공·오류·시간 초과 모두 watcher와 timer를 해제해 다음 작업으로 수명을 넘기지 않는다. */
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true; clearTimeout(timer); watcher.close(); error ? reject(error) : resolve();
      };
      /** 원자적 rename된 권한만 읽으며 중복 이벤트는 첫 완료 이후 무시한다. */
      const check = async () => {
        if (finished) return;
        try {
          const stopped = await readFile(abort, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
          if (stopped) throw new Error("Benchmark coordinator aborted the run.");
          const raw = await readFile(grant, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
          if (!raw) return;
          const message = JSON.parse(raw);
          if (message.index !== index || message.operation !== operation) throw new Error("Benchmark turn does not match its operation.");
          finish();
        } catch (error) { finish(error); }
      };
      const watcher = watch(this.directory, (_event, filename) => {
        if (!filename || filename.toString() === path.basename(grant) || filename.toString() === "abort.json") void check();
      });
      watcher.once("error", finish);
      const timer = setTimeout(() => finish(new Error("Benchmark turn grant timed out.")), this.timeoutMs);
      void check();
    });
  }

  /** Native oracle와 소유 프로세스 정리가 끝난 결과만 보내 다음 source의 측정과 겹치지 않게 한다. */
  async complete(index: number, result: unknown): Promise<void> { await this.publish(`${index}.done`, result); }

  /** 작은 제어 파일을 완성한 뒤 rename해 reader가 부분 JSON을 성공 결과로 읽지 않게 한다. */
  private async publish(key: string, value: unknown): Promise<void> {
    const file = path.join(this.directory, `${this.identity}-${key}.json`), temporary = file + ".tmp";
    await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx" }); await rename(temporary, file);
  }
}
