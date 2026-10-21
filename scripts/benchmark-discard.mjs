// 같은 Native fixture와 계측을 이전 commit과 후보 source에 적용한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";
runSourceBenchmark("test/benchmarks/discardSelected.ts", ["test/helpers/gitOperationFixture.ts", "test/helpers/vscodeMock.ts"])
  .catch(error => { console.error(error); process.exitCode = 1; });
