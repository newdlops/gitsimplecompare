import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canUseGitHubProactiveAuth, setGitHubProactiveAuthResolver } from "../src/git/githubGitProactiveAuth";
import { runGit } from "../src/git/gitExec";
import childProcess from "node:child_process";
import { addOrigin, commitText, safetyFixture } from "./helpers/gitSafetyFixture";
import { getCurrentPushPlan, pushCurrentWithAutoUpstream } from "../src/git/pushService";

/** 실제 인증 helper를 실행하지 않고 config·URL 검증의 보수적인 결정을 관찰한다. */
function probe(extra: Array<[string, string]> = [], urls = ["https://github.com/owner/repo.git"], version = "2.50.1") {
  const seen: string[][] = [];
  const read = async (args: string[]) => {
    seen.push(args);
    if (args[0] === "--version") return `git version ${version}`;
    if (args[0] === "config") return [["remote.origin.url", urls[0]], ["credential.helper", "osxkeychain"], ...extra]
      .map(([key, value]) => `${key}\n${value}\0`).join("");
    if (args[0] === "remote") return urls.join("\n");
    if (args[0] === "symbolic-ref") return "main\n";
    throw new Error("Unexpected authentication probe");
  };
  return { seen, read };
}

test("native proactive authentication is opt-in and only for proven single GitHub HTTPS URLs", async () => {
  const p = probe();
  assert.equal(await canUseGitHubProactiveAuth(["push", "origin", "HEAD:main"], "/repo", {}, p.read), false);
  assert.equal(p.seen.length, 0);
  assert.equal(await canUseGitHubProactiveAuth(["push", "origin", "HEAD:main"], "/repo", { githubProactiveAuth: true }, p.read), true);
  for (const urls of [["git@github.com:owner/repo.git"], ["https://other.example/repo"],
    ["https://github.com/owner/repo", "https://github.com/owner/other"], ["https://token@github.com/owner/repo"]]) {
    assert.equal(await canUseGitHubProactiveAuth(["push", "origin", "HEAD:main"], "/repo", { githubProactiveAuth: true }, probe([], urls).read), false);
  }
  assert.equal(await canUseGitHubProactiveAuth(["push", "origin"], "/repo", { githubProactiveAuth: true }, probe([], undefined, "2.45.0").read), false);
});

test("explicit auth/credential policies and URL rewrites take precedence", async () => {
  for (const setting of [["http.proactiveauth", "none"], ["http.https://github.com/.proactiveauth", "basic"],
    ["http.emptyauth", "false"], ["credential.interactive", "false"], ["credential.helper", ""],
    ["http.extraheader", "Authorization: fixture"], ["url.https://github.com/.insteadof", "fixture:"]]) {
    assert.equal(await canUseGitHubProactiveAuth(["fetch", "origin"], "/repo", { githubProactiveAuth: true }, probe([setting as [string, string]]).read), false);
  }
  assert.equal(await canUseGitHubProactiveAuth(["fetch", "--unknown-policy", "origin"], "/repo", { githubProactiveAuth: true }, probe().read), false);
});

test("the shared Git executor adds only a command-scoped config and preserves existing overrides", async t => {
  const root = await mkdtemp(join(tmpdir(), "gsc-native-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "git-fixture");
  await writeFile(executable, `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[0]==='--version') console.log('git version 2.50.1');\nelse if(a[0]==='config') process.stdout.write('remote.origin.url\\nhttps://github.com/owner/repo.git\\0credential.helper\\nosxkeychain\\0');\nelse if(a[0]==='remote') console.log('https://github.com/owner/repo.git');\nelse if(a[0]==='push') console.log(JSON.stringify({args:a,config:Array.from({length:Number(process.env.GIT_CONFIG_COUNT||0)},(_,i)=>[process.env['GIT_CONFIG_KEY_'+i],process.env['GIT_CONFIG_VALUE_'+i]])}));\nelse process.exit(2);\n`);
  await chmod(executable, 0o755);
  const reset = setGitHubProactiveAuthResolver(() => true); t.after(reset);
  const output = JSON.parse(await runGit(["push", "origin", "fixed:refs/heads/main"], root,
    { executable, env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "push.negotiate", GIT_CONFIG_VALUE_0: "true" } }));
  assert.deepEqual(output.args, ["push", "origin", "fixed:refs/heads/main"]);
  assert.deepEqual(output.config, [["push.negotiate", "true"], ["http.proactiveAuth", "auto"]]);
  const disabled = JSON.parse(await runGit(["push", "origin", "fixed:refs/heads/main"], root,
    { executable, githubProactiveAuth: false, env: { GIT_CONFIG_COUNT: "0" } }));
  assert.deepEqual(disabled.config, []);
});

test("an approved push freezes the opt-in setting and still executes native pre-push hooks", async t => {
  const { root, directory } = await safetyFixture(t, "auth-push-frozen");
  await addOrigin(root, directory); await commitText(root, "approved\n", "approved");
  let enabled = false;
  const reset = setGitHubProactiveAuthResolver(() => enabled); t.after(reset);
  const plan = await getCurrentPushPlan(root);
  assert.equal(plan.snapshot.githubProactiveAuth, false);
  enabled = true;
  const hooks = (await runGit(["config", "--get", "core.hooksPath"], root)).trim();
  await writeFile(join(hooks, "pre-push"), "#!/bin/sh\nprintf ran > auth-hook-ran\n", { mode: 0o755 });
  const spawn = childProcess.spawn, commands: string[] = [];
  t.mock.method(childProcess, "spawn", (...args: any[]) => { if (args[0] === "git") commands.push(args[1][0]); return (spawn as Function)(...args); });
  await pushCurrentWithAutoUpstream(root, plan);
  assert.equal(await readFile(join(root, "auth-hook-ran"), "utf8"), "ran");
  assert(!commands.includes("--version"), "the newly enabled setting cannot change the approved push policy");
});
