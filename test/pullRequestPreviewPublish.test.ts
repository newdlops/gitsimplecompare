import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { PullRequestPublishService } from "../src/git/pullRequestPublishService";
import {
  pullRequestPreviewScript,
  type PullRequestPreviewPublishI18n,
} from "../src/webview/pullRequestPreviewScript";

const execFileAsync = promisify(execFile);

interface FakePullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  state: "OPEN";
  isDraft: boolean;
  author: { login: string };
}

interface FakeGitHubState {
  repository: string;
  pullRequests: FakePullRequest[];
}

/**
 * 실제 local 저장소, bare remote, 가짜 gh 상태를 한 임시 폴더에 준비한다.
 * - 네트워크 없이도 commit과 upstream 설정은 실제 Git 동작을 그대로 검증한다.
 * - GitHub API 부분만 실행 가능한 gh stub과 공유 JSON 상태로 치환한다.
 * @returns 테스트가 직접 검사하고 마지막에 정리할 fixture 절대 경로 묶음
 */
async function createPublishFixture(): Promise<{
  fixtureRoot: string;
  repoRoot: string;
  remoteRoot: string;
  ghPath: string;
  ghStatePath: string;
}> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "gsc-pr-preview-publish-test-"));
  const repoRoot = join(fixtureRoot, "repository");
  const remoteRoot = join(fixtureRoot, "remote.git");
  const ghPath = join(fixtureRoot, "fake-gh.js");
  const ghStatePath = join(fixtureRoot, "github-state.json");
  await mkdir(repoRoot);
  await git(fixtureRoot, "init", "--bare", remoteRoot);
  await git(repoRoot, "init", "-b", "main");
  await git(repoRoot, "config", "user.name", "PR Preview Test");
  await git(repoRoot, "config", "user.email", "pr-preview@example.com");
  await writeFile(join(repoRoot, "base.txt"), "base\n", "utf8");
  await git(repoRoot, "add", "base.txt");
  await git(repoRoot, "commit", "-m", "base");
  await git(repoRoot, "remote", "add", "origin", remoteRoot);
  await git(repoRoot, "push", "-u", "origin", "main");
  await git(repoRoot, "switch", "-c", "feature/preview-publish");
  await writeFakeGh(ghPath);
  await writeFile(ghStatePath, JSON.stringify({
    repository: "example/pr-preview-publish",
    pullRequests: [],
  } satisfies FakeGitHubState), "utf8");
  return { fixtureRoot, repoRoot, remoteRoot, ghPath, ghStatePath };
}

/** shell 해석 없이 fixture 저장소에서 git을 실행하고 stdout을 반환한다. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      HUSKY: "0",
    },
  });
  return result.stdout.trim();
}

/** 테스트 상태 JSON을 타입이 지정된 객체로 읽는다. */
async function readFakeGithubState(path: string): Promise<FakeGitHubState> {
  return JSON.parse(await readFile(path, "utf8")) as FakeGitHubState;
}

/** Preview 게시 서비스가 쓰는 gh pr list/create/view 명령을 흉내 내는 실행 파일을 만든다. */
async function writeFakeGh(executable: string): Promise<void> {
  const source = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    "const stateFile = process.env.GSC_FAKE_PR_PREVIEW_STATE;",
    'if (!stateFile) throw new Error("GSC_FAKE_PR_PREVIEW_STATE is required");',
    'const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));',
    "const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };",
    'const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\\n");',
    'const output = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));',
    'if (args[0] === "pr" && args[1] === "list") {',
    '  const head = value("--head");',
    '  output(state.pullRequests.filter((pr) => pr.state === "OPEN" && (!head || pr.headRefName === head)));',
    "  process.exit(0);",
    "}",
    'if (args[0] === "pr" && args[1] === "create") {',
    '  const number = Math.max(0, ...state.pullRequests.map((pr) => pr.number)) + 1;',
    '  const head = value("--head");',
    "  const pr = {",
    "    number,",
    '    title: value("--title"),',
    '    body: value("--body") || "",',
    '    url: `https://github.com/${state.repository}/pull/${number}`,',
    "    headRefName: head,",
    '    baseRefName: value("--base"),',
    '    state: "OPEN",',
    '    isDraft: args.includes("--draft"),',
    '    author: { login: "preview-test" },',
    "  };",
    "  state.pullRequests.push(pr);",
    "  save();",
    "  output(pr.url);",
    "  process.exit(0);",
    "}",
    'if (args[0] === "pr" && args[1] === "view") {',
    "  const selector = args[2];",
    "  const pr = state.pullRequests.find((item) => item.headRefName === selector || String(item.number) === selector);",
    '  if (!pr) { process.stderr.write("pull request not found"); process.exit(1); }',
    "  output(pr);",
    "  process.exit(0);",
    "}",
    'process.stderr.write(`unsupported fake gh command: ${args.join(" ")}`);',
    "process.exit(2);",
    "",
  ].join("\n");
  await writeFile(executable, source, "utf8");
  await chmod(executable, 0o755);
}

test("PR Preview 게시가 staged 변경만 커밋하고 일반 push 후 GitHub PR을 만든다", async () => {
  const fixture = await createPublishFixture();
  const previousGhPath = process.env.GITHUB_CLI_PATH;
  const previousStatePath = process.env.GSC_FAKE_PR_PREVIEW_STATE;
  process.env.GITHUB_CLI_PATH = fixture.ghPath;
  process.env.GSC_FAKE_PR_PREVIEW_STATE = fixture.ghStatePath;
  try {
    await writeFile(join(fixture.repoRoot, "published.txt"), "published\n", "utf8");
    await writeFile(join(fixture.repoRoot, "local-only.txt"), "unstaged\n", "utf8");
    await git(fixture.repoRoot, "add", "published.txt");
    const service = new PullRequestPublishService(fixture.repoRoot);
    const context = await service.inspect("feature/preview-publish", "origin/main");

    assert.equal(context.targetBranch, "main");
    assert.equal(context.targetRef, "origin/main");
    assert.equal(context.currentBranch, "feature/preview-publish");
    assert.equal(context.sourceIsLocal, true);
    assert.equal(context.stagedFileCount, 1);
    assert.equal(context.unstagedFileCount, 1);
    assert.deepEqual(context.remotes, [{
      name: "origin",
      branch: "feature/preview-publish",
      recommended: true,
    }]);

    const result = await service.publishPreview({
      sourceBranch: "feature/preview-publish",
      targetBranch: "origin/main",
      remote: "origin",
      title: "Publish directly from Preview",
      body: "Preview body",
      draft: true,
      commitMessage: "commit staged preview changes",
    });
    assert.equal(result.committed, true);
    assert.equal(result.pullRequest.number, 1);
    assert.equal(result.pullRequest.isDraft, true);
    assert.equal(await git(fixture.repoRoot, "diff", "--cached", "--name-only"), "");
    assert.equal(await git(fixture.repoRoot, "status", "--short", "local-only.txt"), "?? local-only.txt");
    assert.equal(await git(fixture.repoRoot, "show", "-s", "--format=%s", "HEAD"), "commit staged preview changes");
    assert.equal(
      await git(fixture.repoRoot, "rev-parse", "feature/preview-publish"),
      await git(fixture.repoRoot, "rev-parse", "refs/remotes/origin/feature/preview-publish")
    );
    const github = await readFakeGithubState(fixture.ghStatePath);
    assert.deepEqual(
      github.pullRequests.map((pr) => [pr.headRefName, pr.baseRefName, pr.title, pr.body, pr.isDraft]),
      [["feature/preview-publish", "main", "Publish directly from Preview", "Preview body", true]]
    );

    await writeFile(join(fixture.repoRoot, "wrong-source.txt"), "staged elsewhere\n", "utf8");
    await git(fixture.repoRoot, "add", "wrong-source.txt");
    await git(fixture.repoRoot, "branch", "another-source", "main");
    await assert.rejects(
      service.publishPreview({
        sourceBranch: "another-source",
        targetBranch: "main",
        remote: "origin",
        title: "Wrong source",
        body: "",
        draft: false,
        commitMessage: "must not be created",
      }),
      /Staged changes belong to 'feature\/preview-publish'/
    );
    assert.equal(await git(fixture.repoRoot, "diff", "--cached", "--name-only"), "wrong-source.txt");
    await assert.rejects(
      git(fixture.repoRoot, "rev-parse", "--verify", "refs/remotes/origin/another-source")
    );

    // 같은 head의 열린 PR은 staged commit보다 먼저 검사해 중복 PR과 뜻밖의 로컬 commit을 함께 막는다.
    const featureHeadBeforeDuplicate = await git(fixture.repoRoot, "rev-parse", "HEAD");
    await assert.rejects(
      service.publishPreview({
        sourceBranch: "feature/preview-publish",
        targetBranch: "main",
        remote: "origin",
        title: "Duplicate",
        body: "",
        draft: false,
        commitMessage: "must not be created either",
      }),
      /Pull request #1 already exists/
    );
    assert.equal(await git(fixture.repoRoot, "rev-parse", "HEAD"), featureHeadBeforeDuplicate);
    assert.equal(await git(fixture.repoRoot, "diff", "--cached", "--name-only"), "wrong-source.txt");

    // staged 파일도 target보다 앞선 commit도 없으면 빈 원격 branch/PR을 만들지 않는다.
    await git(fixture.repoRoot, "restore", "--staged", "wrong-source.txt");
    await assert.rejects(
      service.publishPreview({
        sourceBranch: "another-source",
        targetBranch: "main",
        remote: "origin",
        title: "Empty branch",
        body: "",
        draft: false,
      }),
      /has no commits ahead of 'main'/
    );
    await assert.rejects(
      git(fixture.repoRoot, "rev-parse", "--verify", "refs/remotes/origin/another-source")
    );

    // 이미 커밋된 source는 새 commit 없이 일반 push하고 두 번째 Ready PR로 게시한다.
    await git(fixture.repoRoot, "switch", "another-source");
    await writeFile(join(fixture.repoRoot, "committed-only.txt"), "committed\n", "utf8");
    await git(fixture.repoRoot, "add", "committed-only.txt");
    await git(fixture.repoRoot, "commit", "-m", "committed before preview publish");
    const committedOnly = await service.publishPreview({
      sourceBranch: "another-source",
      targetBranch: "main",
      remote: "origin",
      title: "Publish existing commits",
      body: "No automatic commit",
      draft: false,
    });
    assert.equal(committedOnly.committed, false);
    assert.equal(committedOnly.pullRequest.number, 2);
    assert.equal(committedOnly.pullRequest.isDraft, false);
    assert.equal(
      await git(fixture.repoRoot, "rev-parse", "another-source"),
      await git(fixture.repoRoot, "rev-parse", "refs/remotes/origin/another-source")
    );
    assert.deepEqual(
      (await readFakeGithubState(fixture.ghStatePath)).pullRequests.map((pr) => pr.headRefName),
      ["feature/preview-publish", "another-source"]
    );
  } finally {
    if (previousGhPath === undefined) delete process.env.GITHUB_CLI_PATH;
    else process.env.GITHUB_CLI_PATH = previousGhPath;
    if (previousStatePath === undefined) delete process.env.GSC_FAKE_PR_PREVIEW_STATE;
    else process.env.GSC_FAKE_PR_PREVIEW_STATE = previousStatePath;
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("PR Preview 게시 클라이언트 스크립트가 안전한 JavaScript로 조립된다", () => {
  const i18n: PullRequestPreviewPublishI18n = {
    ready: "Create <PR>",
    busy: "Publishing...",
    existing: "Existing",
    selectTarget: "Select target",
    selectLocalSource: "Select source",
    missingMessage: "Missing title",
    noChanges: "No changes",
    updating: "Updating",
  };
  const script = pullRequestPreviewScript(i18n);
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /publishPullRequest/);
  assert.equal(script.includes("Create <PR>"), false);
  assert.match(script, /Create \\u003cPR\\u003e/);
});
