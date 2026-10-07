import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BlockBlameHoverPresenter } from "../src/ui/blockBlameHoverPresenter";
import type { BlameCommitInfo } from "../src/git/blameHoverService";
import type { BlameHoverRequest, BlameHoverResponse } from "../src/providers/blameHoverProtocol";
import type { BlockBlameGutterSnapshot } from "../src/ui/blockBlameGutter";
import { EventEmitter, window, __resetWindowMessages, __clipboardWrites, __executedCommands, __externalUris } from "./helpers/vscodeMock";

const HASH = "a".repeat(40), URI = "file:///repo/code.ts";

/** 실제 캐시/요청 검증을 실행하고 느린 Git과 VS Code API의 외부 경계만 대체한다. */
function fixture(t: TestContext) {
  __resetWindowMessages(); window.state.focused = true;
  let snapshot: BlockBlameGutterSnapshot | undefined = { uri: URI, revision: 1, repoRoot: "/repo", columnWidthCh: 23,
    lines: [1, 2].map(line => ({ line, commit: HASH, label: "Author", tooltip: "Original summary" })) };
  const responses: BlameHoverResponse[] = [], reads: Array<{ signal: AbortSignal; complete: () => void; fail: () => void }> = [];
  t.mock.method(EventEmitter.prototype, "fire", value => { responses.push(value as BlameHoverResponse); });
  const info: BlameCommitInfo = { hash: HASH, parents: ["b".repeat(40)], authorName: "Author", authorEmail: "author@example.invalid",
    authorDateIso: "2026-10-07T00:00:00Z", message: "Subject\n\nFull explanation\n\nCo-authored-by: Friend <friend@example.invalid>",
    coAuthors: [{ name: "Friend", email: "friend@example.invalid" }],
    stats: { files: 2, insertions: 8, deletions: 3, binaryFiles: 0 },
    files: [{ status: "R", path: "renamed.ts", oldPath: "old.ts", additions: 7, deletions: 3 }, { status: "A", path: "added.ts", additions: 1, deletions: 0 }] };
  const presenter = new BlockBlameHoverPresenter(() => snapshot, async (_root, _hash, signal) => new Promise((resolve, reject) => {
    signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    reads.push({ signal: signal!, complete: () => resolve(info), fail: () => reject(new Error("Git unavailable")) });
  }), async (_root, hash) => `https://github.com/owner/repo/commit/${hash}`);
  t.after(() => presenter.dispose());
  /** host에 실제 renderer wire 형식의 요청을 전달한다. */
  const send = (changes: Partial<BlameHoverRequest> = {}) => presenter.handleRendererAction({ type: "blameHover", action: "load", uri: URI,
    revision: 1, line: 1, commit: HASH, requestId: 1, ...changes });
  /** Promise 소비자가 Git 대역에 참여하거나 renderer 응답을 발행할 때까지 한 event turn을 처리한다. */
  const tick = () => new Promise(resolve => setImmediate(resolve));
  return { presenter, responses, reads, send, tick, info, setSnapshot: (value?: BlockBlameGutterSnapshot) => { snapshot = value; } };
}

test("details are lazy and adjacent lines share a pending read without restarting Git", async t => {
  const f = fixture(t); assert.equal(f.reads.length, 0);
  f.send(); await f.tick(); assert.equal(f.reads.length, 1);
  f.send({ line: 2, requestId: 2 }); await f.tick();
  assert.equal(f.reads.length, 1); assert.equal(f.reads[0].signal.aborted, false);
  f.reads[0].complete(); await f.tick();
  assert.equal(f.responses.length, 1); assert.equal(f.responses[0].line, 2);
  assert.equal(f.responses[0].details?.message, f.info.message);
  assert.deepEqual(f.responses[0].details?.stats, f.info.stats);
  assert.equal((f.responses[0].details as any).files, undefined, "full file lists stay in the host");
  f.send({ action: "dismiss", line: 2, requestId: 2 });
  f.send({ requestId: 3 }); await f.tick();
  assert.equal(f.reads.length, 1, "reopening the same immutable commit uses the completed cache");
});

test("dismiss and snapshot changes cancel pending consumers and reject late responses", async t => {
  const f = fixture(t); f.send(); await f.tick();
  f.send({ action: "dismiss" }); await f.tick();
  assert.equal(f.reads[0].signal.aborted, true); assert.equal(f.responses.length, 0);
  f.send({ requestId: 2 }); await f.tick();
  f.setSnapshot(undefined); f.reads[1].complete(); await f.tick();
  assert.equal(f.responses.length, 0);
});

test("uncommitted, malformed and stale requests do not read Git or copy an unrelated SHA", async t => {
  const f = fixture(t);
  f.send({ commit: "b".repeat(40) }); f.send({ uri: "file:///other/repo.ts" }); f.send({ revision: 2 });
  f.send({ requestId: 0 }); f.send({ action: "copyHash", line: 5 });
  f.setSnapshot({ uri: URI, revision: 1, repoRoot: "/repo", columnWidthCh: 23,
    lines: [{ line: 1, commit: "0".repeat(40), label: "Working tree", tooltip: "Not committed" }] });
  f.send({ commit: "0".repeat(40) }); await f.tick();
  assert.equal(f.reads.length, 0); assert.equal(__clipboardWrites.length, 0);
});

test("an inline detail error can be retried while identity remains owned by the same snapshot", async t => {
  const f = fixture(t); f.send(); await f.tick(); f.reads[0].fail(); await f.tick();
  assert.equal(f.responses[0].status, "error");
  f.send({ action: "retry" }); await f.tick(); f.reads[1].complete(); await f.tick();
  assert.equal(f.responses.at(-1)?.status, "ready");
});

test("copy, settings, remote and full commit diffs work through extension-owned actions", async t => {
  const f = fixture(t); f.send(); await f.tick();
  f.send({ action: "copyHash" }); await f.tick();
  assert.deepEqual(__clipboardWrites, [HASH]); assert.equal(f.responses.at(-1)?.status, "copied");
  f.send({ action: "settings" }); f.send({ action: "openRemote" }); await f.tick();
  assert.equal(__executedCommands[0].id, "workbench.action.openSettings");
  assert.equal(String(__externalUris[0]), `https://github.com/owner/repo/commit/${HASH}`);
  f.send({ action: "openCommit" }); await f.tick();
  assert.equal(f.reads.length, 1, "commit navigation borrows the pending detail read");
  f.reads[0].complete(); await f.tick();
  const command = __executedCommands.find(value => value.id === "vscode.changes")!;
  assert.ok(command);
  const changes = command.args[1] as any[][];
  assert.equal(changes.length, 2);
  assert.ok(JSON.stringify(changes[0][1]).includes("old.ts"));
  assert.ok(JSON.stringify(changes[0][2]).includes("renamed.ts"));
  assert.equal(changes[1][1], undefined, "new files have no invented original side");
  assert.ok(JSON.stringify(changes[1][2]).includes("added.ts"));
});
