// 실제 저장소는 읽기만 하고 코드·보고서·빌드 산출물은 별도 디렉터리에 둔다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/readonlyTracking.ts")
  .catch(error => { console.error(error); process.exitCode = 1; });
