import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { ConflictService } from "../src/git/conflictService";
import { readConflictWorkingLeaf } from "../src/git/conflictWorktreeCas";
import { ConflictEditorOverlayController, type TrustedConflictEditorSession } from "../src/providers/conflictEditorOverlayController";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";
import { window } from "./helpers/vscodeMock";

/** 여러 native conflict 문서가 열린 실제 저장소에서 외부 일괄 해결 뒤의 갱신을 측정한다. */
test("external resolution refresh bounds Git reads for twenty-four open conflict tabs", async t => {
  const { root, head } = await safetyFixture(t, "conflict-resolved-tabs");
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
  assert.notEqual(base, head);
  const service = new ConflictService(root), template = await service.getConflictDocument(paths[0], true, { deferMetadata: true });
  const overlay = new ConflictEditorOverlayController({} as any);
  t.after(() => overlay.dispose());
  const sessions: TrustedConflictEditorSession[] = [];
  for (const [index, rel] of paths.entries()) {
    const leaf = await readConflictWorkingLeaf(join(root, rel));
    const uri = { scheme: "gitsimplecompare-conflict", toString: () => `conflict:session-${index}` } as any;
    const session = { id: `session-${index}`, uri, service, rel, document: { ...template, rel, resultVersion: leaf.version },
      content: template.result, virtual: false, readOnly: false, revision: 1, refreshGeneration: 0,
      busy: false, resolved: false, suspended: false, baselineStale: false, allowBusySave: false,
      ctime: Date.now(), mtime: Date.now(), onDidMutate: async () => {} } as TrustedConflictEditorSession;
    (overlay as any).sessions.set(uri.toString(), session); sessions.push(session);
    await writeFile(join(root, rel), `resolution ${index}\n`);
  }
  await git(root, "add", "--", ...paths);
  const originalVisible = window.visibleTextEditors;
  window.visibleTextEditors = [{ document: { uri: sessions[0].uri } }];
  t.after(() => { window.visibleTextEditors = originalVisible; });
  const original = childProcess.spawn; let calls = 0, active = 0, peak = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const child = (original as Function)(...args);
    if (args[0] === "git") { calls++; active++; peak = Math.max(peak, active); child.once("close", () => { active--; }); }
    return child;
  });
  let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
  const mark = overlay.markResolved.bind(overlay); let resolved = 0;
  t.mock.method(overlay, "markResolved", (session, reason) => { mark(session, reason); if (++resolved === paths.length) finish(); });
  const start = performance.now();
  (overlay as any).onConflictsRefreshed({ repoRoot: root, conflicts: [] });
  const timeout = setTimeout(() => { finish(); }, 20_000);
  try { await done; } finally { clearTimeout(timeout); }
  t.diagnostic(`Resolved tabs: ${paths.length}, ${calls} Git calls, peak ${peak}, ${(performance.now() - start).toFixed(1)} ms`);
  assert.ok(calls <= 6, `Expected at most six Git reads, got ${calls}`);
  assert.ok(peak <= 2, `Expected at most two Git processes, got ${peak}`);
  assert.equal(resolved, paths.length);
  for (const [index, session] of sessions.entries()) {
    assert.equal(session.resolved, true); assert.equal(session.document.result, `resolution ${index}\n`);
    assert.equal(session.document.resultVersion, (await readConflictWorkingLeaf(join(root, session.rel))).version);
    assert.equal(await readFile(join(root, session.rel), "utf8"), session.document.result);
  }
});
