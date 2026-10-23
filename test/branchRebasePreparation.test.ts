import assert from "node:assert/strict";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { BranchOperationService } from "../src/git/branchOperationService";
import { runGit } from "../src/git/gitExec";
import { gitProcesses } from "../src/git/gitProcessRegistry";
import { disposeWorkingTreeSnapshots } from "../src/git/workingTreeSnapshot";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 테스트가 명시한 읽기 경계만 제어하며 실제 Git 준비/쓰기 결과는 대체하지 않는다. */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** 검증 경계만 유한하게 기다리며 실패해도 caller의 finally가 실제 작업을 정리하게 한다. */
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Native preparation boundary did not arrive")), 2000);
  })]); } finally { clearTimeout(timer); }
}

/** 서로 다른 두 파일을 가진 실제 분기와 보존할 로컬 파일을 만들고 Native child부터 회수한다. */
async function fixture(t: TestContext) {
  const cleanups: Array<() => unknown> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  const f = await safetyFixture({ after: (cleanup: () => unknown) => cleanups.push(cleanup) } as TestContext, "branch-rebase-preparation");
  cleanups.push(async () => { await disposeWorkingTreeSnapshots(); await gitProcesses.dispose(); });
  await git(f.root, "switch", "-qc", "topic");
  await writeFile(path.join(f.root, "topic.txt"), "topic content\n");
  await git(f.root, "add", "topic.txt"); await git(f.root, "commit", "-qm", "topic change");
  const target = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "switch", "-q", "main");
  await writeFile(path.join(f.root, "main.txt"), "main content\n");
  await git(f.root, "add", "main.txt"); await git(f.root, "commit", "-qm", "main change");
  await writeFile(path.join(f.root, "keep.txt"), "preserve local work\n");
  return { ...f, target, service: new BranchOperationService(f.root) };
}

/** 검증 중에는 HEAD·index·모든 ref·로컬 내용이 그대로인지 Native/바이트 기준을 읽는다. */
async function state(root: string) {
  return { head: await git(root, "rev-parse", "HEAD"),
    refs: await git(root, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"),
    index: await readFile(path.join(root, ".git/index")), config: await readFile(path.join(root, ".git/config")),
    local: await readFile(path.join(root, "keep.txt"), "utf8") };
}

/** 로컬 객체만 열거해 누락 OID 확인 자체가 promisor fetch로 바뀌지 않게 한다. */
async function localObjects(root: string): Promise<Set<string>> {
  return new Set((await git(root, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)")).split("\n").filter(Boolean));
}

test("a real promisor target cannot invoke its fetch helper before readiness succeeds", { timeout: 60000 }, async t => {
  const f = await fixture(t), marker = path.join(f.directory, "fetch-attempts"), ssh = path.join(f.directory, "record-ssh.cjs");
  // Git이 호출할 SSH 실행기를 소유 로컬 기록기로 바꿔 실제 네트워크 없이 lazy fetch 시도를 확인한다.
  await writeFile(ssh, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'attempt\\n'); process.exit(1);\n`);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await git(f.root, "remote", "add", "origin", "ssh://gsc-fixture.invalid/repository");
  for (const [key, value] of Object.entries({ "core.repositoryformatversion": "1", "extensions.partialclone": "origin",
    "remote.origin.promisor": "true", "remote.origin.partialclonefilter": "blob:none", "core.sshCommand": `${quote(process.execPath)} ${quote(ssh)}` }))
    await git(f.root, "config", key, value);
  const target = "a".repeat(40);
  await assert.rejects(runGit(["rev-parse", "--verify", "--end-of-options", `${target}^{commit}`], f.root,
    { env: { GIT_NO_LAZY_FETCH: "0" } }));
  assert.ok((await readFile(marker, "utf8")).includes("attempt"), "The Native control must actually invoke a promisor helper");
  await unlink(marker);
  const before = await state(f.root), readiness = deferred<never>(), entered = deferred<void>(), finished = deferred<void>(), failure = new Error("Readiness rejected the promisor operation");
  const service: any = f.service, resolve = service.resolveCommit.bind(service), previous = process.env.GIT_NO_LAZY_FETCH;
  let targetStarted = false;
  t.mock.method(service, "assertReadyForBranchOperation", () => { entered.resolve(); return readiness.promise; });
  t.mock.method(service, "resolveCommit", async (...args: unknown[]) => { targetStarted = true; try { return await resolve(...args); } finally { finished.resolve(); } });
  process.env.GIT_NO_LAZY_FETCH = "0";
  const outcome = f.service.rebaseMerge(target).then(() => undefined, error => error);
  try {
    await within(entered.promise); await nextTurn();
    // 순차 구현은 대상을 아직 읽지 않는다. 병렬 구현도 실제 읽기를 완료한 뒤 fetch가 없었는지 입증해야 한다.
    if (targetStarted) await within(finished.promise);
    await assert.rejects(access(marker), { code: "ENOENT" }, "A rejected startup must not begin an implicit fetch");
    assert.deepEqual(await state(f.root), before);
  } finally {
    readiness.reject(failure); await outcome;
    if (previous === undefined) delete process.env.GIT_NO_LAZY_FETCH; else process.env.GIT_NO_LAZY_FETCH = previous;
  }
  assert.equal(await outcome, failure);
  assert.deepEqual(await state(f.root), before);
});

test("a missing promisor commit is fetched only after readiness and remains a usable rebase target", { timeout: 60000 }, async t => {
  const f = await fixture(t), remote = path.join(f.directory, "origin.git");
  await git(f.directory, "init", "--bare", "-q", remote);
  await git(remote, "config", "uploadpack.allowFilter", "true");
  await git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
  await git(f.root, "remote", "add", "origin", remote);
  await git(f.root, "push", "-q", "origin", "main", "topic");
  const tree = await git(remote, "rev-parse", "topic^{tree}");
  const target = await git(remote, "-c", "user.name=Promisor Fixture", "-c", "user.email=promisor@example.invalid",
    "commit-tree", tree, "-p", f.target, "-m", "remote only target");
  await git(remote, "update-ref", "refs/heads/remote-target", target);
  for (const [key, value] of Object.entries({ "core.repositoryformatversion": "1", "extensions.partialclone": "origin",
    "remote.origin.promisor": "true", "remote.origin.partialclonefilter": "blob:none", "protocol.file.allow": "always" }))
    await git(f.root, "config", key, value);
  assert.equal((await localObjects(f.root)).has(target), false);
  const before = await state(f.root), release = deferred<void>(), entered = deferred<void>(), probed = deferred<void>(), previous = process.env.GIT_NO_LAZY_FETCH;
  const service: any = f.service, ready = service.assertReadyForBranchOperation.bind(service), resolve = service.resolveCommit.bind(service);
  let targetStarted = false;
  t.mock.method(service, "assertReadyForBranchOperation", async () => { entered.resolve(); await release.promise; return ready(); });
  t.mock.method(service, "resolveCommit", async (...args: unknown[]) => { targetStarted = true; try { return await resolve(...args); } finally { probed.resolve(); } });
  process.env.GIT_NO_LAZY_FETCH = "0";
  const operation = f.service.rebaseMerge(target); void operation.catch(() => undefined);
  try {
    await within(entered.promise); await nextTurn();
    if (targetStarted) await within(probed.promise);
    assert.equal((await localObjects(f.root)).has(target), false, "Preparation must not materialize the commit before readiness");
    assert.deepEqual(await state(f.root), before);
  } finally {
    release.resolve();
    try { await operation; } finally {
      if (previous === undefined) delete process.env.GIT_NO_LAZY_FETCH; else process.env.GIT_NO_LAZY_FETCH = previous;
    }
  }
  assert.equal((await operation).status, "completed");
  assert.equal((await localObjects(f.root)).has(target), true);
  await git(f.root, "merge-base", "--is-ancestor", target, "HEAD");
  assert.equal(await git(f.root, "show", "HEAD:main.txt"), "main content");
  assert.equal(await git(f.root, "show", "HEAD:topic.txt"), "topic content");
  assert.equal(await git(f.root, "status", "--porcelain=v1"), "?? keep.txt");
  assert.equal(await readFile(path.join(f.root, "keep.txt"), "utf8"), before.local);
});
