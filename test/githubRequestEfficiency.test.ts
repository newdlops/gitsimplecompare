import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ComparisonService } from "../src/git/comparisonService";
import { runGit } from "../src/git/gitExec";
import { clearGitHubRepositoryNameCache, readGitHubRepositoryName } from "../src/git/githubRepositoryName";
import type { PullRequestInfo } from "../src/git/pullRequestInfo";
import { fetchPullRequestRefs } from "../src/git/pullRequestRefLookup";
import type { GhExecute } from "../src/git/ghRunner";
import { SharedGitRead } from "../src/git/sharedGitRead";

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

/** base/head 커밋이 있는 격리 저장소를 만든다. */
async function createRepo(): Promise<{ root: string; base: string; head: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-github-efficiency-"));
  const git = (args: string[]) => runGit(args, root);
  await git(["init", "--quiet", "--initial-branch=main"]);
  await git(["config", "user.name", "GitHub Test"]);
  await git(["config", "user.email", "github@example.com"]);
  await git(["config", "commit.gpgSign", "false"]);
  await writeFile(path.join(root, "a.txt"), "base\n");
  await git(["add", "a.txt"]);
  await git(["commit", "--quiet", "-m", "base"]);
  const base = (await git(["rev-parse", "HEAD"])).trim();
  await git(["checkout", "--quiet", "-b", "feature"]);
  await writeFile(path.join(root, "a.txt"), "head\n");
  await git(["commit", "--quiet", "-am", "head"]);
  const head = (await git(["rev-parse", "HEAD"])).trim();
  await git(["checkout", "--quiet", "main"]);
  return { root, base, head };
}

/** 비교 서비스가 쓰는 PR 서비스 메서드 호출 수를 기록하는 가짜를 만든다. */
function fakePullRequests(refs: () => Partial<PullRequestInfo> | undefined) {
  const calls = { overview: 0, changedFiles: 0, refs: 0 };
  const service = {
    getOverview: async () => { calls.overview++; return { available: true, pullRequests: [] }; },
    getChangedFiles: async () => {
      calls.changedFiles++;
      return { files: [{ status: "M", path: "a.txt", additions: 1, deletions: 1 }], truncated: false };
    },
    getPullRequestRefs: async () => {
      calls.refs++;
      const value = refs();
      return value && { ...pr(), ...value };
    },
  };
  return { calls, service };
}

let prBase = "";
let prHead = "";
/** 테스트 저장소의 base/head 를 가리키는 PR 정보를 만든다. */
function pr(): PullRequestInfo {
  return {
    number: 7, title: "Feature", state: "OPEN", url: "", headRefName: "feature", headHash: prHead,
    baseRefName: "main", baseHash: prBase, author: "", isDraft: false, commentCount: 0, fileCount: 1, commitHashes: [prHead],
  };
}

test("PR 비교 새로고침은 PR 하나의 head/base 만 조회하고, 그대로면 목록·파일 목록을 다시 받지 않는다", async () => {
  const { root, base, head } = await createRepo();
  prBase = base; prHead = head;
  try {
    let current: Partial<PullRequestInfo> | undefined = { headHash: head, baseHash: base, title: "Feature (renamed)" };
    const { calls, service } = fakePullRequests(() => current);
    const comparison = new ComparisonService(root, { pullRequests: service as never });
    const snapshot = await comparison.comparePullRequest(pr());
    assert.equal(calls.changedFiles, 1);

    const refreshed = await comparison.refresh(snapshot);
    assert.deepEqual(calls, { overview: 0, changedFiles: 1, refs: 1 }, "변경 없는 PR 은 파일 목록을 다시 받지 않는다");
    assert.deepEqual(refreshed.changes, snapshot.changes);
    assert.equal(refreshed.pullRequest?.title, "Feature (renamed)");

    current = { headHash: base, baseHash: base };
    await comparison.refresh(refreshed);
    assert.deepEqual(calls, { overview: 0, changedFiles: 2, refs: 2 }, "head 가 바뀌면 파일 목록만 다시 받는다");

    current = undefined;
    await comparison.refresh(refreshed);
    assert.equal(calls.overview, 0, "PR 조회가 실패해도 PR 목록 전체로 되돌아가지 않는다");
    assert.equal(calls.changedFiles, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("단일 PR 조회는 gh 의 owner/repo 치환으로 요청 한 번에 head/base 를 읽는다", async () => {
  const calls: Array<readonly string[]> = [];
  const info = await fetchPullRequestRefs("/repo", 42, async (args) => {
    calls.push(args);
    return JSON.stringify({ data: { repository: { pullRequest: {
      number: 42, title: "T", state: "OPEN", url: "u", headRefName: "h", headRefOid: "aaa", baseRefName: "main", baseRefOid: "bbb",
    } } } });
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("owner={owner}") && calls[0].includes("name={repo}") && calls[0].includes("number=42"));
  assert.ok(!calls[0].includes("view"), "gh repo view 를 따로 부르지 않는다");
  assert.equal(info?.headHash, "aaa");
  assert.equal(info?.baseHash, "bbb");
  assert.equal(await fetchPullRequestRefs("/repo", 1, async () => JSON.stringify({ data: { repository: { pullRequest: null } } })), undefined);
});

test("저장소 이름은 원격 설정이 같으면 gh repo view 를 한 번만 부르고, 실패는 기억하지 않는다", async () => {
  clearGitHubRepositoryNameCache();
  const { root } = await createRepo();
  try {
    await runGit(["remote", "add", "origin", "https://github.com/owner/one.git"], root);
    let views = 0;
    let fail = false;
    const runner = async () => {
      views++;
      if (fail) throw new Error("network down");
      return JSON.stringify({ nameWithOwner: views > 1 ? "owner/two" : "owner/one" });
    };
    const [first, second] = await Promise.all([
      readGitHubRepositoryName(root, runner, { operation: "test" }),
      readGitHubRepositoryName(root, runner, { operation: "test" }),
    ]);
    assert.equal(first, "owner/one");
    assert.equal(second, "owner/one");
    assert.equal(await readGitHubRepositoryName(root, runner, { operation: "test" }), "owner/one");
    assert.equal(views, 1);

    await runGit(["remote", "set-url", "origin", "https://github.com/owner/two.git"], root);
    assert.equal(await readGitHubRepositoryName(root, runner, { operation: "test" }), "owner/two");
    assert.equal(views, 2, "원격 URL 이 바뀌면 다시 조회한다");

    await runGit(["remote", "set-url", "origin", "https://github.com/owner/three.git"], root);
    fail = true;
    await assert.rejects(readGitHubRepositoryName(root, runner, { operation: "test" }), /network down/);
    fail = false;
    await readGitHubRepositoryName(root, runner, { operation: "test" });
    assert.equal(views, 4, "실패한 조회는 캐시하지 않고 다음에 다시 시도한다");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository lookup cancellation is independent for consumers sharing the same runner", async t => {
  clearGitHubRepositoryNameCache();
  const { root } = await createRepo();
  try {
    await runGit(["remote", "add", "origin", "https://github.com/owner/repo.git"], root);
    let resolve!: (value: string) => void, started!: () => void, secondReady!: () => void;
    const ready = new Promise<void>(accept => { started = accept; });
    const registered = new Promise<void>(accept => { secondReady = accept; });
    const originalRead = SharedGitRead.prototype.read;
    let consumers = 0;
    t.mock.method(SharedGitRead.prototype, "read", function(this: SharedGitRead<unknown>, options = {}) {
      const pending = originalRead.call(this, options);
      if (++consumers === 2) secondReady();
      return pending;
    });
    let sharedSignal: AbortSignal | undefined, calls = 0;
    const runner: GhExecute = async (_args, _cwd, options) => {
      calls++; sharedSignal = options.signal; started();
      return new Promise(accept => { resolve = accept; });
    };
    const controller = new AbortController();
    const first = readGitHubRepositoryName(root, runner, { operation: "test", signal: controller.signal });
    const observed = first.then(() => undefined, error => error);
    await ready;
    const second = readGitHubRepositoryName(root, runner, { operation: "test" });
    // 고정 시간 대기 대신 실제 두 번째 소비자 등록을 관찰한다.
    await registered; controller.abort();
    assert.equal((await observed).name, "AbortError");
    assert.equal(sharedSignal?.aborted, false);
    resolve(JSON.stringify({ nameWithOwner: "owner/repo" }));
    assert.equal(await second, "owner/repo"); assert.equal(calls, 1);
  } finally { clearGitHubRepositoryNameCache(); await rm(root, { recursive: true, force: true }); }
});

test("repository names do not survive an authentication or host environment change", async () => {
  clearGitHubRepositoryNameCache();
  const { root } = await createRepo();
  try {
    await runGit(["remote", "add", "origin", "https://github.com/owner/repo.git"], root);
    let calls = 0;
    const runner: GhExecute = async () => JSON.stringify({ nameWithOwner: `owner/repo-${++calls}` });
    for (const env of [ { GH_TOKEN: "fixture-a", GH_HOST: "one.example" },
      { GH_TOKEN: "fixture-b", GH_HOST: "one.example" }, { GH_TOKEN: "fixture-b", GH_HOST: "two.example" } ]) {
      const first = await readGitHubRepositoryName(root, runner, { operation: "test", env });
      assert.equal(await readGitHubRepositoryName(root, runner, { operation: "test", env }), first);
    }
    assert.equal(calls, 3);
  } finally { clearGitHubRepositoryNameCache(); await rm(root, { recursive: true, force: true }); }
});
