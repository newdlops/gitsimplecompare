import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runGit, runGitWithInput } from "../src/git/gitExec";
import { readIndexStateFingerprint } from "../src/git/indexStateFingerprint";
import { OperationUndoStore } from "../src/git/operationUndoStore";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** Native index 출력의 기존 텍스트 hash와 분리 배열 기반 충돌 판정을 비교 기준으로 남긴다. */
async function legacy(root: string) {
  const text = await runGit(["-c", "core.fsmonitor=false", "ls-files", "--stage", "-z"], root);
  return { index: createHash("sha256").update(text).digest("hex"), unmerged: text.split("\0").some(entry => /^\d+ [a-f0-9]+ [123]\t/.test(entry)) };
}

for (const linked of [false, true]) test(`Native index fingerprints match legacy stage output (${linked ? "linked" : "main"} worktree)`, async t => {
  const f = await safetyFixture(t, "index-fingerprint"), root = linked ? f.directory + "/linked" : f.root;
  if (linked) await git(f.root, "worktree", "add", "-qb", "linked", root);
  const hash = (await runGitWithInput(["hash-object", "-w", "--stdin"], root, "blob\n")).trim();
  const entries = Buffer.concat([Buffer.from(`100644 ${hash} 0\t한글 😀\n\tpath\0`),
    Buffer.from(`100644 ${hash} 0\tinvalid-`), Buffer.from([0xc3, 0x28, 0xf0, 0x9f]), Buffer.from("\0"),
    ...[1, 2, 3].map(stage => Buffer.from(`100644 ${hash} ${stage}\tconflict\0`))]);
  await runGitWithInput(["update-index", "-z", "--index-info"], root, entries);
  assert.deepEqual(await readIndexStateFingerprint(root), await legacy(root));
  assert.equal((await readIndexStateFingerprint(root)).unmerged, true);
  await runGitWithInput(["update-index", "-z", "--index-info"], root, "0 ".concat("0".repeat(40), "\tconflict\0"));
  assert.deepEqual(await readIndexStateFingerprint(root), await legacy(root));
  assert.equal((await readIndexStateFingerprint(root)).unmerged, false);
});

test("new Undo capture retains the exact stored legacy index digest and detects a later stage change", async t => {
  const { root, head } = await safetyFixture(t, "index-fingerprint-undo"), store = new OperationUndoStore(root, "pull-request");
  const ref = "refs/gitsimplecompare/fingerprint-test";
  await git(root, "update-ref", ref, head); await store.start("main", head, ref);
  const before = await legacy(root); await store.capture("main", ref, "squash");
  const fs = await import("node:fs/promises");
  const record = JSON.parse(await fs.readFile(root + "/.git/gitsimplecompare/pull-request-operation-undo/6d61696e.json", "utf8"));
  assert.equal(record.state.index, before.index); await store.prepare("main");
  const hash = (await runGitWithInput(["hash-object", "-w", "--stdin"], root, "changed\n")).trim();
  await runGitWithInput(["update-index", "-z", "--index-info"], root, `100644 ${hash} 0\ttracked.txt\0`);
  await assert.rejects(() => store.prepare("main"), /no longer matches/);
  assert.equal(await git(root, "rev-parse", ref), head);
});
