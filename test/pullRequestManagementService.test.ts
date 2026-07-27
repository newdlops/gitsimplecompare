import assert from "node:assert/strict";
import test from "node:test";
import { DefaultGhRunner, type GhExecute } from "../src/git/ghRunner";
import {
  managementMutationToApply,
  previewPullRequestManagementMutation,
  PullRequestManagementService,
} from "../src/git/pullRequestManagementService";

test("관리 서비스는 assignee 추가 뒤 authoritative issue metadata를 재조회한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.management.metadata.read") {
      return JSON.stringify({ assignees: [{ login: "alice" }], labels: [{ name: "ready" }] });
    }
    if (options.operation === "review.management.reviewers.read") return JSON.stringify({ users: [], teams: [] });
    if (options.operation === "review.management.stage.read") return JSON.stringify({ draft: false });
    return "";
  };
  const service = new PullRequestManagementService("/fixture/repo", new DefaultGhRunner(execute));

  const result = await service.apply(
    { repository: "acme/demo", number: 7 },
    { kind: "addAssignees", logins: [" alice ", "alice"] }
  );

  assert.equal(result.verified, true);
  assert.deepEqual(result.metadata, { assignees: ["alice"], labels: ["ready"], requestedReviewers: [], isDraft: false });
  assert.equal(calls[0]?.operation, "review.management.assignees.add");
  assert.ok(calls.some((call) => call.operation === "review.management.metadata.read"));
  assert.ok(calls.some((call) => call.operation === "review.management.reviewers.read"));
  assert.ok(calls.some((call) => call.operation === "review.management.stage.read"));
  assert.ok(calls[0]?.args.includes("repos/acme/demo/issues/7"));
  assert.ok(calls[0]?.args.includes("assignees[]=alice"));
});

test("관리 서비스는 label 제거가 서버에서 무시되면 partial mismatch로 보존한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.management.metadata.read") {
      return JSON.stringify({ assignees: [], labels: [{ name: "blocked" }] });
    }
    if (options.operation === "review.management.reviewers.read") return JSON.stringify({ users: [], teams: [] });
    if (options.operation === "review.management.stage.read") return JSON.stringify({ draft: false });
    return "";
  };
  const service = new PullRequestManagementService("/fixture/repo", new DefaultGhRunner(execute));

  const result = await service.apply(
    { repository: "acme/demo", number: 7 },
    { kind: "removeLabels", names: ["blocked"] }
  );

  assert.equal(result.verified, false);
  assert.deepEqual(result.mismatches, ["blocked"]);
  assert.ok(calls[0]?.args.includes("repos/acme/demo/issues/7/labels/blocked"));
});

test("관리 preview는 실제 적용값과 이미 원하는 상태인 값을 분리한다", () => {
  const preview = previewPullRequestManagementMutation(
    { assignees: ["alice"], labels: ["blocked"], requestedReviewers: [], isDraft: false },
    { kind: "addLabels", names: ["blocked", "ready", " ready "] }
  );

  assert.deepEqual(preview.mutation, { kind: "addLabels", names: ["blocked", "ready"] });
  assert.deepEqual(preview.willApply, ["ready"]);
  assert.deepEqual(preview.alreadySet, ["blocked"]);
  assert.equal(preview.canApply, true);
  assert.deepEqual(managementMutationToApply(preview), { kind: "addLabels", names: ["ready"] });
});

test("관리 서비스는 사용자와 팀 review request 뒤 두 종류를 authoritative하게 확인한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.management.metadata.read") return JSON.stringify({ assignees: [], labels: [] });
    if (options.operation === "review.management.reviewers.read") {
      return JSON.stringify({ users: [{ login: "alice" }], teams: [{ slug: "platform", name: "Platform" }] });
    }
    if (options.operation === "review.management.stage.read") return JSON.stringify({ draft: false });
    return "";
  };
  const service = new PullRequestManagementService("/fixture/repo", new DefaultGhRunner(execute));

  const result = await service.apply(
    { repository: "acme/demo", number: 7 },
    { kind: "requestReviewers", reviewers: ["alice"], teamReviewers: ["platform"] }
  );

  assert.equal(result.verified, true);
  assert.deepEqual(result.metadata.requestedReviewers, [
    { kind: "user", key: "alice", label: "alice" },
    { kind: "team", key: "platform", label: "Platform" },
  ]);
  assert.equal(calls[0]?.operation, "review.management.reviewers.request");
  assert.ok(calls[0]?.args.includes("repos/acme/demo/pulls/7/requested_reviewers"));
  assert.ok(calls[0]?.args.includes("reviewers[]=alice"));
  assert.ok(calls[0]?.args.includes("team_reviewers[]=platform"));
});

test("Draft stage preview와 GraphQL write는 현재 stage를 서버 재조회로 검증한다", async () => {
  const preview = previewPullRequestManagementMutation(
    { assignees: [], labels: [], requestedReviewers: [], isDraft: false },
    { kind: "setDraftState", isDraft: true }
  );
  assert.deepEqual(preview.willApply, ["Draft"]);
  assert.deepEqual(managementMutationToApply(preview), { kind: "setDraftState", isDraft: true });

  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.management.metadata.read") return JSON.stringify({ assignees: [], labels: [] });
    if (options.operation === "review.management.reviewers.read") return JSON.stringify({ users: [], teams: [] });
    if (options.operation === "review.management.stage.read") return JSON.stringify({ draft: true });
    return JSON.stringify({ data: { convertPullRequestToDraft: { clientMutationId: null } } });
  };
  const service = new PullRequestManagementService("/fixture/repo", new DefaultGhRunner(execute));
  const result = await service.apply(
    { repository: "acme/demo", number: 7, pullRequestId: "PR_example" },
    { kind: "setDraftState", isDraft: true }
  );

  assert.equal(result.verified, true);
  assert.equal(calls[0]?.operation, "review.management.stage.draft");
  assert.ok(calls[0]?.args.includes("pullRequestId=PR_example"));
  assert.ok(calls[0]?.args.some((arg) => arg.includes("convertPullRequestToDraft")));
});

test("milestone 설정은 preview 후 Issue PATCH와 authoritative post-read로 검증한다", async () => {
  const preview = previewPullRequestManagementMutation(
    { assignees: [], labels: [], requestedReviewers: [], isDraft: false },
    { kind: "setMilestone", milestoneNumber: 12 }
  );
  assert.deepEqual(preview.willApply, ["Milestone #12"]);
  assert.deepEqual(managementMutationToApply(preview), { kind: "setMilestone", milestoneNumber: 12 });

  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.management.metadata.read") return JSON.stringify({ assignees: [], labels: [], milestone: { number: 12, title: "Release" } });
    if (options.operation === "review.management.reviewers.read") return JSON.stringify({ users: [], teams: [] });
    if (options.operation === "review.management.stage.read") return JSON.stringify({ draft: false });
    return "";
  };
  const service = new PullRequestManagementService("/fixture/repo", new DefaultGhRunner(execute));
  const result = await service.apply({ repository: "acme/demo", number: 7 }, { kind: "setMilestone", milestoneNumber: 12 });

  assert.equal(result.verified, true);
  assert.deepEqual(result.metadata.milestone, { number: 12, title: "Release" });
  assert.equal(calls[0]?.operation, "review.management.milestone.set");
  assert.ok(calls[0]?.args.includes("repos/acme/demo/issues/7"));
  assert.ok(calls[0]?.args.includes("milestone=12"));
});

test("milestone 제거 preview는 현재 milestone이 없으면 no-op으로 구분한다", () => {
  const preview = previewPullRequestManagementMutation(
    { assignees: [], labels: [], requestedReviewers: [], isDraft: false },
    { kind: "setMilestone", milestoneNumber: null }
  );
  assert.equal(preview.canApply, false);
  assert.deepEqual(preview.alreadySet, ["No milestone"]);
});

test("milestone 제거는 JSON null PATCH 뒤 없는 상태를 authoritative하게 확인한다", async () => {
  const calls: Array<{ operation: string; args: readonly string[] }> = [];
  const execute: GhExecute = async (args, _cwd, options) => {
    calls.push({ operation: options.operation, args });
    if (options.operation === "review.management.metadata.read") return JSON.stringify({ assignees: [], labels: [], milestone: null });
    if (options.operation === "review.management.reviewers.read") return JSON.stringify({ users: [], teams: [] });
    if (options.operation === "review.management.stage.read") return JSON.stringify({ draft: false });
    return "";
  };
  const service = new PullRequestManagementService("/fixture/repo", new DefaultGhRunner(execute));

  const result = await service.apply({ repository: "acme/demo", number: 7 }, { kind: "setMilestone", milestoneNumber: null });

  assert.equal(result.verified, true);
  assert.equal(result.metadata.milestone, undefined);
  assert.equal(calls[0]?.operation, "review.management.milestone.set");
  assert.ok(calls[0]?.args.includes("milestone=null"));
});
