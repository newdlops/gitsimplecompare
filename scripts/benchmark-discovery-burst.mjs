// 공통 fixture와 계측을 baseline/current Native 저장소 탐색에 연결한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/repositoryDiscoveryBurst.ts", ["test/helpers/benchmarkOverrides.ts", "test/helpers/childResourceProbe.ts",
  "scripts/child-resource-probe.c", "test/helpers/phaseMemorySampler.ts", "test/helpers/phaseMemorySummary.ts"])
  .catch(error => { console.error(error); process.exitCode = 1; });
