// 기존 저장소의 이력/branch 조회만 진단한다. 모든 Git 쓰기·네트워크와 원문 데이터 기록은 차단한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/graphReadOnly.ts")
  .catch(error => { console.error(error); process.exitCode = 1; });
