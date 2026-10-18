import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runGitWithInput } from "../src/git/gitExec";
import { getCurrentPushPlan } from "../src/git/pushService";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 Git 실행은 유지하면서 계획이 요청한 이력 계산과 프로세스 수만 관찰한다. */
function observe(t: TestContext): string[][] {
  const calls: string[][] = [], spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push([...args[1]]);
    return (spawn as Function)(...args);
  });
  return calls;
}

test("push planning checks tracking existence without walking thousands of upstream commits", async t => {
  const { root, directory, head } = await safetyFixture(t, "push-tracking-history");
  await addOrigin(root, directory);
  const input: string[] = [], commits = 4000;
  for (let index = 1; index <= commits; index++) {
    const text = `history ${index}\n`;
    input.push(`commit refs/heads/main\nmark :${index}\ncommitter Tracking <tracking@example.test> ${1_800_000_000 + index} +0000\ndata ${Buffer.byteLength(text)}\n${text}from ${index === 1 ? head : `:${index - 1}`}\n\n`);
  }
  await runGitWithInput(["fast-import", "--quiet"], root, input.join("") + "done\n");
  const current = await git(root, "rev-parse", "HEAD"), index = await readFile(join(root, ".git", "index"));
  const calls = observe(t), plan = await getCurrentPushPlan(root);
  assert.equal(plan.mode, "plain"); assert.equal(plan.snapshot.head, current);
  assert.equal(plan.snapshot.remoteHead, head); assert.equal(plan.snapshot.targetRef, "refs/heads/main");
  assert.equal(plan.upstream, "origin/main"); assert.ok(calls.length <= 4);
  assert.equal(calls.some(args => args.some(arg => /%\((?:upstream:track|ahead-behind:)/.test(arg))), false,
    "a push plan only needs ref existence, not ahead/behind history");
  assert.deepEqual(await readFile(join(root, ".git", "index")), index);
});

for (const gone of [false, true]) {
  test(`an alternate upstream keeps its ${gone ? "gone" : "name mismatch"} reason and current-branch lease`, async t => {
    const { root, directory, head } = await safetyFixture(t, `push-alternate-upstream-${gone}`);
    await addOrigin(root, directory);
    await git(root, "push", "origin", "main:alternate");
    await git(root, "config", "branch.main.merge", "refs/heads/alternate");
    if (gone) await git(root, "update-ref", "-d", "refs/remotes/origin/alternate");
    const plan = await getCurrentPushPlan(root);
    assert.equal(plan.mode, "setUpstream");
    if (plan.mode !== "setUpstream") return;
    assert.equal(plan.reason, gone ? "goneUpstream" : "upstreamNameMismatch");
    assert.equal(plan.upstream, "origin/alternate"); assert.equal(plan.snapshot.remoteHead, head);
    assert.equal(plan.targetUpstream, "origin/main");
  });
}

test("a missing upstream is not supplied by a child ref or a tag with the same short name", async t => {
  const { root, directory, head } = await safetyFixture(t, "push-gone-upstream-prefix");
  await addOrigin(root, directory);
  await git(root, "config", "branch.main.merge", "refs/heads/missing");
  await git(root, "update-ref", "refs/remotes/origin/missing/child", head);
  await git(root, "update-ref", "refs/tags/origin/missing", head);
  const plan = await getCurrentPushPlan(root);
  assert.equal(plan.mode, "setUpstream");
  if (plan.mode === "setUpstream") assert.equal(plan.reason, "goneUpstream");
  assert.equal(plan.snapshot.remoteHead, head);
});

test("custom fetch mappings distinguish a present unknown upstream from a gone one", async t => {
  const { root, directory, head } = await safetyFixture(t, "push-custom-fetch-tracking");
  await addOrigin(root, directory);
  await git(root, "config", "remote.origin.fetch", "+refs/heads/*:refs/custom/origin/*");
  await git(root, "fetch", "origin");
  let plan = await getCurrentPushPlan(root);
  assert.equal(plan.mode, "setUpstream"); assert.equal(plan.snapshot.remoteHead, head);
  if (plan.mode === "setUpstream") assert.equal(plan.reason, "unknownUpstream");
  await git(root, "update-ref", "-d", "refs/custom/origin/main");
  plan = await getCurrentPushPlan(root);
  assert.equal(plan.mode, "setUpstream");
  if (plan.mode === "setUpstream") assert.equal(plan.reason, "goneUpstream");
});

test("local upstream refs are distinguished from missing remote tracking refs", async t => {
  const { root, directory, head } = await safetyFixture(t, "push-local-upstream");
  await addOrigin(root, directory);
  await git(root, "branch", "local-base");
  await git(root, "config", "branch.main.remote", ".");
  await git(root, "config", "branch.main.merge", "refs/heads/local-base");
  let plan = await getCurrentPushPlan(root);
  assert.equal(plan.mode, "setUpstream");
  if (plan.mode === "setUpstream") assert.equal(plan.reason, "unknownUpstream");
  assert.equal(plan.snapshot.remoteHead, head);
  await git(root, "branch", "-D", "local-base");
  plan = await getCurrentPushPlan(root);
  assert.equal(plan.mode, "setUpstream");
  if (plan.mode === "setUpstream") assert.equal(plan.reason, "goneUpstream");
});

test("upstream deletion and restoration are observed afresh on each plan", async t => {
  const { root, directory, head } = await safetyFixture(t, "push-tracking-freshness");
  await addOrigin(root, directory);
  const initial = await getCurrentPushPlan(root);
  await git(root, "update-ref", "-d", "refs/remotes/origin/main");
  const removed = await getCurrentPushPlan(root);
  assert.equal(initial.mode, "plain"); assert.equal(removed.mode, "setUpstream");
  if (removed.mode === "setUpstream") assert.equal(removed.reason, "goneUpstream");
  assert.equal(removed.snapshot.remoteHead, "");
  await git(root, "update-ref", "refs/remotes/origin/main", head);
  assert.deepEqual(await getCurrentPushPlan(root), initial);
});

test("a local upstream resembling another remote keeps that selected destination's lease", async t => {
  const { root, directory, head } = await safetyFixture(t, "push-late-selected-remote");
  await addOrigin(root, directory);
  const remote = join(directory, "other.git");
  await git(directory, "init", "--bare", "-q", remote);
  await git(root, "remote", "add", "other", remote);
  const destinationHead = await commitText(root, "other destination\n", "other destination");
  await git(root, "push", "other", "main");
  await git(root, "branch", "other/alternate", head);
  await git(root, "config", "branch.main.remote", ".");
  await git(root, "config", "branch.main.merge", "refs/heads/other/alternate");
  const plan = await getCurrentPushPlan(root);
  assert.equal(plan.mode, "setUpstream"); assert.equal(plan.remote, "other");
  if (plan.mode === "setUpstream") assert.equal(plan.reason, "upstreamNameMismatch");
  assert.equal(plan.snapshot.remoteHead, destinationHead);
  assert.equal(plan.snapshot.targetRef, "refs/heads/main");
});

for (const objectType of ["missing", "blob", "tag"] as const) {
  test(`an upstream pointing to a ${objectType} retains Git's gone classification and approved destination`, async t => {
    const { root, directory, head } = await safetyFixture(t, `push-upstream-object-${objectType}`);
    await addOrigin(root, directory);
    await git(root, "push", "origin", "main:destination");
    await git(root, "config", "remote.origin.push", "refs/heads/main:refs/heads/destination");
    if (objectType === "tag") await git(root, "tag", "-am", "upstream", "upstream-tag");
    const oid = objectType === "missing" ? "f".repeat(40) : objectType === "blob"
      ? await git(root, "hash-object", "-w", "tracked.txt")
      : await git(root, "rev-parse", "refs/tags/upstream-tag");
    await writeFile(join(root, ".git", "refs", "remotes", "origin", "main"), `${oid}\n`);
    const plan = await getCurrentPushPlan(root);
    assert.equal(plan.mode, objectType === "tag" ? "plain" : "setUpstream");
    if (plan.mode === "setUpstream") assert.equal(plan.reason, "goneUpstream");
    assert.equal(plan.snapshot.targetRef, objectType === "tag" ? "refs/heads/destination" : "refs/heads/main");
    assert.equal(plan.snapshot.remoteHead, objectType === "tag" ? head : oid);
  });
}

test("a corrupt upstream object remains an error rather than being treated as gone", async t => {
  const { root, directory, head } = await safetyFixture(t, "push-corrupt-upstream");
  await addOrigin(root, directory);
  const oid = await git(root, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "upstream only");
  await git(root, "update-ref", "refs/remotes/origin/main", oid);
  const objectFile = join(root, ".git", "objects", oid.slice(0, 2), oid.slice(2));
  await chmod(objectFile, 0o600);
  await writeFile(objectFile, "invalid compressed object\n");
  await assert.rejects(() => getCurrentPushPlan(root), /corrupt|unable to unpack|inflate/i);
});

test("a moved upstream is validated by its exact metadata OID", async t => {
  const { root, directory, head } = await safetyFixture(t, "push-upstream-moved-during-plan");
  await addOrigin(root, directory);
  const moved = await git(root, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "moved upstream");
  const spawn = childProcess.spawn;
  let changed = false;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (!changed && args[0] === "git" && args[1][0] === "for-each-ref") {
      changed = true;
      childProcess.execFileSync("git", ["update-ref", "refs/remotes/origin/main", moved], { cwd: root });
    }
    return (spawn as Function)(...args);
  });
  const plan = await getCurrentPushPlan(root);
  assert.equal(changed, true); assert.equal(plan.mode, "plain");
  assert.equal(plan.snapshot.remoteHead, moved);
});

for (const code of ["ETIMEDOUT", "GIT_READ_STOPPING", "EACCES"]) {
  test(`an upstream probe ${code} failure cannot be hidden as a missing ref`, async t => {
    const { root, directory } = await safetyFixture(t, `push-upstream-probe-${code}`);
    await addOrigin(root, directory);
    const spawn = childProcess.spawn, closed: Promise<unknown>[] = [];
    t.mock.method(childProcess, "spawn", (...args: any[]) => {
      if (args[0] === "git" && args[1].includes("@{upstream}^{commit}")) {
        throw Object.assign(new Error(`upstream probe stopped: ${code}`), { code });
      }
      const child = (spawn as Function)(...args);
      closed.push(new Promise(resolve => child.once("close", resolve)));
      return child;
    });
    try { await assert.rejects(() => getCurrentPushPlan(root), new RegExp(`upstream probe stopped: ${code}`)); }
    finally { await Promise.allSettled(closed); }
  });
}

for (const name of ["Case.Mixed/Remote", "unknownOnly", "한글", ".url"]) {
  test(`remote enumeration preserves native Git membership for ${name}`, async t => {
    const { root, directory } = await safetyFixture(t, "push-config-remote-membership");
    await addOrigin(root, directory);
    if (name === ".url") {
      const file = join(root, ".git", "config");
      await writeFile(file, await readFile(file, "utf8") + '\n[remote ""]\n url = unused\n');
    } else {
      await git(root, "config", `remote.${name}.${name === "unknownOnly" ? "customKey" : "url"}`, "unused");
    }
    await git(root, "config", "branch.main.pushRemote", name);
    assert.ok((await git(root, "remote")).split("\n").includes(name));
    const calls = observe(t), plan = await getCurrentPushPlan(root);
    assert.equal(plan.remote, name);
    assert.equal(calls.some(args => args[0] === "remote"), name === ".url",
      "ordinary remote names reuse configuration; ambiguous empty names retain native fallback");
  });
}

for (const names of [["Z.Mixed", "Alpha", "alpha"], ["𐀀", "\ue000"]]) {
  test(`default remote selection keeps native byte ordering for ${names.join(",")}`, async t => {
    const { root, directory } = await safetyFixture(t, "push-config-remote-order");
    const globalFile = join(directory, "empty-global.config");
    await writeFile(globalFile, "");
    const savedGlobal = process.env.GIT_CONFIG_GLOBAL, savedSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_GLOBAL = globalFile; process.env.GIT_CONFIG_NOSYSTEM = "1";
    t.after(() => {
      if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
      if (savedSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = savedSystem;
    });
    for (const name of names) await git(root, "config", `remote.${name}.url`, "unused");
    const native = (await git(root, "remote")).split("\n");
    assert.equal(native.length, names.length);
    const plan = await getCurrentPushPlan(root);
    assert.equal(plan.remote, native[0]);
  });
}

test("lossy UTF-8 remote names retain native selection under the C locale", async t => {
  const { root, directory } = await safetyFixture(t, "push-config-remote-invalid-utf8");
  const globalFile = join(directory, "empty-global.config"), configFile = join(root, ".git", "config");
  await writeFile(globalFile, "");
  const saved = new Map(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "LC_ALL"].map(key => [key, process.env[key]]));
  process.env.GIT_CONFIG_GLOBAL = globalFile; process.env.GIT_CONFIG_NOSYSTEM = "1"; process.env.LC_ALL = "C";
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  await git(root, "config", "remote.𐀀.url", "unused");
  await writeFile(configFile, Buffer.concat([await readFile(configFile),
    Buffer.from('\n[remote "'), Buffer.from([0xff]), Buffer.from('"]\n url = unused\n')]));
  const native = (await git(root, "remote")).split("\n");
  assert.equal(native[0], "𐀀"); assert.equal(native.length, 2);
  const calls = observe(t), plan = await getCurrentPushPlan(root);
  assert.equal(plan.remote, native[0]);
  assert.equal(calls.some(args => args[0] === "remote"), true,
    "undecodable names retain native ordering instead of sorting replacement characters");
});
