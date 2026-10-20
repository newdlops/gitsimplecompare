import assert from "node:assert/strict";
import test from "node:test";
import { parseRefs } from "../src/git/gitLogRefs";
import { parseGitLogOutput, gitLogPrettyFormat } from "../src/git/gitLogParse";
import { GitLogService } from "../src/git/gitLogService";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

test("full ref decorations distinguish Git annotations, comma names and real annotation-named branches", () => {
  assert.deepEqual(parseRefs("grafted, HEAD -> refs/heads/grafted, refs/heads/feature,comma, tag: refs/tags/replaced, refs/remotes/origin/main, replaced", true),
    ["HEAD", "grafted", "feature,comma", "tag:replaced", "origin/main"]);
  assert.deepEqual(parseRefs("grafted, HEAD, replaced", true), ["HEAD"]);
  assert.deepEqual(parseRefs("HEAD -> main, origin/main, tag: v1"), ["HEAD", "main", "origin/main", "tag:v1"]);
});

test("full ref mode is preserved across zero-separated commit parsing", () => {
  const entry = ["a".repeat(40), "", "Fixture", "fixture@example.invalid", "2026-10-20T00:00:00Z", "grafted, HEAD -> refs/heads/main", "fixture"].join("\x1f");
  assert.equal(gitLogPrettyFormat().split("\x1f").length, 7);
  assert.deepEqual(parseGitLogOutput(entry + "\0", true)[0].refs, ["HEAD", "main"]);
});

test("native shallow Git keeps legal comma and annotation-named refs without displaying synthetic branches", async t => {
  const f = await safetyFixture(t, "git-decoration-safety");
  await git(f.root, "branch", "feature,comma"); await git(f.root, "branch", "grafted");
  await git(f.root, "branch", "replaced"); await git(f.root, "tag", "grafted");
  await writeFile(join(f.root, ".git", "shallow"), `${f.head}\n`);
  const rows = await new GitLogService(f.root).getCommitPage(10, 0, [], false);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].refs.sort(), ["HEAD", "feature,comma", "grafted", "replaced", "main", "tag:grafted"].sort());
});
