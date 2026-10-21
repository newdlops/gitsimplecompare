import assert from "node:assert/strict";
import test from "node:test";
import type { Commit } from "../src/graph/graphTypes";
import { expectedRenderedRefs, readNativeRemoteTagExpectation } from "./helpers/graphNativeExpectation";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

test("Native remote-tag oracle peels annotated tags and observes remote moves/deletions independently of local tags", async t => {
  const f = await safetyFixture(t, "native-tag-oracle"), remote = await addOrigin(f.root, f.directory);
  await git(f.root, "tag", "light");
  await git(f.root, "tag", "-a", "annotated", "-m", "annotated");
  await git(f.root, "push", "origin", "--tags");
  assert.deepEqual(await readNativeRemoteTagExpectation(f.root), [
    { remote: "origin", name: "annotated", hash: f.head }, { remote: "origin", name: "light", hash: f.head },
  ]);
  const next = await commitText(f.root, "next\n", "next");
  await git(f.root, "push", "origin", "main");
  await git(remote, "update-ref", "refs/tags/light", next);
  await git(remote, "update-ref", "-d", "refs/tags/annotated");
  assert.equal(await git(f.root, "rev-parse", "refs/tags/light"), f.head);
  assert.deepEqual(await readNativeRemoteTagExpectation(f.root), [{ remote: "origin", name: "light", hash: next }]);
  const commits = [{ hash: f.head, refs: ["HEAD", "main", "tag:light"] }, { hash: next, refs: [] }] as unknown as Commit[];
  assert.deepEqual(expectedRenderedRefs(commits, await readNativeRemoteTagExpectation(f.root)), new Map([
    [f.head, ["HEAD", "main", "tag:light"]], [next, ["remote-tag:origin/light"]],
  ]));
});
