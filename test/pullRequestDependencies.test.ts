import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PullRequestDependencyService } from "../src/git/pullRequestDependencyService";
import { runGitWithInput } from "../src/git/gitExec";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";
import { prDependencyFixture } from "./helpers/prDependencyFixture";
import { safetyPullRequest } from "./helpers/prOperationSafetyFixture";

test("a missing prerequisite is verified without GitHub reads or changing local work, refs or index", async t => {
  const { root, base, prerequisite, pr } = await prDependencyFixture(t);
  await writeFile(join(root, "user.txt"), "staged user work\n"); await git(root, "add", "user.txt");
  await writeFile(join(root, "user.txt"), "unstaged user work\n");
  const index = await git(root, "ls-files", "--stage", "-z");
  const refs = await git(root, "for-each-ref", "--format=%(refname) %(objectname)");
  const report = await new PullRequestDependencyService(root, async () => assert.fail("Loaded PRs must be reused"))
    .analyze({ pr, knownPullRequests: [prerequisite, pr] });
  assert.equal(report.beforeHead, base);
  assert.deepEqual(report.conflicts, ["기능\tfile.ts"]);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].pr.number, 41);
  assert.equal(report.candidates[0].status, "resolves");
  assert.deepEqual(new Set(report.candidates[0].reasons), new Set(["stack", "history"]));
  assert.equal(await git(root, "rev-parse", "HEAD"), base);
  assert.equal(await git(root, "ls-files", "--stage", "-z"), index);
  assert.equal(await git(root, "for-each-ref", "--format=%(refname) %(objectname)"), refs);
  assert.equal(await readFile(join(root, "user.txt"), "utf8"), "unstaged user work\n");
  assert.equal(await git(root, "show", ":user.txt"), "staged user work");
});

test("source file history finds the prerequisite even when both PRs target main", async t => {
  const { root, prerequisite, pr } = await prDependencyFixture(t);
  const report = await new PullRequestDependencyService(root, async () => assert.fail("Known commit association is sufficient"))
    .analyze({ pr: { ...pr, baseRefName: "main" }, knownPullRequests: [prerequisite] });
  assert.deepEqual(report.candidates[0].reasons, ["history"]);
  assert.equal(report.candidates[0].status, "resolves");
});

test("a prerequisite already squashed under a different hash is satisfied on the current tree", async t => {
  const { root, base, parent, prerequisite, pr } = await prDependencyFixture(t);
  const patch = await git(root, "diff", "--binary", base, parent);
  await runGitWithInput(["apply", "--index"], root, `${patch}\n`);
  await git(root, "commit", "-qm", "different squash identity");
  assert.notEqual(await git(root, "rev-parse", "HEAD"), parent);
  const report = await new PullRequestDependencyService(root, async () => assert.fail("No network is needed"))
    .analyze({ pr, knownPullRequests: [prerequisite] });
  assert.equal(report.candidates[0].status, "present");
  assert.deepEqual(report.conflicts, []);
});

test("unrelated edits to the same file are not reported as a verified prerequisite", async t => {
  const { root, head: base } = await safetyFixture(t, "pr-unrelated-prerequisite");
  const content = Array.from({ length: 60 }, (_, index) => `line ${index}`);
  await writeFile(join(root, "tracked.txt"), content.join("\n") + "\n");
  await git(root, "commit", "-qam", "long source");
  await git(root, "switch", "-qc", "parent");
  content[55] = "independent lower edit";
  await writeFile(join(root, "tracked.txt"), content.join("\n") + "\n"); await git(root, "commit", "-qam", "lower edit");
  const parent = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "-qc", "source"); content[5] = "PR upper edit";
  await writeFile(join(root, "tracked.txt"), content.join("\n") + "\n"); await git(root, "commit", "-qam", "upper edit");
  const head = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "main"); content[55] = "line 55"; content[5] = "destination upper edit";
  await writeFile(join(root, "tracked.txt"), content.join("\n") + "\n"); await git(root, "commit", "-qam", "destination");
  const report = await new PullRequestDependencyService(root, async () => assert.fail("History is loaded"))
    .analyze({ pr: { ...safetyPullRequest(head), baseRefName: "parent" },
      knownPullRequests: [{ ...safetyPullRequest(parent), number: 41, headRefName: "parent" }] });
  assert.equal(report.candidates[0].status, "unchanged");
  assert.notEqual(base, report.beforeHead);
});

test("an unavailable GitHub response is incomplete rather than proof that there are no dependencies", async t => {
  const { root, pr } = await prDependencyFixture(t);
  const report = await new PullRequestDependencyService(root, async () => { throw new Error("offline fixture"); }).analyze({ pr });
  assert.ok(report.limitations.includes("github"));
  assert.equal(report.conflicts.length, 1);
  assert.deepEqual(report.candidates, []);
});

test("discovery and details batch an unknown commit association into two network reads", async t => {
  const { root, parent, prerequisite, pr } = await prDependencyFixture(t);
  let calls = 0;
  const node = { number: 41, title: prerequisite.title, state: "OPEN", url: prerequisite.url,
    headRefName: "prerequisite", headRefOid: parent, baseRefName: "main" };
  const report = await new PullRequestDependencyService(root, async (_args, _root, options) => {
    calls++;
    return JSON.stringify({ data: { repository: options.operation === "pr-prerequisite-discovery"
      ? { current: { headRefOid: pr.headHash }, parents: { nodes: [] }, c0: { associatedPullRequests: { nodes: [node] } } }
      : { p41: { ...node, commits: { nodes: [{ commit: { oid: parent } }], pageInfo: { hasNextPage: false } } } } } });
  }).analyze({ pr: { ...pr, baseRefName: "main" } });
  assert.equal(calls, 2);
  assert.equal(report.candidates[0].pr.number, 41);
  assert.equal(report.candidates[0].status, "resolves");
});

test("a cancelled inspection cannot mutate the original destination", async t => {
  const { root, base, pr } = await prDependencyFixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new PullRequestDependencyService(root).analyze({ pr, signal: controller.signal }), /abort|cancel/i);
  assert.equal(await git(root, "rev-parse", "HEAD"), base);
});

test("a slow metadata read returns already discovered candidates as incomplete at the shared deadline", async t => {
  const { root, parent, prerequisite, pr } = await prDependencyFixture(t);
  const report = await new PullRequestDependencyService(root, async (_args, _root, options) =>
    new Promise<string>((_resolve, reject) => {
      const fail = () => reject(new Error("aborted slow fixture"));
      options.signal?.addEventListener("abort", fail, { once: true });
      if (options.signal?.aborted) fail();
    }), 5_000).analyze({ pr, knownPullRequests: [{ ...prerequisite, headHash: parent, commitHashesComplete: false }] });
  assert.ok(report.limitations.includes("simulation"));
  assert.equal(report.candidates[0].pr.number, 41);
  assert.equal(report.candidates[0].status, "unverified");
});
