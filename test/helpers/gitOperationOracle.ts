// 제품의 cache·성공 알림·Graph 모델과 독립된 Native Git으로 작업 자체의 완료를 검증한다.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export const GIT_OPERATION_NAMES = ["initial", "push", "push-tracked", "pull", "pull-new-history", "pull-known-history",
  "fetch", "fetch-new-history", "fetch-known-history", "fetch-no-change", "rebase", "merge", "merge-no-ff",
  "pr-squash-cherry-pick", "pr-cherry-pick", "cherry-pick", "checkout", "checkout-unloaded"] as const;
export type GitOperationName = typeof GIT_OPERATION_NAMES[number];

/** 테스트가 소유한 저장소와 준비 단계에서 확정한 불변 commit ID다. */
export interface GitOperationExpectation {
  root: string; remote: string; main: string; mainBranch: string; topic: string;
  pr: string; prCommits: string[]; incoming: string; incomingPull: string;
}

/**
 * 제품 실행기를 거치지 않아 검증용 object 생성이 Graph mutation 알림이나 측정에 섞이지 않게 한다.
 * @param root 소유 fixture 또는 private bare 원격 @param args 검증용 Native 인자
 * @returns 앞뒤 공백을 제거한 출력. 오류·시간 제한·불완전 출력은 성공으로 바꾸지 않는다.
 */
async function native(root: string, ...args: string[]): Promise<string> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"])
    delete (env as NodeJS.ProcessEnv)[key];
  const { stdout } = await execute("git", ["-c", "core.fsmonitor=false", ...args], { cwd: root, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * 원래 입력에서 기대하는 HEAD/tree/부모·원격 목적 ref를 확인해 no-op·부분 push를 완료로 세지 않는다.
 * @param fixture 실제 작업과 같은 불변 입력 @param operation 실행한 시나리오
 * @param checkoutTarget checkout의 준비 단계에서 확정한 branch @param refsBefore 무변경 fetch 직전 Native ref 원문
 * @param expectedBranch 작업 후 유지·전환해야 하는 branch. 같은 tree를 가진 잘못된 branch checkout도 거부한다.
 * @returns 모든 의미 검증이 통과하면 완료한다. Graph 일치 여부와 별도로 반드시 호출한다.
 */
export async function verifyGitOperationResult(fixture: GitOperationExpectation, operation: GitOperationName,
  checkoutTarget?: string, refsBefore?: string, expectedBranch?: string): Promise<void> {
  assert.ok((GIT_OPERATION_NAMES as readonly string[]).includes(operation), "Unsupported operation oracle scenario");
  const git = (...args: string[]) => native(fixture.root, ...args);
  if (expectedBranch) assert.equal(await git("symbolic-ref", "--short", "HEAD"), expectedBranch,
    "The operation left a different checked-out branch");
  const head = await git("rev-parse", "HEAD"); assert.match(head, OID);
  const tree = await git("rev-parse", "HEAD^{tree}");
  const parents = (await git("show", "-s", "--format=%P", "HEAD")).split(" ").filter(Boolean);
  let expectedTree: string | undefined;
  if (operation === "push" || operation === "push-tracked") {
    assert.equal(head, fixture.pr, "Push must preserve the source HEAD");
    assert.equal(await native(fixture.remote, "rev-parse", `refs/heads/bench-${operation}`), fixture.pr,
      "A partial or cancelled push did not reach the required receiver HEAD");
    expectedTree = await git("rev-parse", `${fixture.pr}^{tree}`);
  } else if (operation.startsWith("pull")) {
    const target = operation === "pull-new-history" ? fixture.incomingPull : fixture.incoming;
    assert.equal(head, target, "Pull must install the prepared incoming commit");
    expectedTree = await git("rev-parse", `${target}^{tree}`);
  } else if (operation.startsWith("fetch")) {
    assert.equal(head, fixture.main, "Fetch must preserve the checked-out HEAD");
    if (operation === "fetch" || operation === "fetch-new-history")
      assert.equal(await git("rev-parse", "refs/remotes/origin/incoming"), fixture.incoming);
    if (operation === "fetch-known-history") assert.equal(await git("rev-parse", "refs/remotes/origin/known-history"), fixture.main);
    if (operation === "fetch-no-change") {
      assert.notEqual(refsBefore, undefined);
      assert.equal(await git("for-each-ref", "--format=%(refname) %(objectname)"), refsBefore?.trim(), "An unchanged fetch must preserve every ref");
    }
  } else if (operation === "merge" || operation === "merge-no-ff" || operation === "rebase") {
    expectedTree = (await git("merge-tree", "--write-tree", fixture.main, fixture.topic)).split("\n")[0];
    assert.match(expectedTree, OID);
    if (operation === "merge") assert.deepEqual(parents, [fixture.main]);
    if (operation === "merge-no-ff") assert.deepEqual(parents, [fixture.main, fixture.topic]);
    if (operation === "rebase") await git("merge-base", "--is-ancestor", fixture.topic, head);
  } else if (operation === "pr-squash-cherry-pick" || operation === "pr-cherry-pick" || operation === "cherry-pick") {
    const squash = operation === "pr-squash-cherry-pick", single = operation === "cherry-pick";
    expectedTree = await git("rev-parse", `${single ? fixture.prCommits[0] : fixture.pr}^{tree}`);
    assert.equal(await git("rev-list", "--count", `${fixture.main}..HEAD`), squash || single ? "1" : "3");
    const first = (await git("rev-list", "--reverse", `${fixture.main}..HEAD`)).split("\n")[0];
    assert.equal(await git("rev-parse", `${first}^`), fixture.main);
    if (!squash && !single) assert.equal(await git("log", "--reverse", "--format=%B", "-z", `${fixture.main}..HEAD`),
      await git("log", "--reverse", "--format=%B", "-z", `${fixture.main}..${fixture.pr}`), "PR replay must preserve the original messages");
  } else if (operation === "checkout" || operation === "checkout-unloaded") {
    assert.ok(checkoutTarget);
    assert.equal(await git("symbolic-ref", "--short", "HEAD"), checkoutTarget);
    assert.equal(head, await git("rev-parse", `${checkoutTarget}^{commit}`));
  } else assert.equal(head, fixture.main);
  if (expectedTree) assert.equal(tree, expectedTree, `${operation} produced a different Native tree`);
  assert.equal(await git("status", "--porcelain=v1", "--untracked-files=all"), "", `${operation} left unexpected working changes`);
}
