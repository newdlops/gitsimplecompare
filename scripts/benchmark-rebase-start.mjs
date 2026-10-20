// 같은 실제 rebase 실행 계획으로 이전 commit과 작업 트리의 시작·완료 비용을 비교한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/rebaseStart.ts")
  .catch(error => { console.error(error); process.exitCode = 1; });
