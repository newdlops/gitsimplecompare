import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { GhExecute } from "../src/git/ghRunner";
import { fetchPullRequestDetail, type PullRequestDetailInfo } from "../src/git/pullRequestDetail";
import { fetchPullRequestListPage } from "../src/git/pullRequestListService";
import { GitHubReadContextChangedError } from "../src/git/githubReadSession";
import { GitHubReadCache } from "../src/git/githubReadCache";

/** 현재 프로세스 환경을 테스트 동안만 바꾸고 종료 시 없는 변수까지 원래대로 복구한다. */
function environment(t: TestContext, values: NodeJS.ProcessEnv) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
}

/** 실제 설정 파일 관찰 경계를 쓰되 Git/인증 내용은 테스트 fixture 밖에서 읽지 않는다. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "gsc-gh-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git")); await mkdir(join(root, "gh"));
  const config = join(root, ".git/config"), hosts = join(root, "gh/hosts.yml");
  await writeFile(config, "[remote \"origin\"]\nurl = https://github.com/owner/original.git\n");
  await writeFile(hosts, "fixture: original\n");
  environment(t, { GH_REPO: "owner/original", GH_HOST: "original.example", GH_CONFIG_DIR: join(root, "gh") });
  return { root, config, hosts };
}

/** 목록과 ID metadata 조회가 같은 PR을 가리키도록 완전한 원격 node를 만든다. */
function node() {
  return { id: "PR_7", number: 7, title: "Fixture", url: "https://github.com/owner/original/pull/7", state: "OPEN", headRefName: "topic", baseRefName: "main",
    headRefOid: "head", baseRefOid: "base", comments: { totalCount: 0 }, files: { totalCount: 1 },
    commits: { nodes: [{ commit: { oid: "head", messageHeadline: "Change" } }], pageInfo: { hasNextPage: false } },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } };
}

/** 상세의 첫 파일 응답 또는 별도 review 연결을 같은 PR 앵커로 감싼다. */
function detail(threads = false) {
  return JSON.stringify({ data: { repository: { pullRequest: { number: 7, headRefOid: "head", baseRefOid: "base",
    ...(threads ? { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } }
      : { comments: { totalCount: 0 }, files: { totalCount: 1, nodes: [{ path: "a.ts", additions: 1, deletions: 0, changeType: "ADDED" }],
        pageInfo: { hasNextPage: false } } }) } } } });
}

test("PR metadata pages keep the original repository/host environment without extra requests", async t => {
  const f = await fixture(t), seen: Array<[string | undefined, string | undefined]> = [];
  const runner: GhExecute = async (_args, _root, options) => {
    seen.push([options.env?.GH_REPO, options.env?.GH_HOST]);
    if (options.operation === "graph-pr-list-page") {
      process.env.GH_REPO = "owner/replacement"; process.env.GH_HOST = "replacement.example";
      return JSON.stringify({ data: { repository: { nameWithOwner: "owner/original", pullRequests: { nodes: [node()], pageInfo: { hasNextPage: false } } } } });
    }
    return JSON.stringify({ data: { nodes: [node()] } });
  };
  const page = await fetchPullRequestListPage(f.root, undefined, undefined, runner);
  assert.equal(page.repository, "owner/original"); assert.equal(page.pullRequests[0].commitHashesComplete, true);
  assert.deepEqual(seen, [["owner/original", "original.example"], ["owner/original", "original.example"]]);
});

test("progressive PR files and review requests use one captured environment", async t => {
  const f = await fixture(t), seen: Array<string | undefined> = [];
  const result = await fetchPullRequestDetail(f.root, "owner/original", 7, undefined, async (_args, _root, options) => {
    seen.push(options.env?.GH_REPO);
    process.env.GH_REPO = "owner/replacement";
    return detail(options.operation === "pr-detail-threads");
  }, () => {});
  assert.equal(result.files.length, 1); assert.deepEqual(seen, ["owner/original", "owner/original"]);
});

test("a credential introduced after the first page cannot enter the captured PR session through the shared cache", async t => {
  const f = await fixture(t), previous = process.env.GH_TOKEN;
  delete process.env.GH_TOKEN;
  t.after(() => { if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous; });
  const seen: Array<string | undefined> = [];
  const cache = new GitHubReadCache(async (_args, _root, options) => {
    seen.push(options.env?.GH_TOKEN);
    if (options.operation === "graph-pr-list-page") {
      process.env.GH_TOKEN = "fixture-new-credential";
      return JSON.stringify({ data: { repository: { nameWithOwner: "owner/original", pullRequests: { nodes: [node()], pageInfo: { hasNextPage: false } } } } });
    }
    return JSON.stringify({ data: { nodes: [node()] } });
  });
  t.after(() => cache.dispose());
  const result = await fetchPullRequestListPage(f.root, undefined, undefined,
    (args, cwd, options) => cache.read(args, cwd, options));
  assert.equal(result.pullRequests[0].commitHashesComplete, true);
  assert.deepEqual(seen, [undefined, undefined], "every page must keep the original absence of GH_TOKEN");
});

for (const kind of ["repository", "authentication"] as const) {
  test(`PR metadata rejects an ${kind} switch instead of publishing a completed mixed list`, async t => {
    const f = await fixture(t); let calls = 0;
    await assert.rejects(fetchPullRequestListPage(f.root, undefined, undefined, async () => {
      calls++; await writeFile(kind === "repository" ? f.config : f.hosts, "fixture: changed\n");
      return JSON.stringify({ data: { repository: { nameWithOwner: "owner/original", pullRequests: { nodes: [node()], pageInfo: { hasNextPage: false } } } } });
    }), GitHubReadContextChangedError);
    assert.equal(calls, 1, "changed context must stop before metadata fan-out");
  });
}

test("an authentication switch in the review phase is fatal rather than a reusable file-only success", async t => {
  const f = await fixture(t), progress: PullRequestDetailInfo[] = [];
  await assert.rejects(fetchPullRequestDetail(f.root, "owner/original", 7, undefined, async (_args, _root, options) => {
    if (options.operation === "pr-detail-threads") await writeFile(f.hosts, "fixture: switched-account\n");
    return detail(options.operation === "pr-detail-threads");
  }, value => progress.push(value)), GitHubReadContextChangedError);
  assert.ok(progress.length > 0);
  assert.ok(progress.every(value => value.reviewThreadsLoading === true));
});
