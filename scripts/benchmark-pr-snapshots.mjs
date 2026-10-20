// PR snapshot 전체 기록 경로를 같은 fixture·계측으로 이전 commit과 비교한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/pullRequestSnapshots.ts")
  .catch(error => { console.error(error); process.exitCode = 1; });
