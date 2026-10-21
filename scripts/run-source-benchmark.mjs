// 동일한 계측 코드를 이전 commit과 작업 트리의 실제 source에 연결하는 격리 benchmark runner.
import { build } from "esbuild";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

/** source만 격리하고 같은 harness로 실행한다. 명시한 observer는 build 뒤 자식 Node만 감싸며 기본 실행에는 없다. */
export async function runSourceBenchmark(entryPoint, sharedFiles = [], nodeArgs = [], observerPrefix) {
  const workspaceRoot = process.cwd();
  const resourceObserver = process.env.GSC_BENCH_RESOURCE_OBSERVER;
  if (resourceObserver && !process.argv[2]) throw new Error("Resource observation requires an explicit output file.");
  const prefix = observerPrefix ?? (resourceObserver ? ["/usr/bin/python3", resourceObserver, process.argv[2] + ".resources.json"] : []);
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
      // 선택 observer는 archive/build가 끝난 실제 benchmark Node만 감싸 source 준비 비용을 자원 비교에서 뺀다.
      const command = prefix.length ? prefix[0] : process.execPath;
      const args = [...prefix.slice(1), ...(prefix.length ? [process.execPath] : []), ...nodeArgs, outfile, ...process.argv.slice(2)];
      const child = spawn(command, args, { cwd: sourceRoot, stdio: "inherit",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GSC_BENCH_WORKSPACE_ROOT: workspaceRoot, GSC_BENCH_SOURCE: JSON.stringify(source) } });
      child.once("error", reject); child.once("close", code => resolve(code ?? 1));
    });
    if (code !== 0) process.exitCode = code;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
