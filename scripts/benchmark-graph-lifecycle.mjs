// 같은 Node/Chromium 수명에서 실제 panel의 반복 reveal/refresh/close 자원 경계를 검증한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";
runSourceBenchmark("test/benchmarks/graphLifecycle.ts", [], ["--expose-gc"])
  .catch(error => { console.error(error); process.exitCode = 1; });
