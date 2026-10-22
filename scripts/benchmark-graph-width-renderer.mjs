// 5천 행의 실제 Graph renderer에서 행 너비 모듈만 바꿔 비교한다. Native 작업 시간은 측정하지 않는다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/graphWidthRenderer.ts", ["test/webview/graphReferenceHarness.ts", "test/webview/webviewHarness.ts"])
  .catch(error => { console.error(error); process.exitCode = 1; });
