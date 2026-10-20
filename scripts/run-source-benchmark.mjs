// 동일한 계측 코드를 이전 commit과 작업 트리의 실제 source에 연결하는 격리 benchmark runner.
import { build } from "esbuild";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

/** source만 archive로 분리하고 같은 harness·Node 인자·설정 격리로 실행한 뒤 임시 번들을 정리한다. */
export async function runSourceBenchmark(entryPoint, sharedFiles = [], nodeArgs = []) {
  const workspaceRoot = process.cwd();
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-source-benchmark-"));
  try {
    let sourceRoot = workspaceRoot;
    const ref = process.env.GSC_BENCH_SOURCE_REF;
    const commit = execFileSync("git", ["rev-parse", "--verify", `${ref || "HEAD"}^{commit}`], { cwd: workspaceRoot }).toString().trim();
    if (ref) {
      sourceRoot = path.join(directory, "source"); await mkdir(sourceRoot);
      const archive = execFileSync("git", ["archive", commit], { cwd: workspaceRoot, maxBuffer: 64 * 1024 * 1024 });
      execFileSync("tar", ["-x", "-C", sourceRoot], { input: archive });
      for (const relative of [entryPoint, ...sharedFiles]) {
        await mkdir(path.dirname(path.join(sourceRoot, relative)), { recursive: true });
        await copyFile(path.join(workspaceRoot, relative), path.join(sourceRoot, relative));
      }
    }
    const outfile = path.join(directory, "benchmark.cjs");
    await build({ entryPoints: [path.join(sourceRoot, entryPoint)], outfile, bundle: true, platform: "node", format: "cjs",
      target: "node18", logLevel: "silent", nodePaths: [path.join(workspaceRoot, "node_modules")], alias: { vscode: path.join(sourceRoot, "test/helpers/vscodeMock.ts") } });
    const source = { kind: ref ? "commit" : "working-tree", commit, bundleSha256: createHash("sha256").update(await readFile(outfile)).digest("hex") };
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...nodeArgs, outfile, ...process.argv.slice(2)], { cwd: sourceRoot, stdio: "inherit",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GSC_BENCH_WORKSPACE_ROOT: workspaceRoot, GSC_BENCH_SOURCE: JSON.stringify(source) } });
      child.once("error", reject); child.once("close", code => resolve(code ?? 1));
    });
    if (code !== 0) process.exitCode = code;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
