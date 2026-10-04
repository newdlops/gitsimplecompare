import assert from "node:assert/strict";
import test from "node:test";
import { gitCommandPolicy } from "../src/git/gitCommandPolicy";

test("reference queries are cancellable reads while reflog mutations remain protected", () => {
  for (const args of [["show-ref", "--verify", "refs/stash"], ["reflog"], ["reflog", "show"],
    ["reflog", "list"], ["reflog", "exists", "refs/stash"], ["ls-remote", "--tags", "origin"],
    ["check-ref-format", "refs/heads/main"]]) {
    assert.equal(gitCommandPolicy(args).readOnly, true, args.join(" "));
  }
  for (const args of [["reflog", "delete", "HEAD@{1}"], ["reflog", "expire", "--all"],
    ["reflog", "write", "HEAD", "old", "new", "message"], ["reflog", "drop", "HEAD"], ["reflog", "unknown"]]) {
    assert.equal(gitCommandPolicy(args).readOnly, false, args.join(" "));
  }
});
