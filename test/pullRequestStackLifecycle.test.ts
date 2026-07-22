import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { PullRequestStackAdvanceService } from "../src/git/pullRequestStackAdvanceService";
import { PullRequestStackMetadataService } from "../src/git/pullRequestStackMetadata";
import { PullRequestStackRestackService } from "../src/git/pullRequestStackRestack";
import { PullRequestStackSubmitService } from "../src/git/pullRequestStackSubmitService";

const execFileAsync = promisify(execFile);

/** 가짜 gh가 파일에 보존하는 PR 한 건의 최소 GitHub 응답 형태. */
interface FakePullRequest {
  number: number;
  title: string;
  url: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  state: "OPEN" | "MERGED";
  isDraft: boolean;
  author: { login: string };
}

/** 테스트 중 여러 gh 프로세스가 공유하는 저장소/PR 상태. */
interface FakeGitHubState {
  repository: string;
  defaultBranch: string;
  pullRequests: FakePullRequest[];
}

/** 실제 local 저장소, bare remote, 실행 가능한 가짜 gh와 상태 파일을 준비한다. */
async function createLifecycleFixture(): Promise<{
  fixtureRoot: string;
  repoRoot: string;
  remoteRoot: string;
  ghPath: string;
  ghStatePath: string;
}> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "gsc-stack-lifecycle-test-"));
  const repoRoot = join(fixtureRoot, "repository");
  const remoteRoot = join(fixtureRoot, "remote.git");
  const ghPath = join(fixtureRoot, "fake-gh.js");
  const ghStatePath = join(fixtureRoot, "github-state.json");
  await mkdir(repoRoot);
  await git(fixtureRoot, "init", "--bare", remoteRoot);
  await git(repoRoot, "init", "-b", "main");
  await git(repoRoot, "config", "user.name", "Stack Lifecycle Test");
  await git(repoRoot, "config", "user.email", "stack-lifecycle@example.com");
  await writeFile(join(repoRoot, "base.txt"), "base\n", "utf8");
  await git(repoRoot, "add", "base.txt");
  await git(repoRoot, "commit", "-m", "base");
  await git(repoRoot, "remote", "add", "origin", remoteRoot);
  await git(repoRoot, "push", "-u", "origin", "main");
  await writeFakeGh(ghPath);
  await writeFakeGitHubState(ghStatePath, {
    repository: "example/stack-repository",
    defaultBranch: "main",
    pullRequests: [],
  });
  return { fixtureRoot, repoRoot, remoteRoot, ghPath, ghStatePath };
}

/** shell 해석 없이 지정 작업 폴더에서 git을 실행하고 stdout을 반환한다. */
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

/**
 * 부모부터 두 개의 로컬 stack layer를 만들고 각 레이어 고유 commit을 추가한다.
 * - 첫 레이어는 Add Layer 권장 흐름인 linked worktree로 만들어 생성/정리까지 함께 검증한다.
 * @returns 첫 레이어를 checkout한 linked worktree 절대 경로
 */
async function createTwoLayerStack(repoRoot: string): Promise<string> {
  const metadata = new PullRequestStackMetadataService(repoRoot);
  const main = await git(repoRoot, "rev-parse", "main");
  const firstWorktree = join(repoRoot, "..", "stack-one-worktree");
  await metadata.createLayer({
    branch: "stack/one",
    parentBranch: "main",
    parentRef: main,
    worktreePath: firstWorktree,
  });
  await writeFile(join(firstWorktree, "one.txt"), "layer one\n", "utf8");
  await git(firstWorktree, "add", "one.txt");
  await git(firstWorktree, "commit", "-m", "add first stack layer");
  const one = await git(firstWorktree, "rev-parse", "HEAD");
  await metadata.createLayer({
    branch: "stack/two",
    parentBranch: "stack/one",
    parentRef: one,
  });
  await git(repoRoot, "switch", "stack/two");
  await writeFile(join(repoRoot, "two.txt"), "layer two\n", "utf8");
  await git(repoRoot, "add", "two.txt");
  await git(repoRoot, "commit", "-m", "add second stack layer");
  await git(repoRoot, "switch", "main");
  return firstWorktree;
}

/** 가짜 gh 상태 JSON을 원자성 요구가 없는 테스트 fixture 파일에 기록한다. */
async function writeFakeGitHubState(
  file: string,
  state: FakeGitHubState
): Promise<void> {
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** 현재 가짜 gh 상태를 타입이 지정된 객체로 읽는다. */
async function readFakeGitHubState(file: string): Promise<FakeGitHubState> {
  return JSON.parse(await readFile(file, "utf8")) as FakeGitHubState;
}

/**
 * submit/advance 서비스가 쓰는 `gh repo view`, `pr list/create/view/edit`를 흉내 내는 실행 파일을 만든다.
 * - 명령 인자는 execFile 배열로 전달되므로 이 stub도 shell quoting에 의존하지 않는다.
 * @param executable 생성할 가짜 gh 절대 경로
 */
async function writeFakeGh(executable: string): Promise<void> {
  const source = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    "const stateFile = process.env.GSC_FAKE_GH_STATE;",
    'if (!stateFile) throw new Error("GSC_FAKE_GH_STATE is required");',
    'const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));',
    "const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };",
    'const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\\n");',
    'const output = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));',
    'if (args[0] === "repo" && args[1] === "view") {',
    "  output({ nameWithOwner: state.repository, defaultBranchRef: { name: state.defaultBranch } });",
    "  process.exit(0);",
    "}",
    'if (args[0] === "pr" && args[1] === "list") {',
    '  output(state.pullRequests.filter((pr) => pr.state === "OPEN"));',
    "  process.exit(0);",
    "}",
    'if (args[0] === "pr" && args[1] === "create") {',
    '  const number = Math.max(0, ...state.pullRequests.map((pr) => pr.number)) + 1;',
    '  const head = value("--head");',
    "  const pr = {",
    "    number,",
    '    title: value("--title") || head,',
    '    url: `https://github.com/${state.repository}/pull/${number}`,',
    '    body: value("--body") || "",',
    "    headRefName: head,",
    '    baseRefName: value("--base"),',
    '    state: "OPEN",',
    '    isDraft: args.includes("--draft"),',
    '    author: { login: "stack-test" },',
    "  };",
    "  state.pullRequests.push(pr);",
    "  save();",
    "  output(pr.url);",
    "  process.exit(0);",
    "}",
    'if (args[0] === "pr" && args[1] === "view") {',
    "  const selector = args[2];",
    "  const pr = state.pullRequests.find((item) => String(item.number) === selector || item.headRefName === selector);",
    '  if (!pr) { process.stderr.write("pull request not found"); process.exit(1); }',
    "  output(pr);",
    "  process.exit(0);",
    "}",
    'if (args[0] === "pr" && args[1] === "edit") {',
    "  const pr = state.pullRequests.find((item) => String(item.number) === args[2]);",
    '  if (!pr) { process.stderr.write("pull request not found"); process.exit(1); }',
    '  if (value("--base") !== undefined) pr.baseRefName = value("--base");',
    '  if (value("--body") !== undefined) pr.body = value("--body");',
    "  save();",
    '  output(pr.url + "\\n");',
    "  process.exit(0);",
    "}",
    'process.stderr.write(`unsupported fake gh command: ${args.join(" ")}`);',
    "process.exit(2);",
    "",
  ].join("\n");
  await writeFile(executable, source, "utf8");
  await chmod(executable, 0o755);
}

/** 지정 commit이 target history에 포함되는지 실제 Git exit status로 확인한다. */
async function isAncestor(
  repoRoot: string,
  ancestor: string,
  target: string
): Promise<boolean> {
  try {
    await git(repoRoot, "merge-base", "--is-ancestor", ancestor, target);
    return true;
  } catch {
    return false;
  }
}

test("Submit/Sync 후 merge된 부모를 Advance하면 PR base와 로컬 stack이 함께 승격된다", async () => {
  const fixture = await createLifecycleFixture();
  const previousGhPath = process.env.GITHUB_CLI_PATH;
  const previousStatePath = process.env.GSC_FAKE_GH_STATE;
  process.env.GITHUB_CLI_PATH = fixture.ghPath;
  process.env.GSC_FAKE_GH_STATE = fixture.ghStatePath;
  try {
    const firstWorktree = await createTwoLayerStack(fixture.repoRoot);
    const canonicalFirstWorktree = await realpath(firstWorktree);
    assert.equal(
      (await git(fixture.repoRoot, "worktree", "list", "--porcelain")).includes(canonicalFirstWorktree),
      true
    );
    const submit = await new PullRequestStackSubmitService(fixture.repoRoot).submit({
      branch: "stack/two",
      remote: "origin",
      draft: true,
    });

    assert.deepEqual(
      submit.layers.map((layer) => [layer.branch, layer.push, layer.createdPullRequest]),
      [
        ["stack/one", "created", true],
        ["stack/two", "created", true],
      ]
    );
    let github = await readFakeGitHubState(fixture.ghStatePath);
    assert.deepEqual(
      github.pullRequests.map((pr) => [pr.number, pr.headRefName, pr.baseRefName]),
      [
        [1, "stack/one", "main"],
        [2, "stack/two", "stack/one"],
      ]
    );
    assert.match(github.pullRequests[0].body, /#1/);
    assert.match(github.pullRequests[0].body, /#2/);
    assert.match(github.pullRequests[1].body, /git-simple-compare-stack:start/);
    assert.equal(await git(fixture.repoRoot, "rev-parse", "origin/stack/one"), await git(fixture.repoRoot, "rev-parse", "stack/one"));
    assert.equal(await git(fixture.repoRoot, "rev-parse", "origin/stack/two"), await git(fixture.repoRoot, "rev-parse", "stack/two"));

    await git(fixture.repoRoot, "switch", "main");
    await git(fixture.repoRoot, "merge", "--no-ff", "stack/one", "-m", "merge first stack pull request");
    await git(fixture.repoRoot, "push", "origin", "main");
    github.pullRequests[0].state = "MERGED";
    await writeFakeGitHubState(fixture.ghStatePath, github);

    const advanceService = new PullRequestStackAdvanceService(fixture.repoRoot);
    const candidates = await advanceService.listCandidates();
    assert.deepEqual(candidates.map((candidate) => candidate.branch), ["stack/one"]);
    const plan = await advanceService.createPlan("stack/one", "origin");
    assert.equal(plan.previousParentBranch, "main");
    assert.deepEqual(plan.promotedBranches, ["stack/two"]);
    assert.deepEqual(
      plan.restack.steps.map((step) => [step.branch, step.parentBranch]),
      [["stack/two", "main"]]
    );

    const restacked = await new PullRequestStackRestackService(fixture.repoRoot)
      .execute(plan.restack);
    assert.equal(restacked.status, "completed");
    if (restacked.status !== "completed" || !restacked.postAction) return;
    const sync = await advanceService.syncPromotedStacks(restacked.postAction, true);
    assert.deepEqual(sync.promotedBranches, ["stack/two"]);
    assert.equal(sync.submittedStacks[0].layers[0].push, "force-with-lease");
    assert.equal(sync.submittedStacks[0].layers[0].changedBase, true);

    github = await readFakeGitHubState(fixture.ghStatePath);
    const promoted = github.pullRequests.find((pr) => pr.headRefName === "stack/two");
    assert.equal(promoted?.baseRefName, "main");
    assert.match(promoted?.body || "", /`main ← stack\/two`/);
    const mainHead = await git(fixture.repoRoot, "rev-parse", "main");
    const childHead = await git(fixture.repoRoot, "rev-parse", "stack/two");
    assert.equal(await isAncestor(fixture.repoRoot, mainHead, childHead), true);
    const childMetadata = (await new PullRequestStackMetadataService(fixture.repoRoot).listBranches())
      .find((branch) => branch.name === "stack/two");
    assert.equal(childMetadata?.parentBranch, "main");
    assert.equal(childMetadata?.parentHead, mainHead);

    const currentWorktreeCleanup = await new PullRequestStackAdvanceService(firstWorktree)
      .getCleanupPreview("stack/one");
    assert.equal(currentWorktreeCleanup.currentWorktree, true);
    assert.equal(currentWorktreeCleanup.canAutoCleanup, false);
    const cleanup = await advanceService.getCleanupPreview("stack/one");
    assert.equal(cleanup.canAutoCleanup, true);
    const removed = await advanceService.cleanupMergedLayer("stack/one");
    assert.equal(removed.removedBranch, true);
    assert.equal(removed.removedWorktree, canonicalFirstWorktree);
    await assert.rejects(
      () => git(fixture.repoRoot, "show-ref", "--verify", "refs/heads/stack/one")
    );
  } finally {
    if (previousGhPath === undefined) delete process.env.GITHUB_CLI_PATH;
    else process.env.GITHUB_CLI_PATH = previousGhPath;
    if (previousStatePath === undefined) delete process.env.GSC_FAKE_GH_STATE;
    else process.env.GSC_FAKE_GH_STATE = previousStatePath;
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});
