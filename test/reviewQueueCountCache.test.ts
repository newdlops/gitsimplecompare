// Reviews count cache의 보안 경계, TTL, repository/account 격리를 순수 저장소로 검증한다.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ReviewQueueCountCache,
  reviewQueueCountCacheTiming,
  type ReviewQueueCountStateStore,
} from "../src/webview/reviewQueueCountCache";

/** workspaceState의 get/update만 재현하는 in-memory store. */
class MemoryStore implements ReviewQueueCountStateStore {
  public readonly values = new Map<string, unknown>();

  /** key에 저장된 값을 반환한다. */
  public get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  /** undefined면 삭제하고 나머지는 JSON-like value로 저장한다. */
  public async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
}

const identity = { repository: "fixture-org/review-demo", account: "fixture-reviewer" };

/** cache payload가 user-visible PR metadata나 credential string을 갖지 않는지 JSON으로 검사한다. */
function storedJson(store: MemoryStore): string {
  return JSON.stringify([...store.values.values()]);
}

test("repository와 account fingerprint가 다른 count cache를 서로 노출하지 않는다", async () => {
  const store = new MemoryStore();
  const cache = new ReviewQueueCountCache(store, () => 1_000);
  await cache.write(identity, { personal: 3, management: 5 });

  assert.equal((await cache.read(identity)).kind, "fresh");
  assert.equal((await cache.read({ repository: identity.repository, account: "different-user" })).kind, "missing");
  assert.equal((await cache.read({ repository: "other-org/review-demo", account: identity.account })).kind, "missing");
  assert.equal(store.values.size, 1);
});

test("5분과 24시간 경계에서 fresh, stale, 삭제를 정확히 적용한다", async () => {
  const store = new MemoryStore();
  let now = 1_000;
  const cache = new ReviewQueueCountCache(store, () => now);
  await cache.write(identity, { personal: 0, management: 1 });

  now += reviewQueueCountCacheTiming.freshMaxAgeMs;
  assert.equal((await cache.read(identity)).kind, "fresh");
  now += 1;
  assert.equal((await cache.read(identity)).kind, "stale");
  now = 1_000 + reviewQueueCountCacheTiming.staleMaxAgeMs + 1;
  assert.deepEqual(await cache.read(identity), { kind: "missing" });
  assert.equal(store.values.size, 0);
});

test("성공한 zero count도 저장하지만 손상·오래된 schema는 표시 전에 삭제한다", async () => {
  const store = new MemoryStore();
  const cache = new ReviewQueueCountCache(store, () => 2_000);
  const entry = await cache.write(identity, { personal: 0, management: 0 });
  assert.deepEqual((await cache.read(identity)).entry?.counts, { personal: 0, management: 0 });

  const key = [...store.values.keys()][0];
  store.values.set(key, { ...entry, schemaVersion: 99 });
  assert.deepEqual(await cache.read(identity), { kind: "missing" });
  assert.equal(store.values.size, 0);
});

test("auth invalidation은 현재 account의 count만 삭제하고 다른 account cache는 보존한다", async () => {
  const store = new MemoryStore();
  const cache = new ReviewQueueCountCache(store, () => 3_000);
  const other = { repository: identity.repository, account: "other-reviewer" };
  await cache.write(identity, { personal: 2, management: 4 });
  await cache.write(other, { personal: 7, management: 9 });

  await cache.invalidate(identity);
  assert.equal((await cache.read(identity)).kind, "missing");
  assert.deepEqual((await cache.read(other)).entry?.counts, { personal: 7, management: 9 });
});

test("serialised count cache에는 token, PR metadata, repository 원문, account 원문이 없다", async () => {
  const store = new MemoryStore();
  const cache = new ReviewQueueCountCache(store, () => 4_000);
  await cache.write(identity, { personal: 11, management: 13 });
  const serialized = storedJson(store);

  for (const forbidden of ["fixture-org/review-demo", "fixture-reviewer", "ghp_example_token", "Pull request title", "https://github.com/"]) {
    assert.equal(serialized.includes(forbidden), false, `cache leaked ${forbidden}`);
  }
  assert.match(serialized, /"personal":11/);
  assert.match(serialized, /"management":13/);
});
