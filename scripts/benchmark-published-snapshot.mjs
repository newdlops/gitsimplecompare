// 실제 원본 저장소의 객체는 읽기만 하고, 같은 harness로 이전/현재 push 준비 경로를 비교한다.
import { runSourceBenchmark } from "./run-source-benchmark.mjs";

runSourceBenchmark("test/benchmarks/publishedPushSnapshot.ts").catch(error => { console.error(error); process.exitCode = 1; });
