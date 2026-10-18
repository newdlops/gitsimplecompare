import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { ConflictService, type ConflictDocument } from "../src/git/conflictService";
import { isConflictMutationActive, runConflictMutation } from "../src/git/conflictMutationCoordinator";
import { readConflictWorkingLeaf } from "../src/git/conflictWorktreeCas";
import { ConflictEditorOverlayController, type TrustedConflictEditorSession } from "../src/providers/conflictEditorOverlayController";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 조회 문서를 native controller의 동일 URI/version session으로 설치한다. */
function installSession(overlay: ConflictEditorOverlayController, service: ConflictService, document: ConflictDocument): TrustedConflictEditorSession {
  const uri = { scheme: "gitsimplecompare-conflict", toString: () => `conflict:save:${document.rel}` } as any;
  const session = { id: `save:${document.rel}`, uri, service, rel: document.rel, document, content: document.result,
    virtual: false, readOnly: false, revision: 1, refreshGeneration: 0, busy: false, resolved: false,
    suspended: false, baselineStale: false, allowBusySave: false, ctime: Date.now(), mtime: Date.now(),
    onDidMutate: async () => {} } as TrustedConflictEditorSession;
  (overlay as any).sessions.set(uri.toString(), session); return session;
}

/** 실제 CAS provider Save에서 Git 실행 수, 전체 본문 재조회와 최신 기준선 보존을 함께 측정한다. */
test("native conflict Save avoids duplicate Result reads while preserving exact CAS baselines", async t => {
  const { root, head } = await safetyFixture(t, "conflict-native-save");
  const suffix = "unchanged content\n".repeat(250_000);
  await commitText(root, "main\n" + suffix, "main"); await git(root, "switch", "-qc", "side", head);
  await commitText(root, "side\n" + suffix, "side"); await assert.rejects(git(root, "rebase", "main"));
  const service = new ConflictService(root), document = await service.getConflictDocument("tracked.txt", true);
  const overlay = new ConflictEditorOverlayController({} as any); t.after(() => overlay.dispose());
  const session = installSession(overlay, service, document);
  const original = childProcess.spawn; let calls = 0, resultReads = 0, documentReads = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => { if (args[0] === "git") calls++; return (original as Function)(...args); });
  const getResult = service.getWorkingResult.bind(service), getDocument = service.getConflictDocument.bind(service);
  t.mock.method(service, "getWorkingResult", (...args) => { resultReads++; return getResult(...args); });
  t.mock.method(service, "getConflictDocument", (...args) => { documentReads++; return getDocument(...args); });
  const refresh = overlay.refreshSession.bind(overlay); let lockedDuringContext = false;
  t.mock.method(overlay, "refreshSession", (...args) => { lockedDuringContext = isConflictMutationActive(root); return refresh(...args); });
  const saved = "manual resolution\n" + suffix, start = performance.now();
  await overlay.writeResource(session, saved);
  t.diagnostic(`Save ${Buffer.byteLength(saved)} bytes: ${calls} Git calls, ${resultReads + documentReads} post-save full reads, lease during context=${lockedDuringContext}, ${(performance.now() - start).toFixed(1)} ms`);
  assert.equal(calls, 9); assert.equal(resultReads + documentReads, 1); assert.equal(lockedDuringContext, false);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), saved);
  assert.equal(session.document.result, saved); assert.equal(session.document.metadataState, "ready");
  assert.equal(session.document.resultVersion, (await readConflictWorkingLeaf(join(root, "tracked.txt"))).version);
  assert.equal(isConflictMutationActive(root), false); assert.equal(session.busy, false);
  await writeFile(join(root, "tracked.txt"), "external editor changed the file\n");
  await assert.rejects(overlay.writeResource(session, "stale overwrite"));
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "external editor changed the file\n");
  assert.equal(isConflictMutationActive(root), false);
});

/** 첫 파일 Save의 표시 조회가 느려도 다른 파일의 실제 exact-stage 해결은 안전하게 끝나야 한다. */
test("another conflict file can resolve while a saved file refreshes its native baseline", async t => {
  const { root } = await safetyFixture(t, "conflict-save-other-file");
  await writeFile(join(root, "other.txt"), "base\n"); await git(root, "add", "other.txt"); await git(root, "commit", "-qm", "two files");
  const base = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "other.txt"), "main\n"); await git(root, "add", "other.txt"); await commitText(root, "main\n", "main");
  await git(root, "switch", "-qc", "side", base);
  await writeFile(join(root, "other.txt"), "side\n"); await git(root, "add", "other.txt"); await commitText(root, "side\n", "side");
  await assert.rejects(git(root, "rebase", "main"));
  const service = new ConflictService(root), document = await service.getConflictDocument("tracked.txt", true);
  const other = await service.getConflictDocument("other.txt", true, { deferMetadata: true });
  const overlay = new ConflictEditorOverlayController({} as any); t.after(() => overlay.dispose());
  const session = installSession(overlay, service, document), original = overlay.refreshSession.bind(overlay);
  let begin!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; }), showing = new Promise<void>(resolve => { finish = resolve; });
  t.mock.method(overlay, "refreshSession", async (...args) => { begin(); await showing; return original(...args); });
  const save = overlay.writeResource(session, "manual first resolution\n"); await started;
  try {
    assert.equal(isConflictMutationActive(root), false); assert.equal(session.busy, true);
    await runConflictMutation(root, () => service.takeOurs("other.txt", other.resultVersion, other.sourceVersion));
    assert.equal(await readFile(join(root, "other.txt"), "utf8"), "main\n");
  } finally { finish(); }
  await save;
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "manual first resolution\n");
  assert.equal(session.document.resultVersion, (await readConflictWorkingLeaf(join(root, "tracked.txt"))).version);
  assert.deepEqual(await service.listConflicts(), ["tracked.txt"]); assert.equal(isConflictMutationActive(root), false);
});
