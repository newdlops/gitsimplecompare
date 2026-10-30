import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { GitError } from "../src/git/gitExec";
import { GitLogService } from "../src/git/gitLogService";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { pullRequestInfoFromGraphQl } from "../src/git/pullRequestInfo";
import { PullRequestService } from "../src/git/pullRequestService";
import { PullRequestStackService } from "../src/git/pullRequestStackService";
import { resolveBranchFilter } from "../src/webview/graphBranchFilter";
import { loadFilteredGraphCommitWindow } from "../src/webview/graphCommitWindowLoading";
import { createOperationGraphPanel } from "./helpers/graphOperationPanel";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";
import { __outputLines } from "./helpers/vscodeMock";

/**
 * catalog 준비 뒤 망가진 ref를 만들고, 복구 과정에서 보존해야 할 원본 바이트를 기록한다.
 * @param root 소유한 임시 Git 저장소 @param ref 누락 객체를 가리키게 할 ref 경로
 * @returns HEAD·index·config·작업 파일·손상 ref의 변경 여부를 읽는 함수
 */
async function brokenRef(root: string, ref: string) {
  const file = path.join(root, ".git", ref);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "a".repeat(40) + "\n");
  await writeFile(path.join(root, "tracked.txt"), "local changes must survive navigation\n");
  return async () => ({ head: await git(root, "rev-parse", "HEAD"),
    index: await readFile(path.join(root, ".git/index")), config: await readFile(path.join(root, ".git/config")),
    tracked: await readFile(path.join(root, "tracked.txt")), ref: await readFile(file) });
}

for (const ref of ["refs/remotes/origin/unrelated", "refs/heads/unrelated"]) {
  test(`All branches PR jump survives an unrelated invalid ref: ${ref}`, async t => {
    const f = await safetyFixture(t, "pr-jump-invalid-ref");
    const filter = resolveBranchFilter({ mode: "all", selected: [], compact: true }, [{ name: "main", kind: "local" }]);
    const state = await brokenRef(f.root, ref), before = await state();
    const start = __outputLines.length;
    const window = await loadFilteredGraphCommitWindow(f.root, [f.head], filter, 10);
    assert.equal(window?.hash, f.head);
    assert.deepEqual(window?.commits.map(commit => commit.hash), [f.head]);
    assert.deepEqual(await state(), before, "navigation must not repair refs or alter the working tree");
    assert.ok(__outputLines.slice(start).some(line => line.includes("graph commit window history unavailable; recovering valid references")));
  });
}

test("the registered PR jump route publishes the selected local commit despite an unrelated broken remote ref", async t => {
  const f = await safetyFixture(t, "pr-jump-invalid-route");
  const pr = pullRequestInfoFromGraphQl({ number: 42, state: "OPEN", title: "Known local PR",
    headRefOid: f.head, headRefName: "feature", baseRefName: "main" });
  t.mock.method(PullRequestService.prototype, "getOverview", async () => ({ available: true, repository: "owner/repo", pullRequests: [pr] }));
  t.mock.method(PullRequestStackService.prototype, "getGraphSnapshot", async () => ({ repository: "owner/repo", layers: [] } as any));
  const h = createOperationGraphPanel(t, new GitLogService(f.root));
  t.after(() => h.panel.dispose());
  await h.panel.messages.refreshPullRequests("native-reproduction");
  const state = await brokenRef(f.root, "refs/remotes/origin/unrelated"), before = await state();
  await h.receiveMessage({ type: "ensureCommitVisible", requestId: "broken-ref-pr-jump", hashes: [f.head], pullRequestNumber: 42 });
  assert.deepEqual(h.messages.filter(message => message.type === "commitVisibility"),
    [{ type: "commitVisibility", requestId: "broken-ref-pr-jump", found: true, hash: f.head }]);
  assert.ok(h.messages.some(message => message.type === "graph" && message.data.rows.some(row => row.hash === f.head)));
  assert.deepEqual(await state(), before);
});

test("invalid custom scope remains an error instead of silently expanding to the selected PR", async t => {
  const f = await safetyFixture(t, "pr-jump-invalid-custom");
  await brokenRef(f.root, "refs/heads/unrelated");
  const filter = resolveBranchFilter({ mode: "custom", selected: ["unrelated"], compact: true }, [{ name: "unrelated", kind: "local" }]);
  await assert.rejects(loadFilteredGraphCommitWindow(f.root, [f.head], filter, 10), GitError);
});

test("cancellation while the invalid history read finishes never starts a direct target fallback", async t => {
  const f = await safetyFixture(t, "pr-jump-invalid-cancel");
  await brokenRef(f.root, "refs/remotes/origin/unrelated");
  const controller = new AbortController(), commands: string[] = [];
  const stop = setGitExecutionObserver(row => {
    commands.push(row.command);
    if (row.command === "rev-list" && row.outcome === "error") controller.abort();
  });
  t.after(stop);
  await assert.rejects(loadFilteredGraphCommitWindow(f.root, [f.head],
    resolveBranchFilter({ mode: "all", selected: [], compact: true }, []), 10, controller.signal));
  assert.deepEqual(commands, ["cat-file", "rev-list"]);
});

test("a failed full-history read never turns a missing or noncommit target into a successful jump", async t => {
  const f = await safetyFixture(t, "pr-jump-invalid-missing");
  const tree = await git(f.root, "rev-parse", "HEAD^{tree}");
  const state = await brokenRef(f.root, "refs/remotes/origin/unrelated"), before = await state();
  const commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command));
  t.after(stop);
  const window = await loadFilteredGraphCommitWindow(f.root, ["b".repeat(40), tree],
    resolveBranchFilter({ mode: "all", selected: [], compact: true }, []), 10);
  assert.equal(window, undefined);
  assert.deepEqual(commands, ["cat-file"]);
  stop();
  assert.deepEqual(await state(), before);
});
