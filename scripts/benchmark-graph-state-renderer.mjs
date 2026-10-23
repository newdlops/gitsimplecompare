// 실제 Graph에서 상태 알림만 반복하며 기존 renderer와 작업 트리의 기하 갱신 비용을 비교한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/graphStateRenderer.ts", ["test/webview/graphReferenceHarness.ts", "test/webview/webviewHarness.ts"])
  .catch(error => { console.error(error); process.exitCode = 1; });
