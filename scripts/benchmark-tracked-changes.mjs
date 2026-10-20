// PR 변경 유무 조회를 같은 harness로 기준 commit과 현재 source에서 측정한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/trackedChanges.ts").catch(error => { console.error(error); process.exitCode = 1; });
