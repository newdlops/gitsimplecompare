import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { readRebasePlanCommits } from "../src/git/rebaseCommitReader";
import { RebaseService } from "../src/git/rebaseService";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 독립 파일 세 개를 변경한 선형 이력과 실제 Native 실행기를 유지하는 프로세스 관찰자를 만든다. */
async function linearFixture(t: TestContext) {
  const fixture = await safetyFixture(t, "rebase-plan-reuse"), hashes: string[] = [];
  for (let index = 0; index < 3; index++) {
    await writeFile(join(fixture.root, `change-${index}.txt`), `change ${index}\n`);
    await git(fixture.root, "add", "."); await git(fixture.root, "commit", "-qm", `change ${index}`);
    hashes.push(await git(fixture.root, "rev-parse", "HEAD"));
  }
  return { ...fixture, base: fixture.head, hashes, head: hashes.at(-1)! };
}

/** Native 동작은 유지하고 Git 인수만 기록해 중복 ancestry/branch/count 조회의 재발을 찾는다. */
function calls(t: TestContext): string[][] {
  const spawn = childProcess.spawn, result: string[][] = [];
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") result.push([...args[1]]);
    return (spawn as Function)(...args);
  });
  return result;
}

for (const short of [false, true]) test(`selected linear plan reuses its range for ${short ? "abbreviated" : "full"} onto commits`, async t => {
  const f = await linearFixture(t), observed = calls(t), service = new RebaseService(f.root, { nativeEditors: true });
  const plan = await service.prepareCurrentBranchPlan(f.hashes[0], short ? f.head.slice(0, 12) : f.head);
  assert.equal(plan.branch, "main"); assert.equal(plan.base, f.base); assert.equal(plan.onto, undefined);
  assert.deepEqual(plan.commits.map(commit => commit.hash), f.hashes);
  assert.equal(observed.length, short ? 8 : 7);
  assert.equal(observed.filter(args => args[0] === "merge-base").length, 1);
  assert.equal(observed.some(args => args[0] === "branch" || args[0] === "rev-list"), false);
  const tree = await git(f.root, "rev-parse", "HEAD^{tree}");
  const items = [...plan.commits].reverse().map(commit => ({ hash: commit.hash, action: "pick" as const }));
  const result = await service.start(plan.base, false, items, resolve("media/rebase/rebaseEditor.js"), plan.onto, plan.checkout);
  assert.equal(result.status, "completed");
  assert.equal(await git(f.root, "rev-parse", "HEAD^{tree}"), tree);
  assert.equal(await git(f.root, "log", "--reverse", "--format=%s", `${f.base}..HEAD`), "change 2\nchange 1\nchange 0");
});

test("upstream planning reuses its loaded commits instead of separately counting the same range", async t => {
  const f = await linearFixture(t);
  await git(f.root, "branch", "upstream", f.base); await git(f.root, "branch", "--set-upstream-to=upstream", "main");
  const observed = calls(t), service = new RebaseService(f.root);
  const plan = await service.prepareCurrentBranchPlan(undefined, f.head);
  assert.equal(plan.baseReason, "upstream"); assert.equal(plan.upstream, "upstream"); assert.equal(plan.base, f.base);
  assert.deepEqual(plan.commits.map(commit => commit.hash), f.hashes); assert.equal(plan.onto, undefined);
  assert.equal(observed.length, 6); assert.equal(observed.some(args => args[0] === "rev-list" || args[0] === "branch"), false);
  await git(f.root, "update-ref", "refs/heads/upstream", f.head);
  await assert.rejects(service.prepareCurrentBranchPlan(), /Drag a commit/);
  const next = await commitText(f.root, "new head\n", "new head");
  assert.deepEqual((await service.prepareCurrentBranchPlan()).commits.map(commit => commit.hash), [next]);
});

test("linear plans still resolve an outside onto ref and reject a missing target", async t => {
  const f = await linearFixture(t);
  await git(f.root, "switch", "-qc", "outside", f.base);
  const outside = await commitText(f.root, "outside\n", "outside");
  await git(f.root, "switch", "main");
  const observed = calls(t), service = new RebaseService(f.root);
  const plan = await service.prepareCurrentBranchPlan(f.hashes[0], "outside");
  assert.equal(plan.onto, outside); assert.equal(plan.checkout?.head, f.head);
  assert.equal(observed.filter(args => args[0] === "merge-base").length, 1);
  await assert.rejects(service.prepareCurrentBranchPlan(f.hashes[0], "missing-onto"));
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
});

test("root plans reuse the complete linear ancestry and preserve the original root selection", async t => {
  const f = await linearFixture(t), observed = calls(t);
  const plan = await new RebaseService(f.root).prepareCurrentBranchPlan(f.base, f.hashes[1]);
  assert.equal(plan.root, true); assert.equal(plan.base, ""); assert.equal(plan.onto, undefined);
  assert.deepEqual(plan.commits.map(commit => commit.hash), [f.base, ...f.hashes]);
  assert.equal(observed.filter(args => args[0] === "merge-base").length, 1);
  assert.equal(observed.filter(args => args.includes("--symbolic-full-name") && args.includes("--absolute-git-dir")).length, 2);
});

test("merge DAG membership does not replace the original base ancestry semantics", async t => {
  const f = await safetyFixture(t, "rebase-plan-merge-fallback");
  await git(f.root, "branch", "side", f.head);
  const base = await commitText(f.root, "main base\n", "main base");
  await writeFile(join(f.root, "selected.txt"), "selected\n"); await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "selected");
  const selected = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "switch", "side");
  await writeFile(join(f.root, "side.txt"), "side\n"); await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "side");
  const side = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "switch", "main"); await git(f.root, "merge", "--no-ff", "-qm", "merge", "side");
  const head = await git(f.root, "rev-parse", "HEAD"), range = await readRebasePlanCommits(f.root, base, false, head);
  assert.equal(range.linear, false); assert.ok(range.commits.some(commit => commit.hash === side));
  const observed = calls(t), plan = await new RebaseService(f.root).prepareCurrentBranchPlan(selected, side);
  assert.equal(plan.onto, side); assert.equal(plan.base, base);
  assert.equal(observed.filter(args => args[0] === "merge-base").length, 2);
});

for (const restore of [false, true]) test(`plan loading ${restore ? "pins its range across an ABA checkout" : "rejects a same-HEAD branch switch"}`, async t => {
  const f = await linearFixture(t);
  await git(f.root, "branch", "other", restore ? f.base : f.head);
  const spawn = childProcess.spawn;
  let switched = false;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const trigger = args[0] === "git" && args[1].includes("--format=%H%x00%P%x00%s%x00%b");
    if (trigger) {
      switched = true; writeFileSync(join(f.root, ".git/HEAD"), "ref: refs/heads/other\n");
      assert.ok(args[1].includes(`${f.base}..${f.head}`));
    }
    const child = (spawn as Function)(...args);
    if (trigger && restore) child.once("close", () => writeFileSync(join(f.root, ".git/HEAD"), "ref: refs/heads/main\n"));
    return child;
  });
  const promise = new RebaseService(f.root).prepareCurrentBranchPlan(f.hashes[0], f.head);
  if (restore) assert.deepEqual((await promise).commits.map(commit => commit.hash), f.hashes);
  else await assert.rejects(promise, /branch or HEAD changed/);
  assert.equal(switched, true);
});

test("a parent lookup failure cannot turn a selected commit into an unintended root plan", async t => {
  const f = await linearFixture(t), spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git" && args[1].includes("--format=%P")) {
      return spawn(process.execPath, ["-e", "process.stderr.write('controlled parent failure'); process.exitCode=128"], args[2]);
    }
    return (spawn as Function)(...args);
  });
  await assert.rejects(new RebaseService(f.root).prepareCurrentBranchPlan(f.hashes[1]), /controlled parent failure/);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
});

test("the fixed range reader supports SHA-256 and Unicode branch names", async t => {
  const f = await safetyFixture(t, "rebase-plan-sha256"), root = join(f.directory, "sha256");
  await mkdir(root); await git(root, "init", "-qb", "feature/한글", "--object-format=sha256");
  for (const [key, value] of Object.entries({ "user.name": "Test", "user.email": "test@example.test", "commit.gpgsign": "false",
    "core.hooksPath": join(f.directory, "hooks"), "core.fsmonitor": "false" })) await git(root, "config", key, value);
  const base = await commitText(root, "root\n", "root"), head = await commitText(root, "next\n", "next");
  const plan = await new RebaseService(root).prepareCurrentBranchPlan(base, head);
  assert.equal(plan.branch, "feature/한글"); assert.equal(plan.onto, undefined); assert.equal(plan.root, true);
  assert.deepEqual(plan.commits.map(commit => commit.hash), [base, head]); assert.equal(head.length, 64);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "next\n");
});

test("upstream planning keeps the original branch configuration across an ABA checkout", async t => {
  const f = await linearFixture(t);
  await git(f.root, "branch", "main-upstream", f.base);
  await git(f.root, "branch", "other", f.head);
  await git(f.root, "branch", "other-upstream", f.head);
  await git(f.root, "branch", "--set-upstream-to=main-upstream", "main");
  await git(f.root, "branch", "--set-upstream-to=other-upstream", "other");
  const spawn = childProcess.spawn;
  let switched = false;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const trigger = args[0] === "git" && args[1].some((arg: string) => arg.endsWith("@{u}"));
    if (trigger) { switched = true; writeFileSync(join(f.root, ".git/HEAD"), "ref: refs/heads/other\n"); }
    const child = (spawn as Function)(...args);
    if (trigger) child.once("close", () => writeFileSync(join(f.root, ".git/HEAD"), "ref: refs/heads/main\n"));
    return child;
  });
  const plan = await new RebaseService(f.root).prepareCurrentBranchPlan();
  assert.equal(switched, true); assert.equal(plan.upstream, "main-upstream"); assert.equal(plan.base, f.base);
  assert.deepEqual(plan.commits.map(commit => commit.hash), f.hashes);
});
