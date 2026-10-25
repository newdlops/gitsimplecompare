import assert from "node:assert/strict";
import test from "node:test";
import { snapshotDigest } from "./helpers/snapshotDigest";

test("snapshot signatures ignore object insertion order at every depth", () => {
  const native = { branches: [{ name: "a", ahead: 2, behind: 1, current: false }], invalidRefs: [] };
  const batched = { invalidRefs: [], branches: [{ current: false, behind: 1, ahead: 2, name: "a" }] };
  assert.equal(snapshotDigest(native), snapshotDigest(batched));
});

test("branch ordering and tracking values remain significant", () => {
  const branches = [{ name: "a", ahead: 2, behind: 1 }, { name: "b", ahead: 0, behind: 0 }];
  assert.notEqual(snapshotDigest({ branches }), snapshotDigest({ branches: [...branches].reverse() }));
  assert.notEqual(snapshotDigest({ branches }), snapshotDigest({ branches: [{ ...branches[0], ahead: 1, behind: 2 }, branches[1]] }));
});

test("snapshot signatures preserve scalar types and missing fields", () => {
  assert.notEqual(snapshotDigest({ ahead: 0 }), snapshotDigest({ ahead: "0" }));
  assert.notEqual(snapshotDigest({ gone: false }), snapshotDigest({}));
});

test("signature creation does not mutate a frozen source snapshot", () => {
  const branch = Object.freeze({ current: false, name: "a", ahead: 0 });
  const branches = Object.freeze([branch]);
  const snapshot = Object.freeze({ invalidRefs: Object.freeze([]), branches });
  snapshotDigest(snapshot);
  assert.equal(snapshot.branches, branches);
  assert.deepEqual(Object.keys(branch), ["current", "name", "ahead"]);
});
