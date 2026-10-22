// 원래 공개 Git 준비 API를 이전 commit과 현재 source에 동일하게 연결한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/gitEnvironmentPreparation.ts")
  .catch(error=>{console.error(error);process.exitCode=1;});
