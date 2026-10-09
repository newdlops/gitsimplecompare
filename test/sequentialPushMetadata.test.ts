import assert from "node:assert/strict";
import test from "node:test";
import { pushBranchCommits, type BranchPushTarget, type PushGitRunner } from "../src/git/sequentialPush";
import { runGit, runGitStreamWithInput, runGitWithInput } from "../src/git/gitExec";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 main의 고정 OID와 remote ref를 준비해 parser 검증도 production 계획 경계를 통과시킨다. */
async function target(root: string): Promise<BranchPushTarget> {
  return { branch: "main", head: await git(root, "rev-parse", "HEAD"), remote: "origin", targetRef: "refs/heads/main" };
}

test("streamed object sizes preserve the exact sum across byte and CRLF boundaries without stdout buffering", async t => {
  const f = await safetyFixture(t, "push-stream-metadata");
  const remote = await addOrigin(f.root, f.directory);
  await commitText(f.root, "first object\n", "first");
  await commitText(f.root, "second object\n", "second");
  const fixed = await target(f.root);
  const objects = await runGit(["rev-list", "--objects", "--no-object-names", fixed.head, "^" + f.head, "--"], f.root);
  const reference = (await runGitWithInput(["cat-file", "--batch-check=%(objectsize)"], f.root, objects))
    .trim().split("\n").reduce((bytes, line) => bytes + Number(line), 0);
  let streamReads = 0;
  const runner: PushGitRunner = {
    run: runGit, input: async () => { throw new Error("Size output must not use a buffered read."); },
    inputStream: async (args, root, input, onData, options) => {
      streamReads++;
      await runGitStreamWithInput(args, root, input, chunk => {
        const data = Buffer.from(chunk.toString().replace(/\n/g, "\r\n"));
        for (let index = 0; index < data.length; index++) onData(data.subarray(index, index + 1));
      }, { ...options, maxBuffer: 1 });
    },
  };
  const result = await pushBranchCommits(f.root, fixed, { sequentialThresholdBytes: 0 }, runner);
  assert.equal(result.estimatedBytes, reference);
  assert.equal(result.completed, 2);
  assert.equal(streamReads, 1);
  assert.equal(await git(remote, "rev-parse", "main"), fixed.head);
});

for (const output of ["-1\n", "1.5\n", "missing\n", "9007199254740992\n", "9007199254740991\n1\n", "9".repeat(80)]) {
  test(`invalid or overflowing metadata stops before any push (${output.slice(0, 16).trim()})`, async t => {
    const f = await safetyFixture(t, "push-invalid-metadata");
    const remote = await addOrigin(f.root, f.directory);
    await commitText(f.root, "one\n", "one"); await commitText(f.root, "two\n", "two");
    let pushes = 0;
    const runner: PushGitRunner = {
      run: async (args, root, options) => { if (args[0] === "push") pushes++; return runGit(args, root, options); },
      input: runGitWithInput,
      inputStream: async (_args, _root, _input, onData) => { onData(Buffer.from(output)); },
    };
    await assert.rejects(pushBranchCommits(f.root, await target(f.root), { sequentialThresholdBytes: 0 }, runner), /Could not estimate/);
    assert.equal(pushes, 0);
    assert.equal(await git(remote, "rev-parse", "main"), f.head);
  });
}
