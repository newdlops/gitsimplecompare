import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Commit } from "../src/graph/graphTypes";
import { createGraphRefreshFingerprint, readGraphRefreshSnapshot } from "../src/git/graphRefreshFingerprint";
import { canReuseGraphHistory, syncGraphReferenceTips } from "../src/webview/graphHistoryReuse";
import { runGit } from "../src/git/gitExec";
import { GitLogService } from "../src/git/gitLogService";

const oid = (value: number) => value.toString(16).padStart(40, "0");
/** 현재 읽은 DAG를 벗어난 조상은 배열에 넣지 않아 경계 추측을 검출한다. */
function rows(): Commit[] {
  return [3, 2, 1].map(value => ({ hash: oid(value), parents: value > 1 ? [oid(value - 1)] : [], refs: [],
    subject: `${value}`, authorName: "Fixture", authorEmail: "fixture@example.invalid", dateIso: "" }));
}
/** Graph fingerprint의 실제 ref/worktree 구조를 사용한다. */
function snapshot(head: number, refs: Record<string, number>, worktreeHeads: number[] = []) {
  return createGraphRefreshFingerprint({ head: oid(head), symbolicHead: "refs/heads/main",
    refs: Object.entries(refs).map(([name, value]) => `refs/${name} ${oid(value)}`),
    worktrees: worktreeHeads.map((value, index) => `worktree /linked-${index}\nHEAD ${oid(value)}\ndetached`) });
}

test("checkout, rename and a push to an already loaded descendant preserve the reachable history", () => {
  const before = snapshot(3, { "heads/main": 3, "heads/topic": 2, "remotes/origin/main": 1 });
  assert.equal(canReuseGraphHistory(before, snapshot(2, { "heads/main": 3, "heads/topic": 2, "remotes/origin/main": 1 }), rows()), true);
  assert.equal(canReuseGraphHistory(before, snapshot(3, { "heads/main": 3, "heads/renamed": 2, "remotes/origin/main": 1 }), rows()), true);
  assert.equal(canReuseGraphHistory(before, snapshot(3, { "heads/main": 3, "heads/topic": 2, "remotes/origin/main": 3 }), rows()), true);
});

test("new commits, orphan removal, changed tags and stash or recovery refs require a fresh log", () => {
  const before = snapshot(3, { "heads/main": 3, "heads/orphan": 9, "tags/v1": 1 });
  for (const next of [snapshot(4, { "heads/main": 4, "heads/orphan": 9, "tags/v1": 1 }),
    snapshot(3, { "heads/main": 3, "tags/v1": 1 }), snapshot(3, { "heads/main": 3, "heads/orphan": 9, "tags/v1": 2 }),
    snapshot(3, { "heads/main": 3, "heads/orphan": 9, "tags/v1": 1, "stash": 8 }),
    snapshot(3, { "heads/main": 3, "heads/orphan": 9, "tags/v1": 1, "gitsimplecompare/snapshot": 8 })]) {
    assert.equal(canReuseGraphHistory(before, next, rows()), false);
  }
  assert.equal(canReuseGraphHistory(undefined, before, rows()), false);
  assert.equal(canReuseGraphHistory(before, before, []), false);
});

test("a changed detached linked worktree participates in the all-refs history proof", () => {
  const refs = { "heads/main": 3 };
  assert.equal(canReuseGraphHistory(snapshot(3, refs, [9]), snapshot(3, refs, [10]), rows()), false);
  assert.equal(canReuseGraphHistory(snapshot(3, refs, [1]), snapshot(3, refs, [2]), rows()), true);
  assert.equal(canReuseGraphHistory(snapshot(3, refs), snapshot(9, refs), rows()), false);
});

test("history proof never guesses beyond the last loaded parent link", () => {
  const graph = rows().slice(0, 1);
  const before = snapshot(3, { "heads/main": 3, "remotes/origin/main": 1 });
  const after = snapshot(3, { "heads/main": 3, "remotes/origin/main": 3 });
  assert.equal(canReuseGraphHistory(before, after, graph), false);
});

test("real Git decorations remain exact through checkout, push tracking, rename and detached HEAD", { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-ref-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(["init", "-q", "--initial-branch=main"], root);
  await runGit(["config", "user.name", "Fixture"], root); await runGit(["config", "user.email", "fixture@example.invalid"], root);
  await runGit(["config", "core.fsmonitor", "false"], root); await runGit(["config", "commit.gpgSign", "false"], root);
  for (let index = 0; index < 4; index++) {
    await writeFile(path.join(root, "file.txt"), `${index}\n`);
    await runGit(["add", "file.txt"], root); await runGit(["commit", "-qm", `Commit ${index}`], root);
  }
  await runGit(["branch", "topic", "HEAD~1"], root);
  await runGit(["tag", "main", "HEAD~2"], root);
  await runGit(["update-ref", "refs/remotes/origin/main", "HEAD~2"], root);
  await runGit(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], root);
  const service = new GitLogService(root);
  let previous = await readGraphRefreshSnapshot(root), graph = await service.getCommitPage(20, 0, [], false);
  /** 실제 명령 뒤의 ref-only 결과가 Git의 완전한 재조회와 같아야 한다. */
  const check = async (args: string[]) => {
    await runGit(args, root);
    const next = await readGraphRefreshSnapshot(root);
    assert.equal(canReuseGraphHistory(previous.fingerprint, next.fingerprint, graph), true, args.join(" "));
    syncGraphReferenceTips(graph, previous.fingerprint, next.fingerprint);
    const complete = await service.getCommitPage(20, 0, [], false);
    const refs = (values: Commit[]) => new Map(values.map(commit => [commit.hash, [...new Set(commit.refs)].sort()]));
    assert.deepEqual(refs(graph), refs(complete)); previous = next;
  };
  await check(["checkout", "-q", "topic"]);
  await check(["update-ref", "refs/remotes/origin/main", "refs/heads/main"]);
  await check(["branch", "-m", "topic-renamed"]);
  await check(["checkout", "-q", "--detach", "HEAD~1"]);
  const beforeStash = await readGraphRefreshSnapshot(root);
  await writeFile(path.join(root, "file.txt"), "unstaged\n");
  await runGit(["stash", "push", "-qm", "owned fixture stash"], root);
  const afterStash = await readGraphRefreshSnapshot(root);
  assert.notEqual(beforeStash.fingerprint, afterStash.fingerprint);
  assert.equal(canReuseGraphHistory(beforeStash.fingerprint, afterStash.fingerprint, graph), false);
});
