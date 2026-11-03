// 이전 release와 현재 source에 같은 반복 cold 상태 조회 계측을 연결한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";
runSourceBenchmark("test/benchmarks/statusColdRepeat.ts").catch(error => { console.error(error); process.exitCode = 1; });
