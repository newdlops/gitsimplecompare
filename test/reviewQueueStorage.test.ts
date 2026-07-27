import assert from "node:assert/strict";
import test from "node:test";
import { ReviewQueueStorage, type ReviewQueueStateStorage } from "../src/webview/reviewQueueStorage";

class MemoryState implements ReviewQueueStateStorage {
  public readonly values = new Map<string, unknown>();
  public get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  public async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

test("saved queue는 repository/viewer별 query definition과 사용자가 정한 순서를 저장한다", async () => {
  const state = new MemoryState();
  const storage = new ReviewQueueStorage(state);
  const later = await storage.create("acme/demo", "alice", "Blocked", "is:open  label:blocked");
  await storage.create("acme/demo", "alice", "Needs review", "review-requested:@me");

  assert.deepEqual(storage.load("acme/demo", "alice").map((queue) => [queue.name, queue.query]), [
    ["Blocked", "is:open label:blocked"], ["Needs review", "review-requested:@me"],
  ]);
  assert.equal(storage.load("acme/demo", "bob").length, 0);
  assert.equal(await storage.remove("acme/demo", "alice", later.id), true);
  assert.equal(await storage.remove("acme/demo", "alice", later.id), false);
});

test("saved queue는 선택 id만 수정하고 경계 밖 이동은 write 없이 무시한다", async () => {
  const state = new MemoryState();
  const storage = new ReviewQueueStorage(state);
  const first = await storage.create("acme/demo", "alice", "First", "label:first");
  const second = await storage.create("acme/demo", "alice", "Second", "label:second");

  const updated = await storage.update("acme/demo", "alice", second.id, "Second queue", "label:second is:open");
  assert.equal(updated?.name, "Second queue");
  assert.equal(await storage.move("acme/demo", "alice", second.id, "up"), true);
  assert.deepEqual(storage.load("acme/demo", "alice").map((queue) => queue.name), ["Second queue", "First"]);
  assert.equal(await storage.move("acme/demo", "alice", second.id, "up"), false);
  await assert.rejects(() => storage.update("acme/demo", "alice", first.id, " second queue ", "label:first"));
  assert.equal(await storage.update("acme/demo", "alice", "missing", "Missing", "is:open"), undefined);
});

test("saved queue는 빈 query·중복 이름·손상된 storage record를 안전하게 거부한다", async () => {
  const state = new MemoryState();
  const storage = new ReviewQueueStorage(state);
  await storage.create("acme/demo", "alice", "Watch", "mentions:@me");

  await assert.rejects(() => storage.create("acme/demo", "alice", " watch ", "assignee:@me"));
  await assert.rejects(() => storage.create("acme/demo", "alice", "Empty", "   "));
  state.values.set("gitSimpleCompare.reviewQueues.v1:acme/demo:bob", [{ version: 99, name: "future", query: "is:open" }]);
  assert.deepEqual(storage.load("acme/demo", "bob"), []);
});
