// 실제 Graph renderer의 큰 전체 갱신을 기존 source와 교차 비교한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/graphInitialRenderer.ts", ["test/webview/webviewHarness.ts"])
  .catch(error => { console.error(error); process.exitCode = 1; });
