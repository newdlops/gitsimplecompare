// 같은 Native index와 계측을 이전 commit/현재 source에 각각 연결한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";
runSourceBenchmark("test/benchmarks/undoIndexState.ts", ["test/helpers/largeIndexFixture.ts"], ["--expose-gc"])
  .catch(error => { console.error(error); process.exitCode = 1; });
