// watcher burst의 catalog 복사·Node CPU·heap/RSS를 이전 source와 같은 조건으로 비교한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/graphRefreshBurst.ts", [], ["--expose-gc"])
  .catch(error => { console.error(error); process.exitCode = 1; });
