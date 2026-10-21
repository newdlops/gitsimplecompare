// 실제 Graph 버튼과 message callback을 같은 source harness로 비교한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/graphButtonFlow.ts", ["test/helpers/benchmarkOverrides.ts", "test/helpers/graphOperationPanel.ts", "test/helpers/graphLiveRenderer.ts", "test/helpers/graphButtonDiagnostics.ts", "test/helpers/graphPhaseResources.ts", "test/helpers/childResourceProbe.ts", "scripts/child-resource-probe.c", "test/helpers/gitOperationFixture.ts", "test/helpers/promisorPushFixture.ts", "test/helpers/graphNativeExpectation.ts", "test/helpers/vscodeMock.ts", "test/helpers/prButtonFixture.ts", "test/helpers/prNoticeProbe.ts"])
  .catch(error => { console.error(error); process.exitCode = 1; });
