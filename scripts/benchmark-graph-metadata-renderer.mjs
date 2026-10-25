// 같은 큰 Graph에 HEAD/참조 상태 변경을 보내 이전 SVG renderer와 현재 source를 비교한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/graphMetadataRenderer.ts", ["test/webview/graphReferenceHarness.ts", "test/webview/webviewHarness.ts"])
  .catch(error => { console.error(error); process.exitCode = 1; });
