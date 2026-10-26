// 고정된 두 release의 표시 소비자를 같은 Native fixture·Node harness에서 비교한다.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const before = "db9ed984ba5a3d88b106652162e505eb7ce0d6f3";
const after = "0111964845245cb54d330bc58e971de000a35663";
const output = path.resolve(process.argv[2] ?? path.join(tmpdir(), "gsc-focus-status-resource-72178.json"));
const changed = new Set(["src/extension.ts", "src/commands/refreshChangesView.ts", "src/commands/workingStatusRefresh.ts",
  "src/commands/workingStatusRefreshState.ts", "src/providers/workingTreeFileDecorations.ts"]);

/**
 * 현재 source와 두 비교점의 경계를 확인해 Native backend나 미커밋 코드를 비교에 섞지 않는다.
 * @returns 빌드할 source를 읽는 함수. 고정된 UI 변경 파일만 release commit에서 읽는다.
 */
function fixedSources() {
  execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "diff", "--exit-code", after, "--", "src",
    "test/helpers/vscodeMock.ts", "test/helpers/childResourceProbe.ts", "scripts/child-resource-probe.c"], { cwd: root });
  const files = execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "diff", "--name-only", before, after, "--", "src"],
    { cwd: root, encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(new Set(files), changed);
  return ref => ({ name: "fixed-focus-release", setup(builder) {
    builder.onLoad({ filter: /\/src\/.*\.ts$/ }, async ({ path: file }) => {
      const relative = path.relative(root, file);
      if (!changed.has(relative)) return undefined;
      return { contents: execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "show", `${ref}:${relative}`],
        { cwd: root, encoding: "utf8" }), loader: "ts" };
    });
  } });
}

const directory = await mkdtemp(path.join(tmpdir(), "gsc-focus-resource-build-"));
try {
  const plugin = fixedSources();
  const exports = `
export * as status from './src/commands/workingStatusRefresh';
export {WorkingTreeFileDecorationProvider} from './src/providers/workingTreeFileDecorations';
export {GitService} from './src/git/gitService';
export {readWorkingTreeSnapshot,setWorkingTreeSnapshotPolicy,onWorkingTreeSnapshotInvalidated,disposeWorkingTreeSnapshots} from './src/git/workingTreeSnapshot';
export {gitProcesses} from './src/git/gitProcessRegistry';
export {setGitExecutionObserver} from './src/git/gitExecutionDiagnostics';
export {runGit,runGitWithInput} from './src/git/gitExec';
export {parseWorkingTreeV2,workingTreeSnapshot} from './src/git/workingTreeStatusFormat';
export {loadChildResourceProbe} from './test/helpers/childResourceProbe';
export {window,workspace,Uri} from './test/helpers/vscodeMock';`;
  for (const [name, ref] of [["before", before], ["after", after]]) {
    await build({ stdin: { contents: exports, resolveDir: root, loader: "ts" }, outfile: path.join(directory, `${name}.cjs`),
      bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "silent",
      alias: { vscode: path.join(root, "test/helpers/vscodeMock.ts") }, plugins: [plugin(ref)] });
  }
  // 실제 사용자 Git 설정과 별도 directory 환경을 fixture에 상속하지 않는다.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && key !== "DYLD_INSERT_LIBRARIES"));
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" });
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts/benchmark-focus-status-worker.mjs"), directory, output],
      { cwd: root, env: environment, stdio: "inherit" });
    const interrupt = () => child.kill("SIGTERM");
    process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
    child.once("error", reject);
    child.once("close", value => {
      process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); resolve(value ?? 1);
    });
  });
  if (code) process.exitCode = code;
} finally { await rm(directory, { recursive: true, force: true }); }
