// 같은 의존성과 격리 fixture로 기준/현재 소스를 번들해 추가 HTTP 개선 일곱 경로를 비교한다.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd(), base = process.env.GSC_HTTP_NEXT_BASE || "fd2a7b9";
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const temporary = await mkdtemp(path.join(tmpdir(), "gsc-http-next-benchmark-"));
const before = path.join(temporary, "before"); await mkdir(before);
const exports = {
  githubReadRuntime: ["GitHubReadRuntime"], githubReadCache: ["GitHubReadCache", "beginGitHubReadLifetime"],
  githubCredential: ["GitHubCredentialProvider"], githubReadSession: ["captureGitHubRequestContext"],
  githubRepositoryScope: ["gitHubRepositoryScopes"], pullRequestPreviewFiles: ["fetchPullRequestChangedFiles", "fetchPullRequestPreviewFiles"],
  pullRequestPublishService: ["PullRequestPublishService"], pullRequestListReads: ["readPullRequestNodes"],
  pullRequestSearchService: ["searchPullRequests"], githubRepositoryName: ["clearGitHubRepositoryNameCache"],
  pullRequestPreviewRemote: ["fetchPreviewBootstrap", "fetchPreviewCommitSummaries"],
  githubRestPages: ["encodeRestPage", "restPageMetadata"], githubWebTransport: ["GitHubWebTransport"],
  githubWebReadContext: ["GitHubWebReadContext"],
};
const shared = { bundle: true, platform: "node", format: "cjs", target: "node18", logLevel: "silent",
  nodePaths: [path.join(root, "node_modules")], alias: { vscode: path.join(root, "test/helpers/vscodeMock.ts") } };
try {
  const archive = path.join(temporary, "source.tar");
  execFileSync("git", ["archive", "--output", archive, base, "src"]);
  execFileSync("tar", ["-xf", archive, "-C", before]);
  for (const [side, source] of [["before", before], ["after", root]]) {
    const entry = path.join(temporary, `${side}.ts`);
    await writeFile(entry, Object.entries(exports).map(([file, names]) =>
      `export {${names.join(",")}} from ${JSON.stringify(path.join(source, "src/git", file))};`).join("\n"));
    await build({ ...shared, entryPoints: [entry], outfile: path.join(temporary, `${side}.cjs`) });
  }
  const executable = path.join(temporary, "benchmark.cjs");
  await build({ ...shared, entryPoints: [path.join(root, "test/benchmarks/httpNext.ts")], outfile: executable });
  const result = process.env.GSC_HTTP_NEXT_RESULT || path.join(root, "docs/benchmarks/http-next-performance-20261101.json");
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable], { stdio: "inherit", env: { ...process.env,
      GSC_HTTP_NEXT_DIRECTORY: temporary, GSC_HTTP_NEXT_BASE: base, GSC_HTTP_NEXT_HEAD: head, GSC_HTTP_NEXT_RESULT: result } });
    child.once("error", reject); child.once("close", code => resolve(code ?? 1));
  });
  if (code) throw new Error(`HTTP next benchmark failed (${code}).`);
  console.log(JSON.stringify({ result, base, head }));
} finally { await rm(temporary, { recursive: true, force: true }); }
