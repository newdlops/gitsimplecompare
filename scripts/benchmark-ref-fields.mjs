// 같은 소유 fixture에서 ref 출력 필드의 비용을 분리한다. 출력 필드를 빼는 제품 변경은 하지 않는다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/refFields.ts", ["test/helpers/gitOperationFixture.ts"])
  .catch(error => { console.error(error); process.exitCode = 1; });
