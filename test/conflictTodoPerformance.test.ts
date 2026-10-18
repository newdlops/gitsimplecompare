import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { ConflictService } from "../src/git/conflictService";
import { runGitWithInput } from "../src/git/gitExec";
import { readGitCheckoutIdentity } from "../src/git/repositoryIdentity";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 여러 천 개의 실제 commit을 한 fast-import로 만들고 첫 replay에서 native rebase를 멈춘다. */
test("large conflict todo analysis checks all five thousand later commits without truncating evidence", async t => {
  const { root, head } = await safetyFixture(t, "conflict-large-todo");
  await commitText(root, "main\n", "main");
  const total = 5_001, input: string[] = [];
  for (let index = 1; index <= total; index++) {
    const message = `side ${index}\n`, content = `side ${index}\n`;
    input.push(`commit refs/heads/side\nmark :${index}\ncommitter Conflict Test <conflict@example.com> ${1_700_000_000 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}from ${index === 1 ? head : `:${index - 1}`}\nM 100644 inline tracked.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`);
  }
  input.push("done\n");
  await runGitWithInput(["fast-import", "--quiet"], root, input.join(""));
  await git(root, "switch", "-q", "side"); await assert.rejects(git(root, "rebase", "main"));
  const service = new ConflictService(root);
  const document = await service.getConflictDocument("tracked.txt", true, { deferMetadata: true });
  const original = childProcess.spawn; let calls = 0, logCalls = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") { calls++; if (args[1].includes("--no-walk=unsorted")) logCalls++; }
    return (original as Function)(...args);
  });
  const start = performance.now(), metadata = await service.getConflictDocumentMetadata(document);
  t.diagnostic(`5000 later commits: ${calls} Git calls, ${logCalls} path queries, ${(performance.now() - start).toFixed(1)} ms`);
  assert.equal(logCalls, 1); assert.ok(calls <= 10, `Expected at most ten Git calls, got ${calls}`);
  const rebase = metadata?.context.rebase; assert.ok(rebase);
  assert.equal(rebase.remainingSteps, 5_000); assert.equal(rebase.futurePathAnalysisComplete, true);
  assert.equal(rebase.futurePathChangeCount, 5_000); assert.equal(rebase.futurePathChanges.length, 6);
  assert.equal(rebase.futurePathChangesOmitted, 4_994); assert.equal(rebase.fileOutcome, "changed-later");
  assert.deepEqual(rebase.futurePathChanges.map(change => change.index), [2, 3, 4, 5, 6, 7]);
  assert.equal(rebase.futurePathChanges[0].subject, "side 2");
  const { gitDir } = await readGitCheckoutIdentity(root);
  const todoPath = join(gitDir, "rebase-merge", "git-rebase-todo"), later = rebase.futurePathChanges;
  await writeFile(todoPath, `pick ${later[0].commit}\npick ${later[1].commit!.slice(0, 12)}\nfixup -C ${later[0].commit!.slice(0, 16)}\npick ${later[2].commit}\n`);
  const mixedDocument = await service.getConflictDocument("tracked.txt", true, { deferMetadata: true });
  const mixed = (await service.getConflictDocumentMetadata(mixedDocument))?.context.rebase;
  assert.equal(mixed?.remainingSteps, 4); assert.equal(mixed?.futurePathChangeCount, 4);
  assert.deepEqual(mixed?.futurePathChanges.map(change => change.commit), [later[0].commit, later[1].commit, later[0].commit, later[2].commit]);
  assert.deepEqual(mixed?.futurePathChanges.map(change => change.index), [2, 3, 4, 5]);
  await appendFile(todoPath, `pick ${"0".repeat(40)} missing commit\n`);
  const changed = await service.getConflictDocument("tracked.txt", true, { deferMetadata: true });
  const uncertain = (await service.getConflictDocumentMetadata(changed))?.context.rebase;
  assert.equal(uncertain?.futurePathAnalysisComplete, false); assert.equal(uncertain?.fileOutcome, "uncertain");
});

/** stdin 조회에서도 다른 파일만 바꾸는 commit은 현재 파일의 향후 영향에 포함하지 않는다. */
test("todo path filtering distinguishes later changes from commits touching only another file", async t => {
  const { root, head } = await safetyFixture(t, "conflict-todo-paths");
  await commitText(root, "main\n", "main"); await git(root, "switch", "-qc", "side", head);
  await commitText(root, "side\n", "side first");
  await writeFile(join(root, "other.txt"), "other one\n"); await git(root, "add", "--", "other.txt");
  await git(root, "commit", "-qm", "other first"); const otherFirst = await git(root, "rev-parse", "HEAD");
  const subject = "tracked later · 한글🙂 \x1eembedded \x1fseparator";
  const later = await commitText(root, "side later\n", subject);
  await writeFile(join(root, "other.txt"), "other two\n"); await git(root, "add", "--", "other.txt");
  await git(root, "commit", "-qm", "other second"); const otherSecond = await git(root, "rev-parse", "HEAD");
  await assert.rejects(git(root, "rebase", "main"));
  const original = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const child = (original as Function)(...args);
    if (args[0] === "git" && args[1].includes("--no-walk=unsorted")) {
      const emit = child.stdout.emit;
      child.stdout.emit = function (event: string, ...values: any[]) {
        if (event !== "data" || !Buffer.isBuffer(values[0])) return emit.call(this, event, ...values);
        for (const byte of values[0]) emit.call(this, event, Buffer.from([byte]));
        return true;
      };
    }
    return child;
  });
  const service = new ConflictService(root), document = await service.getConflictDocument("tracked.txt", true, { deferMetadata: true });
  const changed = (await service.getConflictDocumentMetadata(document))?.context.rebase;
  assert.equal(changed?.remainingSteps, 3); assert.equal(changed?.futurePathChangeCount, 1);
  assert.equal(changed?.futurePathChanges[0].commit, later); assert.equal(changed?.futurePathChanges[0].index, 3);
  assert.equal(changed?.futurePathChanges[0].subject, subject);
  assert.equal(changed?.fileOutcome, "changed-later");
  const { gitDir } = await readGitCheckoutIdentity(root);
  await writeFile(join(gitDir, "rebase-merge", "git-rebase-todo"), `pick ${otherFirst}\npick ${otherSecond}\n`);
  const latest = await service.getConflictDocument("tracked.txt", true, { deferMetadata: true });
  const unchanged = (await service.getConflictDocumentMetadata(latest))?.context.rebase;
  assert.equal(unchanged?.remainingSteps, 2); assert.equal(unchanged?.futurePathAnalysisComplete, true);
  assert.equal(unchanged?.futurePathChangeCount, 0); assert.equal(unchanged?.fileOutcome, "expected-final");
});
