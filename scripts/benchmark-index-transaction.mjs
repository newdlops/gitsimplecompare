// 같은 Native index fixture와 관측 조건을 전후 source에 연결한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/indexTransaction.ts", [], ["--expose-gc"])
  .catch(error => { console.error(error); process.exitCode = 1; });
