// 같은 fixture/harness를 이전 source와 현재 source에 연결해 브랜치 작업의 실제 완료 비용을 비교한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";
import path from "node:path";

// 이전 source는 임시 checkout에서 실행하므로 결과 경로를 launcher의 작업트리에 고정한다.
if (process.argv[2]) process.argv[2] = path.resolve(process.argv[2]);

runSourceBenchmark("test/benchmarks/branchSquash.ts")
  .catch(error => { console.error(error); process.exitCode = 1; });
