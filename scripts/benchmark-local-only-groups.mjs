// 같은 Native fixture·독립 oracle·계측 코드를 기준 commit과 작업 트리에 연결한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";
runSourceBenchmark("test/benchmarks/localOnlyGroups.ts", ["test/helpers/localOnlyFixture.ts"])
  .catch(error => { console.error(error); process.exitCode = 1; });
