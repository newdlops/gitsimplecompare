// 이전 source와 현재 source의 동일한 소유 자식 취소를 비교한다. 네트워크 속도 benchmark가 아니다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";
runSourceBenchmark("test/benchmarks/tagLifetime.ts")
  .catch(error => { console.error(error); process.exitCode = 1; });
