// 기존 원격 이력이 있는 새 브랜치의 실제 전송 횟수와 완료 시간을 같은 Native fixture로 대조한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/publishedPush.ts")
  .catch(error => { console.error(error); process.exitCode = 1; });
