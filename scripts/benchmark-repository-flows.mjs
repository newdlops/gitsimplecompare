// 최근 온보딩·순차 푸시의 실제 Git 프로세스 수와 로컬 실행 시간을 재현하는 진입점.
// 사용자 저장소·원격 대신 매번 새 임시 fixture를 만들고 종료 때 번들과 fixture를 정리한다.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * 현재 production 서비스를 번들하여 같은 시나리오의 실행 비용을 출력한다.
 * @returns fixture 생성·측정·정리까지 완료하는 Promise. 실패는 비영 종료 코드로 전달한다.
 */
async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-repository-benchmark-bundle-"));
  try {
    const outfile = path.join(directory, "benchmark.cjs");
    await build({ entryPoints: ["test/benchmarks/repositoryFlows.ts"], outfile, bundle: true,
      platform: "node", format: "cjs", target: "node18", logLevel: "silent",
      alias: { vscode: path.resolve("test/helpers/vscodeMock.ts") } });
    const { run } = await import(pathToFileURL(outfile).href);
    await run();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
