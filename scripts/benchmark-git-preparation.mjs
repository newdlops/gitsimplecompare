// 실제 push 계획과 반복 status 준비 비용을 같은 계측 코드로 전후 비교한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";
runSourceBenchmark("test/benchmarks/gitPreparation.ts")
  .catch(error => { console.error(error); process.exitCode = 1; });
