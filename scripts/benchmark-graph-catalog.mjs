// 이전 source와 현재 source의 실제 브랜치 메뉴를 같은 headless fixture로 비교한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";
runSourceBenchmark("test/benchmarks/graphCatalog.ts", ["test/webview/webviewHarness.ts"])
  .catch(error => { console.error(error); process.exitCode = 1; });
