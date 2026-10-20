// 실제 registry의 장시간 세션 조회·보관 비용만 분리하고 Git/OS 프로세스는 생성하지 않는다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";
runSourceBenchmark("test/benchmarks/gitActivity.ts", [], ["--expose-gc"])
  .catch(error => { console.error(error); process.exitCode = 1; });
