import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { PullRequestDependencyService } from "../src/git/pullRequestDependencyService";
import type { PullRequestDependencyReport } from "../src/git/pullRequestDependencies";
import { PullRequestOperationSnapshot } from "../src/git/pullRequestOperationSnapshot";
import { GitLogService } from "../src/git/gitLogService";
import { listPrOperationWorktrees } from "../src/git/temporaryWorktree";
import { handlePullRequestAction } from "../src/webview/graphPullRequestActions";
import { showPullRequestDependencies, offerPullRequestDependencies } from "../src/ui/pullRequestDependencies";
import { pickPullRequestAction } from "../src/webview/graphPullRequestActionPicker";
import { prDependencyFixture } from "./helpers/prDependencyFixture";
import { prSafetyFixture } from "./helpers/prOperationSafetyFixture";
import { git } from "./helpers/gitSafetyFixture";
import { safetyPullRequest } from "./helpers/prOperationSafetyFixture";
import * as vscode from "./helpers/vscodeMock";

/** 실제 결과와 같은 표시 fixture를 만들어 후보 근거와 적용 효과를 별도로 검증한다. */
function report(status: "resolves" | "unverified" | "present" = "resolves"): PullRequestDependencyReport {
  return { prNumber: 42, beforeHead: "a".repeat(40), branch: "production", conflicts: ["기능\tfile.ts"], limitations: [],
    candidates: [{ pr: { ...safetyPullRequest("b".repeat(40)), number: 41,
      title: "아주 긴 선행 PR 제목 ".repeat(16), url: "https://example.invalid/owner/repo/pull/41" },
    reasons: ["history"], sourceCommits: ["b".repeat(40)], status }] };
}

test("verified and unverified prerequisites produce different notifications and never apply another PR", async t => {
  for (const status of ["resolves", "unverified", "present"] as const) {
    vscode.__resetWindowMessages();
    const mock = t.mock.method(PullRequestDependencyService.prototype, "analyze", async () => report(status));
    await offerPullRequestDependencies("/unused", { pr: safetyPullRequest("a".repeat(40)) }, "Original conflict remains available.");
    const message = vscode.__warningMessages[0];
    if (status === "resolves") assert.match(message, /#41.*simulation/);
    if (status === "unverified") assert.match(message, /Possible prerequisite.*#41.*not been verified/);
    if (status === "present") assert.doesNotMatch(message, /prerequisite PRs:|Applying #41/);
    assert.equal(vscode.__executedCommands.length, 0);
    mock.mock.restore();
  }
});

test("long titles, conflict paths, partial inspection and candidate evidence remain available in the native list", async () => {
  vscode.__resetWindowMessages();
  const input = report(); input.limitations.push("github");
  vscode.__setQuickPickResult((items: any[]) => items[0]);
  await showPullRequestDependencies(input);
  const items = vscode.__quickPickItems[0] as any[];
  assert.match(items[0].label, /#41.*conflicts resolved in simulation/);
  assert.equal(items[0].description, input.candidates[0].pr.title.trim());
  assert.match(items[0].detail, /source history.*https:\/\/example.invalid/);
  assert.ok(items.some(item => /#41 → #42/.test(item.label) && /Return to Working Tree.*#41.*retry #42/.test(item.detail)));
  assert.ok(items.some(item => item.detail?.includes("기능\\tfile.ts")));
  assert.ok(items.some(item => item.detail?.includes("GitHub metadata was unavailable")));
  assert.equal(vscode.__externalUris.length, 1);
  assert.equal(vscode.__executedCommands.length, 0);
});

test("empty inspection explains uncertainty and rejects a non-HTTPS PR link", async () => {
  vscode.__resetWindowMessages();
  const empty = report(); empty.candidates = [];
  await showPullRequestDependencies(empty);
  assert.match((vscode.__quickPickItems[0][0] as any).detail, /does not prove/);
  const invalid = report(); invalid.candidates[0].pr.url = "command:unsafe";
  vscode.__setQuickPickResult((items: any[]) => items[0]);
  await showPullRequestDependencies(invalid);
  assert.equal(vscode.__externalUris.length, 0);
});

test("the existing default PR action stays first and inspection is explicitly selectable", async () => {
  vscode.__resetWindowMessages();
  vscode.__setQuickPickResult((items: any[]) => items.find(item => item.action === "dependencies"));
  assert.equal(await pickPullRequestAction(42), "dependencies");
  assert.equal((vscode.__quickPickItems[0][0] as any).action, "squash");
});

test("a real graph squash pause names the verified prerequisite and preserves the original branch", async t => {
  const { root, base, prerequisite, pr } = await prDependencyFixture(t);
  vscode.__resetWindowMessages(); vscode.__setWarningMessageResult("Squash Cherry-pick");
  await handlePullRequestAction({ logService: new GitLogService(root), pullRequests: () => [pr, prerequisite], refreshGraph: async () => {} }, 42, "squash");
  const worktrees = await listPrOperationWorktrees(root);
  t.after(async () => { for (const item of worktrees) await rm(item.path, { recursive: true, force: true }); });
  assert.ok(vscode.__warningMessages.some(message => /Applying #41 first resolves/.test(message)));
  assert.ok(vscode.__executedCommands.some(command => command.id === "gitSimpleCompare.resumePrOperation"));
  assert.equal(await git(root, "rev-parse", "HEAD"), base);
});

test("successful PR application does not run prerequisite analysis", async t => {
  const { root, pr } = await prSafetyFixture(t);
  vscode.__resetWindowMessages(); vscode.__setWarningMessageResult("Squash Cherry-pick");
  t.mock.method(PullRequestDependencyService.prototype, "analyze", async () => assert.fail("Fast path must not inspect dependencies"));
  await handlePullRequestAction({ logService: new GitLogService(root), pullRequests: () => [pr], refreshGraph: async () => {} }, 42, "squash");
  assert.ok(vscode.__informationMessages.some(message => /squash cherry-picked/.test(message)));
  assert.equal(await new PullRequestOperationSnapshot(root).hasUnmergedChanges(), false);
});
