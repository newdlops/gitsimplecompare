import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ConflictService } from "../src/git/conflictService";
import { ConflictContentService } from "../src/git/conflictContentService";
import { assertGitOperation, captureGitOperation } from "../src/git/operationControl";
import { readConflictOperationEpoch } from "../src/git/conflictOperationEpoch";
import { buildConflictOverlayPresentation } from "../src/ui/conflictOverlayPresentation";
import { GitLogService } from "../src/git/gitLogService";
import { GraphPanelMessageRouter, type GraphPanelMessageRouterDeps } from "../src/webview/graphPanelMessageRouter";
import { changesRefreshSections, shouldForceChangesGitStatus, shouldInvalidateChangesStatus } from "../src/utils/extensionRefreshPolicy";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";
import { commands } from "./helpers/vscodeMock";

/** 실제 rebase 충돌을 만들어 fast read와 operation 검증을 동일한 fixture에서 검사한다. */
async function conflicted(t: TestContext, linked = false) {
  const fixture = await safetyFixture(t, "conflict-loading");
  await commitText(fixture.root, "main\n", "main");
  const root = linked ? join(fixture.directory, "linked") : fixture.root;
  if (linked) await git(fixture.root, "worktree", "add", "-qb", "side", root, fixture.head);
  else await git(root, "switch", "-qc", "side", fixture.head);
  await commitText(root, "side\n", "side");
  await assert.rejects(git(root, "rebase", "main"));
  return { ...fixture, root };
}

/** Git은 실제로 실행하고 CLI 명령만 기록해 데이터 안전성과 조회 수를 함께 확인한다. */
function callsFor(t: TestContext): string[][] {
  const calls: string[][] = [], original = childProcess.execFile;
  t.mock.method(childProcess, "execFile", (...args: any[]) => {
    if (args[0] === "git") calls.push(args[1]);
    return (original as Function)(...args);
  });
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push(args[1]);
    return (spawn as Function)(...args);
  });
  return calls;
}

/** replace ref가 바뀌어도 캐시한 원본과 실제 Accept Current가 같은 index blob을 사용해야 한다. */
test("conflict previews and stage acceptance use the same immutable blob despite replacement refs", async t => {
  const { root } = await conflicted(t);
  const service = new ConflictService(root);
  const doc = await service.getConflictDocument("tracked.txt", true, { deferMetadata: true });
  const replacement = join(root, "replacement.txt"); await writeFile(replacement, "replacement bytes\n");
  const oid = await git(root, "hash-object", "-w", replacement);
  await git(root, "replace", doc.current.oid!, oid);
  const current = await service.getConflictDocument("tracked.txt", true, { deferMetadata: true });
  assert.equal(current.current.content, "main\n");
  await service.takeOurs("tracked.txt", current.resultVersion, current.sourceVersion);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), current.current.content);
});

test("conflict content opens in eight Git reads without waiting for commit history or todo analysis", async t => {
  const { root } = await conflicted(t);
  const service = new ConflictService(root), calls = callsFor(t);
  const document = await service.getConflictDocument("tracked.txt", true, { deferMetadata: true });
  assert.equal(calls.length, 8);
  assert.equal(calls.some(args => ["log", "show", "ls-tree"].includes(args[0])), false);
  assert.match(document.result, /<<<<<<< HEAD/);
  assert.equal(document.current.content, "main\n");
  assert.equal(document.incoming.content, "side\n");
  assert.equal(document.metadataState, "pending");
  assert.equal(document.sourceVersion, await new ConflictContentService(root).readSourceVersion("tracked.txt"));
  const presentation = buildConflictOverlayPresentation(document);
  assert.match(presentation.impact.title, /Loading/);
  assert.equal(presentation.impact.tone, "info");
  assert.match(presentation.cards[1].title, /Index stage 3/);
  const metadata = await service.getConflictDocumentMetadata(document);
  assert.equal(metadata?.sources.incoming.ref, "REBASE_HEAD");
  assert.equal(metadata?.context.rebase?.fileOutcome, "expected-final");
});

test("unchanged conflict refresh reuses metadata but still reads fresh content and invalidates it after a new operation", async t => {
  const { root } = await conflicted(t);
  const service = new ConflictService(root);
  const previous = await service.getConflictDocument("tracked.txt", true);
  const calls = callsFor(t);
  await writeFile(join(root, "tracked.txt"), "new on-disk resolution\n");
  const refreshed = await service.getConflictDocument("tracked.txt", true, { deferMetadata: true, previous });
  assert.equal(calls.length, 5);
  assert.equal(calls.some(args => args[0] === "cat-file"), false);
  assert.equal(refreshed.context, previous.context);
  assert.equal(refreshed.metadataState, "ready");
  assert.equal(refreshed.result, "new on-disk resolution\n");
  assert.notEqual(refreshed.resultVersion, previous.resultVersion);
  await writeFile(join(root, ".gitattributes"), "tracked.txt -diff\n");
  const binary = await service.getConflictDocument("tracked.txt", true, { deferMetadata: true, previous: refreshed });
  assert.equal(binary.current.kind, "binary");
  assert.equal(binary.incoming.kind, "binary");
  await writeFile(join(root, ".gitattributes"), "");
  await git(root, "rebase", "--abort");
  await assert.rejects(git(root, "rebase", "main"));
  const replacement = await service.getConflictDocument("tracked.txt", true, { deferMetadata: true, previous });
  assert.equal(replacement.metadataState, "pending");
  assert.notEqual(replacement.sourceVersion, previous.sourceVersion);
  assert.equal(await service.getConflictDocumentMetadata(previous), undefined);
  await assert.rejects(service.markResolved("tracked.txt", previous.resultVersion, previous.sourceVersion), /changed/);
});

for (const linked of [false, true]) {
  test(`operation capture uses three fresh reads and rejects todo changes (${linked ? "linked" : "main"} worktree)`, async t => {
    const { root } = await conflicted(t, linked);
    const calls = callsFor(t);
    const before = await captureGitOperation(root);
    assert.equal(calls.length, 3);
    assert.equal(before.operation, "rebase");
    assert.equal(before.epoch, await readConflictOperationEpoch(root));
    await appendFile(join(before.gitDir, "rebase-merge", "git-rebase-todo"), "\n# external todo edit\n");
    const after = await captureGitOperation(root);
    assert.equal(after.generation, before.generation);
    assert.notEqual(after.epoch, before.epoch);
    await assert.rejects(assertGitOperation(root, before), /operation changed/);
  });
}

test("rebase routes one immediate scoped Changes refresh and a graph-only reload", async t => {
  const { root } = await safetyFixture(t, "rebase-refresh-owner");
  const observed: Array<{ id: string; args: any[] }> = [], graph: string[] = [];
  t.mock.method(commands, "executeCommand", async (id: string, ...args: any[]) => { observed.push({ id, args }); });
  const router = new GraphPanelMessageRouter({ logService: () => new GitLogService(root), post: () => {},
    reloadGraph: async cause => { graph.push(cause); return true; },
    refreshAfterGraphAction: async () => { assert.fail("rebase must not duplicate the generic Changes refresh"); },
  } as unknown as GraphPanelMessageRouterDeps);
  await router.handle({ type: "skipGraphRebase" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(graph, ["graphRebase"]);
  const changes = observed.filter(command => command.id === "gitSimpleCompare.refreshChanges");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].args[0].reason, "graphRebaseSkipNoop");
  for (const reason of ["graphRebaseConflict", "graphRebaseEditPaused", "graphRebaseStopped", "graphRebaseSkipNoop"]) {
    assert.deepEqual(changesRefreshSections(reason), ["repositories", "workingChanges", "fileHistory", "comparison"]);
    assert.equal(shouldForceChangesGitStatus(reason), true);
    assert.equal(shouldInvalidateChangesStatus(reason), true);
  }
  for (const reason of ["graphRebaseCompleted", "graphRebaseRecoveryFailed"]) {
    assert.deepEqual(changesRefreshSections(reason), ["repositories", "workingChanges", "fileHistory", "stashes", "comparison"]);
  }
});
