// 같은 byte transport fixture를 기준 commit과 후보 source의 공통 Git 실행기에 연결한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/gitReadPipeline.ts", [], ["--expose-gc"])
  .catch(error => { console.error(error); process.exitCode = 1; });
