import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { ConflictService } from "../src/git/conflictService";
import { acceptAllConflictBlocks } from "../src/utils/conflictMarkerModel";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 rebase의 열기·설명·새로고침·저장·해결·Continue 비용과 저장 결과를 함께 관찰한다. */
test("conflict interaction phases keep exact results while bounding Git reads", async t => {
  const { root, head } = await safetyFixture(t, "conflict-interaction");
  await commitText(root, "main\n", "main");
  await git(root, "switch", "-qc", "side", head);
  await commitText(root, "side\n", "side");
  await assert.rejects(git(root, "rebase", "main"));
  const original = childProcess.spawn, service = new ConflictService(root);
  const calls: string[][] = [];
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push(args[1]);
    return (original as Function)(...args);
  });
  /** 각 단계의 실제 Git 실행 수와 소요 시간을 기록해 조회 감소와 결과 보존을 함께 확인한다. */
  async function phase<T>(name: string, action: () => Promise<T>, maxCalls?: number): Promise<T> {
    const count = calls.length, start = performance.now();
    const result = await action();
    t.diagnostic(`${name}: ${calls.length - count} Git calls, ${(performance.now() - start).toFixed(1)} ms`);
    if (maxCalls !== undefined) assert.ok(calls.length - count <= maxCalls, `${name} exceeded ${maxCalls} Git calls`);
    return result;
  }
  const initial = await phase("open", () => service.getConflictDocument("tracked.txt", true, { deferMetadata: true }), 4);
  assert.equal(initial.current.content, "main\n"); assert.equal(initial.incoming.content, "side\n");
  const metadata = await phase("metadata", () => service.getConflictDocumentMetadata(initial), 8);
  assert.equal(metadata?.sources.incoming.ref, "REBASE_HEAD");
  const previous = { ...initial, context: metadata!.context, metadataState: "ready" as const,
    current: { ...initial.current, ...metadata!.sources.current }, incoming: { ...initial.incoming, ...metadata!.sources.incoming } };
  const fresh = await phase("refresh", () => service.getConflictDocument("tracked.txt", true, { deferMetadata: true, previous }), 3);
  assert.equal(fresh.context, previous.context);
  await phase("save", () => service.writeResolvedContent("tracked.txt", "manual resolution\n", false, fresh.resultVersion, fresh.sourceVersion), 6);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "manual resolution\n");
  const saved = await service.getConflictDocument("tracked.txt", true, { deferMetadata: true, previous: fresh });
  await phase("accept current", () => service.takeOurs("tracked.txt", saved.resultVersion, saved.sourceVersion), 7);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "main\n");
  assert.deepEqual(await service.listConflicts(), []);
  await phase("continue", () => service.continueOperation("rebase"));
  assert.equal(await service.getOperation(), "none");
  assert.equal(await git(root, "branch", "--show-current"), "side");
});

/** 많은 블록을 한 번에 수용해도 주변 본문·CRLF·양쪽 본문 순서와 마지막 줄을 보존한다. */
test("accepting thousands of conflict blocks preserves every surrounding byte", t => {
  const current = "current value\r\n".repeat(40), incoming = "incoming value\r\n".repeat(40);
  const block = `unchanged\r\n<<<<<<< HEAD\r\n${current}||||||| base\r\nbase\r\n=======\r\n${incoming}>>>>>>> side\r\n`;
  const raw = block.repeat(2_000) + "last line without newline";
  const start = performance.now(), result = acceptAllConflictBlocks(raw);
  t.diagnostic(`Accept Both: ${raw.length} chars, 2000 blocks, ${(performance.now() - start).toFixed(1)} ms`);
  assert.equal(result, (`unchanged\r\n${current}${incoming}`).repeat(2_000) + "last line without newline");
});
