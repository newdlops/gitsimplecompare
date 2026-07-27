import assert from "node:assert/strict";
import test from "node:test";
import { DefaultGhRunner, type GhExecute } from "../src/git/ghRunner";
import { PullRequestReviewChecksService } from "../src/git/pullRequestReviewChecksService";

test("PR checks는 최신 head의 CheckRun과 legacy status를 실패 우선으로 정규화한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.checks.required") return JSON.stringify({ strict: true, contexts: ["unit", "legacy"], checks: [{ context: "unit" }] });
    return JSON.stringify({
      data: { repository: { pullRequest: { commits: { nodes: [{
        commit: { statusCheckRollup: { contexts: { nodes: [
          { name: "unit", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/demo/actions/runs/1" },
          { name: "lint", status: "IN_PROGRESS", workflowName: "CI", startedAt: "2026-01-02T03:04:05Z" },
          { context: "legacy", state: "FAILURE", targetUrl: "https://github.com/acme/demo/statuses/1" },
          { name: "invalid-url", status: "COMPLETED", conclusion: "SKIPPED", detailsUrl: "https://example.test/nope" },
        ] } } },
      }] } } } },
    });
  };
  const service = new PullRequestReviewChecksService("/fixture/repo", new DefaultGhRunner(execute));

  const snapshot = await service.getSnapshot("acme/demo", 9, "main");

  assert.equal(snapshot.requiredKnown, true);
  assert.equal(snapshot.requiredCount, 2);
  assert.equal(snapshot.strict, true);
  assert.deepEqual(snapshot.checks.map((check) => [check.name, check.bucket]), [["legacy", "failure"], ["lint", "pending"], ["invalid-url", "skipped"], ["unit", "success"]]);
  assert.deepEqual(snapshot.checks.filter((check) => check.isRequired).map((check) => check.name).sort(), ["legacy", "unit"]);
  assert.equal(snapshot.checks.find((check) => check.name === "invalid-url")?.url, undefined);
  const read = calls.find((call) => call.operation === "review.checks.read");
  const required = calls.find((call) => call.operation === "review.checks.required");
  assert.ok(read?.args.includes("owner=acme"));
  assert.ok(read?.args.includes("name=demo"));
  assert.ok(read?.args.some((arg) => arg.includes("statusCheckRollup")));
  assert.ok(required?.args.includes("repos/acme/demo/branches/main/protection/required_status_checks"));
});

test("branch protection이 없거나 권한이 없으면 checks는 유지하고 Required를 unknown으로 남긴다", async () => {
  const execute: GhExecute = async (_args, _cwd, options) => {
    if (options.operation === "review.checks.required") throw new Error("HTTP 404: Branch not protected");
    return JSON.stringify({
      data: { repository: { pullRequest: { commits: { nodes: [{
        commit: { statusCheckRollup: { contexts: { nodes: [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }] } } },
      }] } } } },
    });
  };
  const service = new PullRequestReviewChecksService("/fixture/repo", new DefaultGhRunner(execute));

  const snapshot = await service.getSnapshot("acme/demo", 9, "release/next");

  assert.equal(snapshot.requiredKnown, false);
  assert.equal(snapshot.checks[0]?.isRequired, false);
});
