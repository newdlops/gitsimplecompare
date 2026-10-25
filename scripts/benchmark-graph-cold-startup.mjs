// 웹뷰 자산 로딩까지 포함하는 Graph 시작 검증을 실제 source/동일 harness로 실행한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/graphColdStartup.ts", [
  "test/helpers/benchmarkOverrides.ts", "test/helpers/gitOperationFixture.ts", "test/helpers/graphOperationPanel.ts",
  "test/helpers/graphLiveRenderer.ts", "test/helpers/graphNativeExpectation.ts", "test/helpers/graphPhaseResources.ts",
  "test/helpers/phaseMemorySampler.ts", "test/helpers/phaseMemorySummary.ts", "test/helpers/childResourceProbe.ts", "scripts/child-resource-probe.c",
]).catch(error => { console.error(error); process.exitCode = 1; });
