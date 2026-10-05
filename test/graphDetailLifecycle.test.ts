import assert from "node:assert/strict";
import test from "node:test";
import { GraphCommitDetailSender } from "../src/webview/graphCommitDetails";
import { GitLogService, ONGOING_COMMIT_HASH, STAGED_COMMIT_HASH } from "../src/git/gitLogService";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import type { CommitDetail } from "../src/graph/graphTypes";
import type { ToWebviewMessage } from "../src/webview/graphProtocol";
import { safetyFixture } from "./helpers/gitSafetyFixture";
import { fetchPullRequestDetail } from "../src/git/pullRequestDetail";
import type { GhExecute } from "../src/git/ghRunner";

/** 최소 상세 DTO를 만들어 오래된 선택 결과와 현재 선택 결과를 구별한다. */
function detail(hash: string): CommitDetail {
  return { hash, parents: [], authorName: "Author", authorEmail: "a@example.test", authorDateIso: "2026-01-01",
    message: hash, branches: [], files: [] };
}

test("a native commit summary and full drawer share exactly one header query", async t => {
  const { root, head } = await safetyFixture(t, "header-once"); const messages: ToWebviewMessage[] = [];
  const commands: string[] = []; const release = setGitExecutionObserver(timing => commands.push(timing.command));
  try { await new GraphCommitDetailSender().send(head, new GitLogService(root), message => messages.push(message)); }
  finally { release(); }
  assert.equal(commands.filter(command => command === "show").length, 1);
  const results = messages.filter((message): message is Extract<ToWebviewMessage, { type: "commitDetail" }> => message.type === "commitDetail");
  assert.equal(results.length, 2); assert.equal(results[0].detail.loading, true);
  assert.equal(results[1].detail.loading, undefined); assert.equal(results[1].detail.hash, head);
  assert.equal(results[0].detail.message, results[1].detail.message);
  assert.equal(results[1].detail.files[0].path, "tracked.txt");
});

test("selecting a different commit aborts the old consumer and suppresses even a late successful result", async () => {
  const reads: Array<{ hash: string; signal: AbortSignal; resolve(value: CommitDetail): void }> = [];
  const service = { repoRoot: "/fixture", getCommitDetail(hash: string, signal: AbortSignal) {
    return new Promise<CommitDetail>(resolve => reads.push({ hash, signal, resolve }));
  } } as unknown as GitLogService;
  const sender = new GraphCommitDetailSender(), messages: ToWebviewMessage[] = [];
  const first = sender.send(ONGOING_COMMIT_HASH, service, message => messages.push(message));
  const second = sender.send(STAGED_COMMIT_HASH, service, message => messages.push(message));
  assert.equal(reads[0].signal.aborted, true); assert.equal(reads[1].signal.aborted, false);
  reads[1].resolve(detail(STAGED_COMMIT_HASH)); await second;
  reads[0].resolve(detail(ONGOING_COMMIT_HASH)); await first;
  assert.deepEqual(messages, [{ type: "commitDetail", detail: detail(STAGED_COMMIT_HASH) }]);
  const third = sender.send(ONGOING_COMMIT_HASH, service, message => messages.push(message));
  sender.cancel("hidden"); assert.equal(reads[2].signal.aborted, true); reads[2].resolve(detail(ONGOING_COMMIT_HASH)); await third;
  assert.equal(messages.length, 1);
});

test("current detail failures remain visible to the caller and can be retried", async () => {
  const service = { repoRoot: "/fixture", getCommitDetail: async () => { throw new Error("fixture failure"); } } as unknown as GitLogService;
  const sender = new GraphCommitDetailSender(); await assert.rejects(sender.send(ONGOING_COMMIT_HASH, service, () => {}), /fixture failure/);
  service.getCommitDetail = async () => detail(ONGOING_COMMIT_HASH);
  const messages: ToWebviewMessage[] = []; await sender.send(ONGOING_COMMIT_HASH, service, message => messages.push(message));
  assert.equal(messages.length, 1);
});

test("PR detail cancellation reaches its CLI reader and keeps failure cancellation local", async () => {
  const controller = new AbortController(); let signal!: AbortSignal;
  const runner: GhExecute = async (_args, _root, options) => {
    signal = options.signal!;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
  };
  const pending = fetchPullRequestDetail("/fixture", "owner/repo", 1, controller.signal, runner);
  const rejected = assert.rejects(pending, { name: "AbortError" }); controller.abort(); await rejected;
  assert.equal(signal.aborted, true);
});
