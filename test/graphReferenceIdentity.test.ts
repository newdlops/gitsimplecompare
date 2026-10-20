import assert from "node:assert/strict";
import test from "node:test";
import { graphReferenceIdentity, matchesGraphPageIdentity, matchesGraphReferenceIdentity } from "../src/git/graphReferenceIdentity";
import { parseGitLogSnapshot } from "../src/git/gitLogParse";
import type { Commit } from "../src/graph/graphTypes";

const A = "a".repeat(40), B = "b".repeat(40);
/** 실제 Native fingerprint의 ref 부분을 만들며 worktree 이후 텍스트가 ref로 해석되지 않는지 확인한다. */
function fingerprint(extra = "", symbolic = "refs/heads/main") {
  return `${A}\n${symbolic}\nrefs/heads/main ${A}\nrefs/heads/topic ${B}\nrefs/remotes/origin/main ${B}\n${extra}--worktrees--\nrefs/heads/ignored ${B}`;
}
/** 검증에 필요한 실제 hash/refs만 가진 원본 이력을 만든다. */
function page(): Commit[] {
  return [{ hash: A, refs: ["HEAD", "main"], parents: [B] }, { hash: B, refs: ["topic", "origin/main"], parents: [] }] as Commit[];
}

test("identity uses only complete Native refs and rejects ambiguous or malformed checkouts", () => {
  assert.deepEqual(graphReferenceIdentity(fingerprint())?.branches.map(branch => branch.name), ["main", "topic"]);
  for (const value of [fingerprint("refs/tags/main " + A + "\n"), fingerprint("refs/heads/main " + B + "\n"),
    fingerprint("bad ref\n"), fingerprint("", "HEAD"), fingerprint("", "refs/heads/missing"),
    fingerprint().replace("--worktrees--", "no-marker"), fingerprint("refs/heads/HEAD " + B + "\n")])
    assert.equal(graphReferenceIdentity(value), undefined);
});

test("late details must preserve every identity including same-OID checkout and removal", () => {
  const identity = graphReferenceIdentity(fingerprint())!;
  assert.equal(matchesGraphReferenceIdentity(identity, [...identity.branches].reverse()), true);
  assert.equal(matchesGraphReferenceIdentity(identity, identity.branches.slice(1)), false);
  assert.equal(matchesGraphReferenceIdentity(identity, identity.branches.map(branch => ({ ...branch, current: !branch.current }))), false);
  assert.equal(matchesGraphReferenceIdentity(identity, [identity.branches[0], identity.branches[0]]), false);
});

test("early page requires the same Native symbolic HEAD and every displayed ref identity", () => {
  const identity = graphReferenceIdentity(fingerprint())!;
  assert.equal(matchesGraphPageIdentity(identity, page(), "refs/heads/main"), true);
  assert.equal(matchesGraphPageIdentity(identity, page()), false);
  assert.equal(matchesGraphPageIdentity(identity, page(), "refs/heads/topic"), false);
  const outside = page(); outside[0].refs = ["main"];
  assert.equal(matchesGraphPageIdentity(identity, outside, "refs/heads/main"), false);
  const changed = page(); changed[0].refs.push("new-remote/name");
  assert.equal(matchesGraphPageIdentity(identity, changed, "refs/heads/main"), false);
  assert.equal(matchesGraphPageIdentity(identity, [...page(), page()[0]], "refs/heads/main"), false);
});

test("the same full-decoration log preserves symbolic HEAD while public Commit fields stay unchanged", () => {
  const raw = `${A}\x1f${B}\x1fFixture\x1ffixture@example.invalid\x1f2026-10-20T00:00:00Z\x1fHEAD -> refs/heads/main, refs/remotes/origin/main\x1flatest\0`;
  const result = parseGitLogSnapshot(raw, true);
  assert.equal(result.headRef, "refs/heads/main");
  assert.deepEqual(result.page[0].refs, ["HEAD", "main", "origin/main"]);
  assert.equal(Object.hasOwn(result.page[0], "headRef"), false);
  assert.equal(parseGitLogSnapshot(raw.replace("HEAD -> refs/heads/main", "HEAD"), true).headRef, undefined);
  assert.equal(parseGitLogSnapshot(raw, false).headRef, undefined);
});
