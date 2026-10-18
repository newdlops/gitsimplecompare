import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { ConflictService } from "../src/git/conflictService";
import { readConflictWorkingLeaf } from "../src/git/conflictWorktreeCas";
import { ConflictEditorOverlayController, type TrustedConflictEditorSession } from "../src/providers/conflictEditorOverlayController";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";
import { window } from "./helpers/vscodeMock";

/** 실제 미해결 탭의 자동 갱신에서 공통 Git 조회 수와 최신 Result/CAS 게시를 함께 측정한다. */
test("refreshing twenty-four unresolved tabs batches fresh index, attributes and operation reads", { timeout: 45_000 }, async t => {
  const { root } = await safetyFixture(t, "conflict-open-tabs");
  const paths = Array.from({ length: 24 }, (_, index) => index === 1 ? "한글 [literal].txt" : `conflict-${index}.txt`);
  for (const rel of paths) await writeFile(join(root, rel), "base\n");
  await git(root, "add", "--", ...paths); await git(root, "commit", "-qm", "base files");
  const base = await git(root, "rev-parse", "HEAD");
  for (const rel of paths) await writeFile(join(root, rel), "main\n");
  await git(root, "add", "--", ...paths); await git(root, "commit", "-qm", "main files");
  await git(root, "switch", "-qc", "side", base);
  for (const rel of paths) await writeFile(join(root, rel), "side\n");
  await git(root, "add", "--", ...paths); await git(root, "commit", "-qm", "side files");
  await assert.rejects(git(root, "rebase", "main"));
  const service = new ConflictService(root);
  const overlay = new ConflictEditorOverlayController({} as any);
  t.after(() => overlay.dispose());
  const sessions: TrustedConflictEditorSession[] = [];
  for (const [index, rel] of paths.entries()) {
    const document = await service.getConflictDocument(rel, true, { deferMetadata: true });
    document.metadataState = "ready";
    const uri = { scheme: "gitsimplecompare-conflict", toString: () => `conflict:open-${index}` } as any;
    const session = { id: `open-${index}`, uri, service, rel, document, content: document.result,
      virtual: false, readOnly: false, revision: 1, refreshGeneration: 0, busy: false, resolved: false,
      suspended: false, baselineStale: false, allowBusySave: false, ctime: Date.now(), mtime: Date.now(),
      onDidMutate: async () => {} } as TrustedConflictEditorSession;
    (overlay as any).sessions.set(uri.toString(), session); sessions.push(session);
    await writeFile(join(root, rel), document.result + `manual edit ${index}\n`);
  }
  const visible = window.visibleTextEditors;
  window.visibleTextEditors = [{ document: { uri: sessions[0].uri } }];
  t.after(() => { window.visibleTextEditors = visible; });
  const spawn = childProcess.spawn;
  let calls = 0, active = 0, peak = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const child = (spawn as Function)(...args);
    if (args[0] === "git") { calls++; active++; peak = Math.max(peak, active); child.once("close", () => { active--; }); }
    return child;
  });
  let finish!: () => void, fail!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const commit = (overlay as any).commitDocument.bind(overlay);
  let published = 0;
  t.mock.method(overlay as any, "commitDocument", (...args: any[]) => { commit(...args); if (++published === paths.length) finish(); });
  const started = performance.now();
  (overlay as any).onConflictsRefreshed({ repoRoot: root, conflicts: paths });
  const timeout = setTimeout(() => fail(new Error(`Only ${published} tabs refreshed`)), 20_000);
  try { await done; } finally { clearTimeout(timeout); }
  t.diagnostic(JSON.stringify({ files: paths.length, calls, peak, elapsedMs: +(performance.now() - started).toFixed(1) }));
  assert.ok(calls <= 12, `Expected at most twelve Git reads, got ${calls}`);
  assert.ok(peak <= 6);
  for (const [index, session] of sessions.entries()) {
    assert.equal(session.resolved, false);
    assert.ok(session.document.result.endsWith(`manual edit ${index}\n`));
    assert.equal(session.document.resultVersion, (await readConflictWorkingLeaf(join(root, session.rel))).version);
    assert.equal(session.document.metadataState, "ready");
  }
  assert.deepEqual(await service.listConflicts(), [...paths].sort());
});
