import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { graphBrowserBuildOptions } from "../../scripts/browser-bundle.mjs";

/**
 * 비교 기준 commit의 media와 빌드 문맥을 소유 임시 폴더에 풀어 배포와 같은 옵션으로 bundle을 만든다.
 * @param reference 검증할 Git commit @returns 준비 구간 밖에서 읽은 불변 bundle 바이트. 사용자 작업 파일은 쓰지 않는다.
 */
export async function baselineBrowserBundle(reference: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-browser-baseline-")); let completed = false;
  try {
    // tsconfig의 strict 출력도 JS bundle 바이트에 영향을 주므로 source와 함께 원래 빌드 문맥을 복원한다.
    const archive = execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "archive", reference, "media", "tsconfig.json", "package.json"], { maxBuffer: 64 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", root], { input: archive });
    const requireFixture = createRequire(path.join(process.env.GSC_BENCH_WORKSPACE_ROOT || process.cwd(), "package.json"));
    await requireFixture("esbuild").build(graphBrowserBuildOptions(root));
    const code = await readFile(path.join(root, "media/bundled/graph.js"), "utf8"); completed = true; return code;
  } finally { if (completed) await rm(root, { recursive: true, force: true }); }
}
