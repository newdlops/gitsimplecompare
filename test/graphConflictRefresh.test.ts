import assert from "node:assert/strict";
import test from "node:test";
import { GitGraphActionService } from "../src/git/gitGraphActionService";
import type { GitLogService } from "../src/git/gitLogService";
import { handleGraphAction } from "../src/webview/graphActions";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";
import { __errorMessages, __informationMessages, __resetWindowMessages, __setWarningMessageResult } from "./helpers/vscodeMock";

test("a real cherry-pick conflict invalidates refs and refreshes its unresolved index exactly once", async t => {
  const f = await safetyFixture(t, "graph-conflict-refresh");
  await git(f.root, "switch", "-qc", "topic");
  const target = await commitText(f.root, "topic version\n", "topic change");
  await git(f.root, "switch", "-q", "main");
  const head = await commitText(f.root, "main version\n", "main change");
  __resetWindowMessages(); __setWarningMessageResult("Cherry-pick");
  t.after(() => __resetWindowMessages());
  let invalidations = 0, attempts = 0, refreshes = 0;
  const actions = new GitGraphActionService(f.root, () => { invalidations++; });
  const service = { repoRoot: f.root, cherryPick: async (hash: string) => { attempts++; await actions.cherryPick(hash); } } as GitLogService;
  await handleGraphAction({ type: "cherryPick", hash: target }, {
    logService: service, pullRequests: () => [], post: () => {}, refreshCheckout: async () => {},
    refreshGraph: async () => {
      refreshes++; assert.equal(invalidations, 1);
      assert.equal(await git(f.root, "diff", "--name-only", "--diff-filter=U"), "tracked.txt");
      assert.equal(await git(f.root, "rev-parse", "CHERRY_PICK_HEAD"), target);
    },
  });
  assert.equal(attempts, 1); assert.equal(refreshes, 1); assert.equal(invalidations, 1);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), head);
  assert.equal(__errorMessages.length, 1); assert.match(__errorMessages[0], /could not apply|conflict/i);
  assert.equal(__informationMessages.length, 0, "a conflict must not display the success notification");
});
