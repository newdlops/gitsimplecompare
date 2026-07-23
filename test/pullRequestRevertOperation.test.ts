import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { runGitWithInput } from "../src/git/gitExec";
import { PullRequestOperationService } from "../src/git/pullRequestOperationService";
import type { PullRequestInfo } from "../src/git/pullRequestInfo";
import {
  PullRequestRevertPlanService,
  materializedRefForPullRequest,
} from "../src/git/pullRequestRevertPlan";

const execFileAsync = promisify(execFile);

/** 테스트 Git 프로세스가 사용자 환경의 editor/hook/fsmonitor에 영향받지 않게 실행한다. */
async function git(repoRoot: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync(
    "git",
    ["-c", "core.fsmonitor=false", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: "true",
        HUSKY: "0",
      },
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  return result.stdout.trim();
}

/**
 * 독립된 실제 Git 저장소를 만들고 main 첫 commit과 사용자 identity를 준비한다.
 * @param t 테스트 종료 시 임시 저장소를 정리할 Node test context
 */
async function createRepository(t: TestContext): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "gsc-pr-revert-test-"));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await git(repoRoot, "init", "-q", "-b", "main");
  await git(repoRoot, "config", "user.name", "PR Revert Test");
  await git(repoRoot, "config", "user.email", "pr-revert@example.com");
  await git(repoRoot, "config", "commit.gpgsign", "false");
  await writeFile(join(repoRoot, "shared.txt"), "header\ntarget=old\nfooter\n", "utf8");
  await writeFile(join(repoRoot, "unrelated.txt"), "clean\n", "utf8");
  await git(repoRoot, "add", "shared.txt", "unrelated.txt");
  await git(repoRoot, "commit", "-q", "-m", "base");
  return repoRoot;
}

/**
 * PullRequestInfo의 필수 UI 필드를 기본값으로 채우고 Git 관련 값만 테스트가 지정하게 한다.
 * @param input PR 번호·상태·commit OID
 */
function pullRequest(input: {
  number?: number;
  state?: string;
  headHash?: string;
  mergeHash?: string;
  commitHashes?: string[];
}): PullRequestInfo {
  return {
    number: input.number ?? 42,
    title: "Test pull request",
    state: input.state ?? "OPEN",
    url: "https://example.invalid/pull/42",
    headRefName: "feature/test",
    headHash: input.headHash,
    baseRefName: "main",
    mergeHash: input.mergeHash,
    author: "tester",
    isDraft: false,
    commentCount: 0,
    fileCount: 1,
    commitHashes: input.commitHashes ?? [],
  };
}

/**
 * main과 갈라진 feature commit을 만든 뒤 다시 main으로 돌아온다.
 * @param repoRoot 테스트 저장소
 * @param content feature가 shared.txt에 기록할 내용
 */
async function createFeatureCommit(
  repoRoot: string,
  content = "header\ntarget=new\nfooter\n"
): Promise<{ base: string; feature: string }> {
  const base = await git(repoRoot, "rev-parse", "HEAD");
  await git(repoRoot, "switch", "-q", "-c", "feature/test");
  await writeFile(join(repoRoot, "shared.txt"), content, "utf8");
  await git(repoRoot, "add", "shared.txt");
  await git(repoRoot, "commit", "-q", "-m", "feature");
  const feature = await git(repoRoot, "rev-parse", "HEAD");
  await git(repoRoot, "switch", "-q", "main");
  return { base, feature };
}

/**
 * main에서 갈라져 서로 다른 파일을 추가하는 선형 PR commit 두 개를 만든다.
 * @param repoRoot 테스트 저장소
 * @returns PR 첫 commit과 head commit
 */
async function createTwoCommitFeature(
  repoRoot: string
): Promise<{ first: string; head: string }> {
  await git(repoRoot, "switch", "-q", "-c", "feature/two-commits");
  await writeFile(join(repoRoot, "first.txt"), "first PR change\n", "utf8");
  await git(repoRoot, "add", "first.txt");
  await git(repoRoot, "commit", "-q", "-m", "first PR commit");
  const first = await git(repoRoot, "rev-parse", "HEAD");
  await writeFile(join(repoRoot, "second.txt"), "second PR change\n", "utf8");
  await git(repoRoot, "add", "second.txt");
  await git(repoRoot, "commit", "-q", "-m", "second PR commit");
  const head = await git(repoRoot, "rev-parse", "HEAD");
  await git(repoRoot, "switch", "-q", "main");
  return { first, head };
}

/**
 * target clone에는 없는 PR head를 bare origin의 refs/pull namespace에만 준비한다.
 * clone을 먼저 만든 뒤 PR commit을 push해 local clone 최적화로 object가 섞이지 않게 한다.
 */
async function createMissingPullRefFixture(t: TestContext): Promise<{
  target: string;
  pullHead: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "gsc-pr-ref-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "origin.git");
  const seed = join(root, "seed");
  const target = join(root, "target");
  await mkdir(seed);
  await git(root, "init", "-q", "--bare", remote);
  await git(seed, "init", "-q", "-b", "main");
  await git(seed, "config", "user.name", "PR Ref Seed");
  await git(seed, "config", "user.email", "pr-ref@example.com");
  await writeFile(join(seed, "feature.txt"), "base\n", "utf8");
  await git(seed, "add", "feature.txt");
  await git(seed, "commit", "-q", "-m", "base");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-q", "-u", "origin", "main");
  await git(root, "clone", "-q", "--no-local", "--branch", "main", remote, target);
  await git(target, "config", "user.name", "PR Ref Target");
  await git(target, "config", "user.email", "pr-ref-target@example.com");
  await git(seed, "switch", "-q", "-c", "deleted-feature");
  await writeFile(join(seed, "feature.txt"), "from pull ref\n", "utf8");
  await git(seed, "add", "feature.txt");
  await git(seed, "commit", "-q", "-m", "pull request head");
  const pullHead = await git(seed, "rev-parse", "HEAD");
  await git(seed, "push", "-q", "origin", `HEAD:refs/pull/42/head`);
  return { target, pullHead };
}

test("PR commit materialize 후 기존 확장 ref를 조건부로 복원한다", async (t) => {
  const { target, pullHead } = await createMissingPullRefFixture(t);
  await assert.rejects(git(target, "cat-file", "-e", `${pullHead}^{commit}`));
  const materializedRef = materializedRefForPullRequest(42);
  const previousHead = await git(target, "rev-parse", "HEAD");
  await git(target, "update-ref", materializedRef, previousHead);
  const service = new PullRequestRevertPlanService(target);
  const plan = await service.prepare(
    pullRequest({ headHash: pullHead, commitHashes: [pullHead] }),
    "squashRevert"
  );

  assert.equal(plan.targetKind, "originalCommits");
  assert.equal(plan.materialized, true);
  assert.equal(plan.commits[0]?.hash, pullHead);
  assert.equal(plan.outsideCurrentBranch, 1);
  assert.equal(plan.materializedPreviousHead, previousHead);
  assert.equal(await git(target, "rev-parse", materializedRef), pullHead);

  assert.equal(await service.release(plan), true);
  assert.equal(await git(target, "rev-parse", materializedRef), previousHead);
});

test("원격 pull ref도 없으면 누락 object를 정상 계획으로 숨기지 않는다", async (t) => {
  const repoRoot = await createRepository(t);
  const missing = "2".repeat(40);
  const service = new PullRequestRevertPlanService(repoRoot);

  await assert.rejects(
    service.prepare(
      pullRequest({ headHash: missing, commitHashes: [missing] }),
      "squashRevert"
    ),
    /commit objects are not available locally.*could not be fetched from origin/
  );
  await assert.rejects(
    git(
      repoRoot,
      "show-ref",
      "--verify",
      materializedRefForPullRequest(42)
    )
  );
});

test("현재 이력의 squash merge 결과를 누락 원본 commit보다 우선한다", async (t) => {
  const repoRoot = await createRepository(t);
  await writeFile(
    join(repoRoot, "shared.txt"),
    "header\ntarget=landed\nfooter\n",
    "utf8"
  );
  await git(repoRoot, "add", "shared.txt");
  await git(repoRoot, "commit", "-q", "-m", "squash merged result");
  const mergeHash = await git(repoRoot, "rev-parse", "HEAD");
  const missing = "1".repeat(40);
  const plan = await new PullRequestRevertPlanService(repoRoot).prepare(
    pullRequest({
      state: "MERGED",
      headHash: missing,
      mergeHash,
      commitHashes: [missing],
    }),
    "squashRevert"
  );

  assert.equal(plan.targetKind, "mergedResult");
  assert.equal(plan.materialized, false);
  assert.deepEqual(plan.commits, [{ hash: mergeHash, mainline: undefined }]);
  assert.equal(plan.outsideCurrentBranch, 0);
});

test("실제 merge commit은 첫 부모 mainline으로 Squash Revert한다", async (t) => {
  const repoRoot = await createRepository(t);
  const { feature } = await createFeatureCommit(repoRoot);
  await writeFile(join(repoRoot, "main-only.txt"), "main\n", "utf8");
  await git(repoRoot, "add", "main-only.txt");
  await git(repoRoot, "commit", "-q", "-m", "main work");
  await git(repoRoot, "merge", "-q", "--no-ff", "feature/test", "-m", "merge PR");
  const mergeHash = await git(repoRoot, "rev-parse", "HEAD");
  const parents = (await git(repoRoot, "show", "-s", "--format=%P", mergeHash)).split(/\s+/);
  assert.equal(parents.length, 2);
  const pr = pullRequest({
    state: "MERGED",
    headHash: feature,
    mergeHash,
    commitHashes: [feature],
  });
  const service = new PullRequestOperationService(repoRoot);
  const plan = await service.preparePullRequestRevert(pr, "squashRevert");
  assert.equal(plan.commits[0]?.mainline, 1);

  const result = await service.squashRevertPullRequest(pr, undefined, plan);

  assert.equal(result.status, "completed");
  assert.equal(
    await readFile(join(repoRoot, "shared.txt"), "utf8"),
    "header\ntarget=old\nfooter\n"
  );
  assert.equal(await readFile(join(repoRoot, "main-only.txt"), "utf8"), "main\n");
});

test("다중 commit squash merge는 전체 patch가 같은 mergeHash 하나를 되돌린다", async (t) => {
  const repoRoot = await createRepository(t);
  const { first, head } = await createTwoCommitFeature(repoRoot);
  await writeFile(join(repoRoot, "main-only.txt"), "main stays\n", "utf8");
  await git(repoRoot, "add", "main-only.txt");
  await git(repoRoot, "commit", "-q", "-m", "main work");
  await git(repoRoot, "merge", "-q", "--squash", "feature/two-commits");
  await git(repoRoot, "commit", "-q", "-m", "squash PR");
  const mergeHash = await git(repoRoot, "rev-parse", "HEAD");
  const pr = pullRequest({
    state: "MERGED",
    headHash: head,
    mergeHash,
    commitHashes: [first, head],
  });
  const service = new PullRequestOperationService(repoRoot);
  const plan = await service.preparePullRequestRevert(pr, "squashRevert");

  assert.equal(plan.targetKind, "mergedResult");
  assert.deepEqual(plan.commits, [{ hash: mergeHash, mainline: undefined }]);
  const result = await service.squashRevertPullRequest(pr, undefined, plan);

  assert.equal(result.status, "completed");
  await assert.rejects(readFile(join(repoRoot, "first.txt"), "utf8"));
  await assert.rejects(readFile(join(repoRoot, "second.txt"), "utf8"));
  assert.equal(
    await readFile(join(repoRoot, "main-only.txt"), "utf8"),
    "main stays\n"
  );
});

test("다중 commit rebase merge의 마지막 mergeHash만 되돌리지 않는다", async (t) => {
  const repoRoot = await createRepository(t);
  const { first, head } = await createTwoCommitFeature(repoRoot);
  await writeFile(join(repoRoot, "main-only.txt"), "main stays\n", "utf8");
  await git(repoRoot, "add", "main-only.txt");
  await git(repoRoot, "commit", "-q", "-m", "advance main");
  await git(repoRoot, "cherry-pick", first, head);
  const mergeHash = await git(repoRoot, "rev-parse", "HEAD");
  assert.notEqual(mergeHash, head);
  const pr = pullRequest({
    state: "MERGED",
    headHash: head,
    mergeHash,
    commitHashes: [first, head],
  });
  const service = new PullRequestOperationService(repoRoot);
  const plan = await service.preparePullRequestRevert(pr, "squashRevert");

  assert.equal(plan.targetKind, "originalCommits");
  assert.deepEqual(
    plan.commits.map((commit) => commit.hash),
    [head, first]
  );
  const result = await service.squashRevertPullRequest(pr, undefined, plan);

  assert.equal(result.status, "completed");
  await assert.rejects(readFile(join(repoRoot, "first.txt"), "utf8"));
  await assert.rejects(readFile(join(repoRoot, "second.txt"), "utf8"));
  assert.equal(
    await readFile(join(repoRoot, "main-only.txt"), "utf8"),
    "main stays\n"
  );
});

test("raw reverse patch가 context drift로 실패해도 commit별 revert는 성공한다", async (t) => {
  const repoRoot = await createRepository(t);
  await writeFile(
    join(repoRoot, "shared.txt"),
    "context-one\ncontext-two\ncontext-three\ntarget=old\nfooter-one\nfooter-two\nfooter-three\n",
    "utf8"
  );
  await git(repoRoot, "add", "shared.txt");
  await git(repoRoot, "commit", "-q", "--amend", "--no-edit");
  const { base, feature } = await createFeatureCommit(
    repoRoot,
    "context-one\ncontext-two\ncontext-three\ntarget=new\nfooter-one\nfooter-two\nfooter-three\n"
  );
  await writeFile(join(repoRoot, "main-only.txt"), "main divergence\n", "utf8");
  await git(repoRoot, "add", "main-only.txt");
  await git(repoRoot, "commit", "-q", "-m", "diverge main");
  await git(repoRoot, "cherry-pick", feature);
  await writeFile(
    join(repoRoot, "shared.txt"),
    "changed-context\ncontext-two\ncontext-three\ntarget=new\nfooter-one\nfooter-two\nfooter-three\n",
    "utf8"
  );
  await git(repoRoot, "add", "shared.txt");
  await git(repoRoot, "commit", "-q", "-m", "context drift");
  const reversePatch = await git(repoRoot, "diff", feature, base);
  await assert.rejects(
    runGitWithInput(
      ["apply", "--check"],
      repoRoot,
      `${reversePatch}\n`
    )
  );
  const pr = pullRequest({
    headHash: feature,
    commitHashes: [feature],
  });

  const result = await new PullRequestOperationService(
    repoRoot
  ).squashRevertPullRequest(pr);

  assert.equal(result.status, "completed");
  assert.equal(
    await readFile(join(repoRoot, "shared.txt"), "utf8"),
    "changed-context\ncontext-two\ncontext-three\ntarget=old\nfooter-one\nfooter-two\nfooter-three\n"
  );
});

test("staged 사용자 변경을 revert commit에 섞지 않고 작업트리에 보존한다", async (t) => {
  const repoRoot = await createRepository(t);
  const { feature } = await createFeatureCommit(repoRoot);
  await git(repoRoot, "merge", "-q", "--ff-only", "feature/test");
  await writeFile(join(repoRoot, "unrelated.txt"), "user staged change\n", "utf8");
  await git(repoRoot, "add", "unrelated.txt");
  const beforeStatus = await git(repoRoot, "status", "--short");
  assert.match(beforeStatus, /^M  unrelated\.txt$/m);
  const pr = pullRequest({
    headHash: feature,
    commitHashes: [feature],
  });

  const result = await new PullRequestOperationService(
    repoRoot
  ).squashRevertPullRequest(pr);

  assert.equal(result.status, "completed");
  assert.equal(
    await git(repoRoot, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"),
    "shared.txt"
  );
  assert.equal(
    await readFile(join(repoRoot, "unrelated.txt"), "utf8"),
    "user staged change\n"
  );
  assert.notEqual(
    await git(repoRoot, "status", "--short", "--", "unrelated.txt"),
    ""
  );
});
