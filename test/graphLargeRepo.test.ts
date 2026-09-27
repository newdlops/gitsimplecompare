import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  hasCommitGraph,
  isCommitGraphOfferSuppressed,
  suppressCommitGraphOffer,
  writeCommitGraph,
} from "../src/git/commitGraphStatus";
import { runGit } from "../src/git/gitExec";
import { GitLogService } from "../src/git/gitLogService";
import { parseRemoteBranchTips } from "../src/git/graphBranchCatalog";
import { COMMIT_GRAPH_OFFER_MIN_LOG_MS, shouldConsiderCommitGraphOffer } from "../src/ui/commitGraphOffer";
import { graphPageRange, graphPageSkipReason, readGraphPageData } from "../src/webview/graphPageLoading";
import { graphInvalidationPlan } from "../src/webview/graphRefreshCoordinator";

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

/** 커밋 몇 개와 원격 추적 ref 가 있는 격리 저장소를 만든다. */
async function createRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-graph-large-"));
  await runGit(["init", "--quiet", "--initial-branch=main"], root);
  await runGit(["config", "user.name", "Graph Test"], root);
  await runGit(["config", "user.email", "graph@example.com"], root);
  await runGit(["config", "commit.gpgSign", "false"], root);
  return root;
}

/** 파일 하나를 바꿔 커밋하고 hash 를 돌려준다. */
async function commit(root: string, message: string): Promise<string> {
  await writeFile(path.join(root, "file.txt"), `${message}\n`);
  await runGit(["add", "file.txt"], root);
  await runGit(["commit", "--quiet", "-m", message], root);
  return (await runGit(["rev-parse", "HEAD"], root)).trim();
}

test("숨김/포커스 해제는 화면의 그래프와 PR 조회를 보존하고, 저장소 교체·새 reload 는 모두 버린다", () => {
  assert.deepEqual(graphInvalidationPlan("hidden"), { keepLoadedGraph: true, cancelPullRequests: false });
  assert.deepEqual(graphInvalidationPlan("windowUnfocused"), { keepLoadedGraph: true, cancelPullRequests: false });
  for (const reason of ["repositoryChanged", "directSupersede", "dispose"]) {
    assert.deepEqual(graphInvalidationPlan(reason), { keepLoadedGraph: false, cancelPullRequests: true });
  }
});

test("페이지 계획은 이미 읽는 중·더 새/오래된 커밋 없음을 건너뛰고 older/newer 구간을 계산한다", () => {
  const cursor = { reset: false, direction: "older" as const, loading: false, exhausted: false, rangeStartIndex: 0 };
  assert.equal(graphPageSkipReason({ ...cursor, loading: true }), "alreadyLoading");
  assert.equal(graphPageSkipReason({ ...cursor, direction: "newer" }), "noNewerCommits");
  assert.equal(graphPageSkipReason({ ...cursor, exhausted: true }), "noMoreCommits");
  assert.equal(graphPageSkipReason({ ...cursor, exhausted: true, reset: true }), undefined);
  assert.deepEqual(graphPageRange("older", 600, 300, 300), { skip: 900, readLimit: 301 });
  assert.deepEqual(graphPageRange("newer", 450, 300, 300), { skip: 150, readLimit: 300 });
  assert.deepEqual(graphPageRange("newer", 120, 300, 300), { skip: 0, readLimit: 120 });
});

test("첫 페이지는 작업트리 status 와 git log 를 동시에 시작해 둘 다 끝난 뒤 돌려준다", async () => {
  const started: string[] = [];
  let releaseStatus!: () => void;
  let releaseLog!: () => void;
  const service = {
    getVirtualCommits: () => {
      started.push("status");
      return new Promise<never[]>((resolve) => { releaseStatus = () => resolve([]); });
    },
    getCommitPage: () => {
      started.push("log");
      return new Promise<Array<{ hash: string }>>((resolve) => { releaseLog = () => resolve([{ hash: "a" }]); });
    },
  };
  const read = readGraphPageData(service as never, { skip: 0, readLimit: 301, refs: [], readVirtualCommits: true });
  await Promise.resolve();
  assert.deepEqual(started.sort(), ["log", "status"], "status 가 git log 를 막지 않는다");
  releaseLog();
  releaseStatus();
  const result = await read;
  assert.deepEqual(result.virtualCommits, []);
  assert.equal(result.page.length, 1);
  assert.ok(result.gitLogMs >= 0);
});

test("local-only 표시는 바뀐 커밋 수만 세고, 계산을 마친 결과는 게시 전에 바로 붙는다", async () => {
  const root = await createRepo();
  try {
    const base = await commit(root, "base");
    await runGit(["update-ref", "refs/remotes/origin/main", base], root);
    await runGit(["config", "branch.main.remote", "origin"], root);
    await runGit(["config", "branch.main.merge", "refs/heads/main"], root);
    const local = await commit(root, "local work");

    const service = new GitLogService(root);
    const snapshot = await service.getLocalBranchSnapshot();
    const remoteTips = parseRemoteBranchTips(await runGit(
      ["for-each-ref", "--format=%(objectname)\x1f%(refname:short)\x1f%(refname)", "refs/remotes"], root
    ));
    service.seedGraphBranchTips(snapshot.branches, remoteTips);
    const commits = await service.getCommitPage(10, 0, [], false);
    assert.equal(service.applyWarmLocalOnlyBranches(commits), false, "계산 전에는 기다리지 않는다");

    assert.equal(await service.attachLocalOnlyBranches(commits), 1);
    assert.deepEqual(commits.find((item) => item.hash === local)?.localOnlyBranches, ["main"]);
    assert.equal(await service.attachLocalOnlyBranches(commits), 0, "이미 표시된 페이지는 다시 게시할 필요가 없다");

    const nextPage = await service.getCommitPage(10, 0, [], false);
    assert.equal(service.applyWarmLocalOnlyBranches(nextPage), true);
    assert.deepEqual(nextPage.find((item) => item.hash === local)?.localOnlyBranches, ["main"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("명시 ref 범위는 stdin 으로 넘겨도 argv 와 같은 커밋을 돌려준다", async () => {
  const root = await createRepo();
  try {
    await commit(root, "base");
    await runGit(["checkout", "--quiet", "-b", "a"], root);
    const onA = await commit(root, "on a");
    await runGit(["checkout", "--quiet", "main"], root);
    await runGit(["checkout", "--quiet", "-b", "b"], root);
    const onB = await commit(root, "on b");
    await runGit(["checkout", "--quiet", "main"], root);
    const onMain = await commit(root, "on main");

    const service = new GitLogService(root);
    const filtered = (await service.getCommitPage(20, 0, ["refs/heads/a", "refs/heads/b"], false)).map((item) => item.hash);
    assert.ok(filtered.includes(onA) && filtered.includes(onB));
    assert.ok(!filtered.includes(onMain), "선택하지 않은 브랜치 커밋은 포함하지 않는다");
    const all = (await service.getCommitPage(20, 0, [], false)).map((item) => item.hash);
    assert.ok(all.includes(onMain) && all.includes(onA) && all.includes(onB));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commit-graph 제안은 느릴 때만 검토하고, 생성·억제는 저장소 로컬 상태로 확인된다", async () => {
  assert.equal(shouldConsiderCommitGraphOffer(COMMIT_GRAPH_OFFER_MIN_LOG_MS - 1, false), false);
  assert.equal(shouldConsiderCommitGraphOffer(COMMIT_GRAPH_OFFER_MIN_LOG_MS, false), true);
  assert.equal(shouldConsiderCommitGraphOffer(5000, true), false, "세션당 저장소 한 번만 검토한다");

  const root = await createRepo();
  try {
    await commit(root, "base");
    await commit(root, "second");
    assert.equal(await hasCommitGraph(root), false);
    await writeCommitGraph(root);
    assert.equal(await hasCommitGraph(root), true);

    assert.equal(await isCommitGraphOfferSuppressed(root), false);
    await suppressCommitGraphOffer(root);
    assert.equal(await isCommitGraphOfferSuppressed(root), true);
    await runGit(["config", "--unset", "gitsimplecompare.offerCommitGraph"], root);
    await runGit(["config", "core.commitGraph", "false"], root);
    assert.equal(await isCommitGraphOfferSuppressed(root), true, "core.commitGraph=false 인 저장소에는 제안하지 않는다");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
