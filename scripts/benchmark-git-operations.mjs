// 실제 Git 작업과 Graph 후속 게시의 시간을 같은 격리 fixture에서 기록한다.
import { build } from "esbuild";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

/** 별도 프로세스 환경에만 Git 설정 격리를 적용하고 성공/실패와 무관하게 임시 번들을 정리한다. */
async function main() {
  const workspaceRoot = process.cwd();
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-operation-benchmark-bundle-"));
  try {
    let sourceRoot = workspaceRoot;
    const ref = process.env.GSC_BENCH_SOURCE_REF;
    const commit = execFileSync("git", ["rev-parse", "--verify", `${ref || "HEAD"}^{commit}`], { cwd: workspaceRoot }).toString().trim();
    if (ref) {
      sourceRoot = path.join(directory, "source"); await mkdir(sourceRoot);
      // 로컬 commit의 source만 추출하고 동일한 계측 harness를 덮어 써 이전/현재 production code를 공정하게 비교한다.
      const archive = execFileSync("git", ["archive", commit], { cwd: workspaceRoot, maxBuffer: 64 * 1024 * 1024 });
      execFileSync("tar", ["-x", "-C", sourceRoot], { input: archive });
      await mkdir(path.join(sourceRoot, "test", "benchmarks"), { recursive: true });
      for (const relative of ["test/benchmarks/gitOperationMatrix.ts", "test/helpers/graphOperationPanel.ts"]) await copyFile(path.join(workspaceRoot, relative), path.join(sourceRoot, relative));
    }
    const outfile = path.join(directory, "matrix.cjs");
    await build({ entryPoints: [path.join(sourceRoot, "test/benchmarks/gitOperationMatrix.ts")], outfile, bundle: true, platform: "node", format: "cjs",
      target: "node18", logLevel: "silent", nodePaths: [path.join(workspaceRoot, "node_modules")], alias: { vscode: path.join(sourceRoot, "test/helpers/vscodeMock.ts") } });
    const source = { kind: ref ? "commit" : "working-tree", commit, bundleSha256: createHash("sha256").update(await readFile(outfile)).digest("hex") };
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { cwd: sourceRoot, stdio: "inherit",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GSC_BENCH_SOURCE: JSON.stringify(source) } });
      child.once("error", reject); child.once("close", code => resolve(code ?? 1));
    });
    if (code !== 0) process.exitCode = code;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
