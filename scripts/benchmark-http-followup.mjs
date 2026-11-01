// 동일한 의존성으로 pinned source와 HEAD 실행 bundle을 만들고 fixture끼리만 비교한다.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const workspace = process.cwd(), base = process.env.GSC_FOLLOWUP_BASE || "341e1b2";
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const directory = await realpath(await mkdtemp(path.join(tmpdir(), "gsc-followup-build-")));
const archived = path.join(directory, "before"); await mkdir(archived);
const archive = path.join(directory, "before.tar");
execFileSync("git", ["archive", "--output", archive, base, "src"]);
execFileSync("tar", ["-xf", archive, "-C", archived]);
const exports = {
  "git/pullRequestSuggestedChangesets": ["readPullRequestSuggestedChangesets"], "git/githubWebHtml": ["readGitHubWebHtmlWithFragments"],
  "git/pullRequestReviewComments": ["PullRequestReviewCommentService"], "git/pullRequestPreviewConversation": ["buildPullRequestConversation"],
  "git/githubRepositoryCatalog": ["GitHubRepositoryCatalog"], "git/pullRequestStackAdvanceService": ["PullRequestStackAdvanceService"],
  "git/pullRequestStackSubmitService": ["PullRequestStackSubmitService"], "git/pullRequestRefLookup": ["fetchPullRequestRefs"],
  "git/pullRequestDependencyLookup": ["lookupPullRequestDependencies", "lookupPullRequestDependencyDetails"], "git/githubReadRuntime": ["GitHubReadRuntime"],
  "git/githubReadCache": ["GitHubReadCache", "beginGitHubReadLifetime"], "git/githubCredential": ["GitHubCredentialProvider"],
  "git/githubReadSession": ["captureGitHubRequestContext"], "git/githubRepositoryScope": ["gitHubRepositoryScopes"],
  "providers/nativeDiffOverlayInspector": ["findInspectorWebSocketUrlForPid"], "git/repositorySetupService": ["RepositorySetupService"],
};
const shared = { bundle: true, platform: "node", format: "cjs", target: "node18", nodePaths: [path.join(workspace, "node_modules")],
  alias: { vscode: path.join(workspace, "test/helpers/vscodeMock.ts") }, logLevel: "silent" };
try {
  for (const [side, root] of [["before", archived], ["after", workspace]]) {
    const file = path.join(directory, `${side}.ts`), outfile = path.join(directory, `${side}.cjs`);
    let source = Object.entries(exports).map(([file, names]) => `export {${names.join(",")}} from ${JSON.stringify(path.join(root, "src", file))};`).join("\n");
    if (side === "after") source += `\nexport {GitHubWebReadContext} from ${JSON.stringify(path.join(root,"src/git/githubWebReadContext"))};\nexport {encodeRestPage,restPageMetadata} from ${JSON.stringify(path.join(root,"src/git/githubRestPages"))};`;
    await writeFile(file, source); await build({ ...shared, entryPoints: [file], outfile });
  }
  const executable = path.join(directory, "benchmark.cjs"); await build({ ...shared, entryPoints: [path.join(workspace, "test/benchmarks/httpFollowup.ts")], outfile: executable });
  const result = process.env.GSC_FOLLOWUP_RESULT || path.join(workspace, "docs/benchmarks/http-followup-performance-20261101.json");
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable], { cwd: workspace, stdio: "inherit", env: { ...process.env, GSC_FOLLOWUP_BASE: base, GSC_FOLLOWUP_HEAD: head,
      GSC_FOLLOWUP_BEFORE: path.join(directory,"before.cjs"), GSC_FOLLOWUP_AFTER: path.join(directory,"after.cjs"), GSC_FOLLOWUP_RESULT: result } });
    child.once("error", reject); child.once("close", code => resolve(code ?? 1));
  });
  if (code) throw new Error(`Follow-up benchmark failed (${code}).`);
  console.log(JSON.stringify({ result, sourceBefore: base, sourceAfter: head }));
} finally { await rm(directory, { recursive: true, force: true }); }
