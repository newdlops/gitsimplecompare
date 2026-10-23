// 같은 Native 카탈로그 동시 요청을 이전 commit과 현재 source에 동일하게 연결한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";
runSourceBenchmark("test/benchmarks/graphCommonDirectory.ts", ["test/helpers/childResourceProbe.ts", "test/helpers/phaseMemorySampler.ts", "scripts/child-resource-probe.c"])
  .catch(error => { console.error(error); process.exitCode = 1; });
