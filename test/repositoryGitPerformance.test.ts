import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { GitServiceRegistry } from "../src/git/serviceRegistry";
import { setGitExecutionObserver, type GitExecutionTiming } from "../src/git/gitExecutionDiagnostics";
import { pushCurrentWithAutoUpstream } from "../src/git/pushService";
import { addOrigin, git, safetyFixture } from "./helpers/gitSafetyFixture";

/**
 * 현재 production 경로가 완료한 실제 Git 프로세스만 기록한다.
 * @param operation 검증할 저장소 조회 또는 전송 @returns 결과와 민감한 값 없는 실행 계측
 */
async function observed<T>(operation: () => Promise<T>) {
  const calls: GitExecutionTiming[] = [];
  const dispose = setGitExecutionObserver(call => calls.push(call));
  try { return { result: await operation(), calls }; }
  finally { dispose(); }
}

/**
 * 지연된 이전 결과가 현재 세대의 캐시를 덮어쓰는지 결정적으로 검사할 Promise다.
 * @returns Promise와 외부 완료 함수. 시간 기반 sleep은 사용하지 않는다.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("concurrent cold root and branch discovery shares one Git read", async t => {
  const f = await safetyFixture(t, "discovery-performance");
  const root = await realpath(f.root);
  const registry = new GitServiceRegistry();
  const { result, calls } = await observed(() => Promise.all(Array.from({ length: 10 }, (_, index) =>
    index % 2 ? registry.resolveWithBranch(root) : registry.resolve(root))));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "rev-parse");
  for (const value of result) {
    assert.ok(value);
    assert.equal("service" in value ? value.service.repoRoot : value.repoRoot, root);
    if ("branch" in value) assert.equal(value.branch, "main");
  }
});

test("clone or init invalidation prevents an old negative result from warming the new cache", async () => {
  const old = deferred<undefined>(), started = deferred<void>();
  let reads = 0;
  const registry = new GitServiceRegistry(async () => {
    if (++reads === 1) { started.resolve(); return old.promise; }
    return { root: "/new-repository", branch: "main" };
  });
  const first = registry.resolve("/new-repository");
  await started.promise;
  registry.invalidateResolveCache();
  const fresh = await registry.resolveWithBranch("/new-repository");
  assert.equal(fresh?.service.repoRoot, "/new-repository");
  old.resolve(undefined); await first;
  assert.equal((await registry.resolve("/new-repository"))?.repoRoot, "/new-repository");
  assert.equal(reads, 2);
});

test("completion of an old discovery cannot remove the new generation's pending read", async () => {
  const old = deferred<undefined>(), fresh = deferred<{ root: string; branch: string }>();
  const started = [deferred<void>(), deferred<void>()];
  let reads = 0;
  const registry = new GitServiceRegistry(async () => {
    const index = reads++; started[index]?.resolve();
    return index === 0 ? old.promise : fresh.promise;
  });
  const first = registry.resolve("/repository"); await started[0].promise;
  registry.invalidateResolveCache();
  const second = registry.resolveWithBranch("/repository"); await started[1].promise;
  old.resolve(undefined); await first;
  const third = registry.resolve("/repository");
  fresh.resolve({ root: "/repository", branch: "main" });
  assert.equal((await second)?.branch, "main");
  assert.equal((await third)?.repoRoot, "/repository");
  assert.equal(reads, 2);
});

test("a failed discovery releases its pending slot for a new attempt", async () => {
  let reads = 0;
  const registry = new GitServiceRegistry(async () => {
    if (++reads === 1) throw new Error("temporary discovery failure");
    return { root: "/repository", branch: "main" };
  });
  await assert.rejects(registry.resolve("/repository"), /temporary discovery failure/);
  assert.equal((await registry.resolveWithBranch("/repository"))?.branch, "main");
  assert.equal(reads, 2);
});

test("a warm root cache still reads the current branch after checkout", async t => {
  const f = await safetyFixture(t, "discovery-fresh-branch");
  const registry = new GitServiceRegistry();
  assert.equal((await registry.resolveWithBranch(f.root))?.branch, "main");
  await git(f.root, "switch", "-qc", "next");
  assert.equal((await registry.resolveWithBranch(f.root))?.branch, "next");
});

test("shared discovery preserves repository paths containing newlines and separate nested repositories", { skip: process.platform === "win32" }, async t => {
  const f = await safetyFixture(t, "discovery-path-boundaries");
  const root = await realpath(f.root);
  const nested = path.join(root, "line\nbreak"); await mkdir(nested);
  await git(nested, "-c", "init.templateDir=", "init", "-q", "--initial-branch=main");
  await git(nested, "-c", "user.name=Discovery Test", "-c", "user.email=discovery@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "commit", "--allow-empty", "-qm", "nested");
  const registry = new GitServiceRegistry();
  assert.equal((await registry.resolve(root))?.repoRoot, root);
  assert.equal((await registry.resolve(nested))?.repoRoot, nested);
  const identity = await registry.resolveWithBranch(nested);
  assert.equal(identity?.service.repoRoot, nested);
  assert.equal(identity?.branch, "main");
});

test("sequential push keeps a linear, small read budget without repeating full target planning", async t => {
  const f = await safetyFixture(t, "push-read-budget");
  const remote = await addOrigin(f.root, f.directory);
  const commits = 8;
  for (let index = 0; index < commits; index++) await git(f.root, "commit", "--allow-empty", "-qm", "outgoing " + index);
  const { result, calls } = await observed(() => pushCurrentWithAutoUpstream(f.root, undefined, { sequentialThresholdBytes: 0 }));
  assert.equal(result.execution?.completed, commits);
  assert.equal(calls.filter(call => call.command === "push").length, commits);
  assert.ok(calls.filter(call => call.command !== "push").length <= commits * 2 + 40);
  assert.equal(await git(remote, "rev-parse", "main"), await git(f.root, "rev-parse", "HEAD"));
});
