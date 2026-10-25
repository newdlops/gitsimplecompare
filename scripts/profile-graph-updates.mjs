// 비교 측정과 분리한 소유 Chromium에서 누적 Graph의 CPU/레이아웃 원인을 수집한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";
runSourceBenchmark("test/benchmarks/graphUpdateProfile.ts", ["test/webview/graphReferenceHarness.ts", "test/webview/webviewHarness.ts"])
  .catch(error => { console.error(error); process.exitCode = 1; });
