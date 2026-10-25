// 실제 저장소의 config를 유지하고, 빌드가 끝난 뒤에만 읽기 전용 Graph 측정을 시작한다.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const root = process.cwd(), directory = await mkdtemp(path.join(os.tmpdir(), "gsc-readonly-renderer-"));
try {
  const outfile = path.join(directory, "benchmark.cjs");
  await build({ entryPoints: [path.join(root, "test/benchmarks/graphReadOnlyRenderer.ts")], outfile,
    bundle: true, platform: "node", format: "cjs", target: "node18", logLevel: "silent",
    nodePaths: [path.join(root, "node_modules")], alias: { vscode: path.join(root, "test/helpers/vscodeMock.ts") } });
  const bundleSha256 = createHash("sha256").update(await readFile(outfile)).digest("hex");
  const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { cwd: root, stdio: "inherit",
    env: { ...process.env, GSC_BENCH_WORKSPACE_ROOT: root, GSC_BENCH_SOURCE: JSON.stringify({ kind: "working-tree", bundleSha256 }) } });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  process.exitCode = code ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
