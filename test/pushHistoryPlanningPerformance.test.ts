import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { runGit, runGitStreamWithInput, runGitWithInput } from "../src/git/gitExec";
import { pushBranchCommits, SEQUENTIAL_PUSH_THRESHOLD_BYTES, type PushGitRunner } from "../src/git/sequentialPush";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** @param t 임시 저장소 수명 @param count 작은 outgoing commit 수 @returns 원격과 별도 history 브랜치가 준비된 실제 저장소 */
async function historyFixture(t: TestContext, count = 4000) {
  const fixture = await safetyFixture(t, "push-history-planning");
  const remote = await addOrigin(fixture.root, fixture.directory);
  const input: string[] = [];
  for (let index = 1; index <= count; index++) {
    const text = `content ${index}\n`;
    input.push(`commit refs/heads/history\nmark :${index}\ncommitter Planning <planning@example.test> ${1_900_000_000 + index} +0000\ndata ${Buffer.byteLength(text)}\n${text}from ${index === 1 ? fixture.head : `:${index - 1}`}\nM 100644 inline history.txt\ndata ${Buffer.byteLength(text)}\n${text}\n`);
  }
  await runGitWithInput(["fast-import", "--quiet"], fixture.root, input.join("") + "done\n");
  return { ...fixture, remote, count };
}

/** 실제 Git 결과를 변경하지 않고 커밋 목록·조상 검사·객체 크기 조회의 비용만 관찰한다. */
function observe() {
  const historyRows: number[] = []; let ancestry = 0, metadata = 0;
  const runner: PushGitRunner = {
    run: async (args, root, options) => {
      if (args[0] === "merge-base") ancestry++;
      const output = await runGit(args, root, options);
      if (args[0] === "rev-list" && args.includes("--first-parent")) historyRows.push(output.trim().split("\n").filter(Boolean).length);
      return output;
    },
    input: runGitWithInput,
    inputStream: async (...args) => { metadata++; return runGitStreamWithInput(...args); },
  };
  return { runner, historyRows, counts: () => ({ ancestry, metadata }) };
}

test("a small push with thousands of outgoing commits does not materialize its entire commit sequence", async t => {
  const f = await historyFixture(t), observed = observe();
  const head = await git(f.root, "rev-parse", "history"), index = await readFile(join(f.root, ".git", "index"));
  await writeFile(join(f.root, "keep.txt"), "untracked work\n");
  const started = performance.now();
  const result = await pushBranchCommits(f.root, { branch: "history", head, remote: "origin", targetRef: "refs/heads/main" }, {}, observed.runner);
  t.diagnostic(JSON.stringify({ kind: "small-history", historyRows: observed.historyRows, ...observed.counts(), elapsedMs: Math.round(performance.now() - started) }));
  assert.equal(result.strategy, "single"); assert.ok(result.estimatedBytes! < SEQUENTIAL_PUSH_THRESHOLD_BYTES);
  assert.equal(await git(f.remote, "rev-parse", "main"), head);
  assert.deepEqual(await readFile(join(f.root, ".git", "index")), index);
  assert.equal(await readFile(join(f.root, "keep.txt"), "utf8"), "untracked work\n");
  assert.ok(observed.historyRows.every(rows => rows <= 2), `materialized ${observed.historyRows.join(", ")} commits`);
});

test("a merge whose second parent is the remote tip checks only its two newest first-parent commits", async t => {
  const f = await historyFixture(t), observed = observe();
  await git(f.root, "switch", "-qc", "remote-side");
  const remoteHead = await commitText(f.root, "remote side\n", "remote side");
  await git(f.root, "push", "origin", "HEAD:main");
  await git(f.root, "switch", "history"); await git(f.root, "merge", "--no-ff", "remote-side", "-m", "integrate remote");
  const head = await git(f.root, "rev-parse", "HEAD");
  const started = performance.now();
  const result = await pushBranchCommits(f.root, { branch: "history", head, remote: "origin", targetRef: "refs/heads/main" }, {}, observed.runner);
  t.diagnostic(JSON.stringify({ kind: "second-parent", historyRows: observed.historyRows, ...observed.counts(), elapsedMs: Math.round(performance.now() - started) }));
  assert.equal(result.strategy, "single"); assert.equal(result.total, 1);
  assert.equal(await git(f.remote, "rev-parse", "main"), head);
  await git(f.remote, "merge-base", "--is-ancestor", remoteHead, "main");
  assert.ok(observed.historyRows.every(rows => rows <= 2), `materialized ${observed.historyRows.join(", ")} commits`);
  assert.equal(observed.counts().metadata, 0); assert.ok(observed.counts().ancestry <= 2);
});
