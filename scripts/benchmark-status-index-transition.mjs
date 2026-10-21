// 이전 소스와 현재 소스에 동일한 public 상태 갱신 benchmark를 연결한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/statusIndexTransition.ts", ["test/helpers/gitOperationFixture.ts"], ["--expose-gc"])
  .catch(error => { console.error(error); process.exitCode = 1; });
