// 실제 Git 작업과 Graph 후속 게시/선택적인 headless renderer 시간을 같은 fixture에서 기록한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/gitOperationMatrix.ts", ["test/helpers/benchmarkOverrides.ts", "test/helpers/benchmarkTurnGate.ts", "test/helpers/graphOperationPanel.ts", "test/helpers/graphLiveRenderer.ts", "test/helpers/graphPhaseResources.ts", "test/helpers/phaseMemorySampler.ts", "test/helpers/phaseMemorySummary.ts", "test/helpers/childResourceProbe.ts", "scripts/child-resource-probe.c", "test/helpers/nodeCpuProfile.ts", "test/helpers/gitOperationFixture.ts", "test/helpers/graphNativeExpectation.ts"])
  .catch(error => { console.error(error); process.exitCode = 1; });
