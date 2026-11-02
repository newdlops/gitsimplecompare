// 같은 의존성·격리 fixture로 P1–P5의 실제 변경 전후 서비스 함수를 비교한다.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd(), base = process.env.GSC_CRITICAL_BASE || '590c8fc';
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const directory = await mkdtemp(path.join(tmpdir(), 'gsc-http-critical-bench-'));
const before = path.join(directory, 'before'); await mkdir(before);
const exports = {
  'git/githubReadRuntime': ['GitHubReadRuntime'], 'git/githubReadCache': ['GitHubReadCache'],
  'git/githubCredential': ['GitHubCredentialProvider'], 'git/githubReadSession': ['captureGitHubRequestContext'],
  'git/githubRepositoryScope': ['gitHubRepositoryScopes'], 'git/pullRequestDetail': ['fetchPullRequestDetail'],
  'git/pullRequestPreviewFiles': ['fetchPullRequestChangedFiles'],
  'git/pullRequestPreviewRemote': ['fetchPreviewBootstrap', 'fetchPreviewCommitSummaries'],
  'git/pullRequestSearchReads': ['completeSearchPullRequests'], 'git/githubRestPages': ['encodeRestPage', 'restPageMetadata'],
  'git/githubWebReadContext': ['GitHubWebReadContext'], 'git/githubWebHtml': ['readGitHubWebHtmlWithFragments'],
  'providers/nativeDiffOverlayInspector': ['findInspectorWebSocketUrlForPid', 'clearInspectorPortHints'],
};
const shared = { bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent',
  nodePaths: [path.join(root, 'node_modules')], alias: { vscode: path.join(root, 'test/helpers/vscodeMock.ts') } };
try {
  const archive = path.join(directory, 'source.tar');
  execFileSync('git', ['archive', '--output', archive, base, 'src']);
  execFileSync('tar', ['-xf', archive, '-C', before]);
  for (const [side, source] of [['before', before], ['after', root]]) {
    const entry = path.join(directory, `${side}.ts`);
    await writeFile(entry, Object.entries(exports).map(([file, names]) =>
      `export {${names.join(',')}} from ${JSON.stringify(path.join(source, 'src', file))};`).join('\n'));
    await build({ ...shared, entryPoints: [entry], outfile: path.join(directory, `${side}.cjs`) });
  }
  const executable = path.join(directory, 'benchmark.cjs');
  await build({ ...shared, entryPoints: [path.join(root, 'test/benchmarks/httpCriticalPath.ts')], outfile: executable });
  const result = process.env.GSC_CRITICAL_RESULT || path.join(root, 'docs/benchmarks/http-critical-performance-20261102.json');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable], { stdio: 'inherit', env: { ...process.env,
      GSC_CRITICAL_DIRECTORY: directory, GSC_CRITICAL_BASE: base, GSC_CRITICAL_HEAD: head, GSC_CRITICAL_RESULT: result } });
    child.once('error', reject); child.once('close', code => resolve(code ?? 1));
  });
  if (code) throw new Error(`Critical-path benchmark failed (${code}).`);
  console.log(JSON.stringify({ result, base, head }));
} finally { await rm(directory, { recursive: true, force: true }); }
