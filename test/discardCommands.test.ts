import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { window, __errorMessages, __resetWindowMessages } from "./helpers/vscodeMock";
import { discardChanges } from "../src/commands/workingChanges";
import { GitService } from "../src/git/gitService";
import { git, commitText, safetyFixture } from "./helpers/gitSafetyFixture";

/** Native merge 충돌과 VS Code 경고창의 응답만 대체한 실제 명령 의존성을 만든다. */
async function fixture(t: TestContext) {
  const f = await safetyFixture(t, "discard-command");
  await git(f.root,"branch","incoming"); await commitText(f.root,"ours\n","ours");
  await git(f.root,"switch","-q","incoming"); await commitText(f.root,"theirs\n","theirs");
  await git(f.root,"switch","-q","main"); await assert.rejects(git(f.root,"merge","--no-edit","incoming"));
  __resetWindowMessages(); t.after(__resetWindowMessages);
  const service = new GitService(f.root); let active = true;
  const original = service.discard.bind(service);
  const mutation = t.mock.method(service,"discard",async (...args: Parameters<typeof service.discard>) => {
    try { return await original(...args); } finally { active = false; }
  });
  const deps: any = { changesView: { getActiveRepo: () => active ? f.root : undefined, setStatusGroups() {} }, registry: { get: () => service } };
  return {...f,service,deps,mutation};
}

test("discard confirmation explicitly describes HEAD conflict resolution before running the write", async t => {
  const f = await fixture(t); let detail = "";
  t.mock.method(window,"showWarningMessage",async (_message: string, options: any, ...actions: string[]) => {
    detail = options.detail; assert.equal(f.mutation.mock.callCount(),0);
    assert.match(await readFile(join(f.root,"tracked.txt"),"utf8"), /<<<<<<< /);
    return actions[0];
  });
  await discardChanges(f.deps,["tracked.txt"]);
  assert.match(detail,/1 conflicted file.*HEAD.*marked resolved/);
  assert.match(detail,/Staged changes in other files will be kept/);
  assert.equal(await git(f.root,"ls-files","--unmerged"),"");
  assert.equal(await readFile(join(f.root,"tracked.txt"),"utf8"),"ours\n");
  assert.deepEqual(__errorMessages,[]);
});

test("cancelling conflict discard leaves every index stage and working file unchanged", async t => {
  const f = await fixture(t), index = await git(f.root,"ls-files","--stage"), file = await readFile(join(f.root,"tracked.txt"));
  t.mock.method(window,"showWarningMessage",async () => undefined);
  await discardChanges(f.deps,["tracked.txt"]);
  assert.equal(f.mutation.mock.callCount(),0);
  assert.equal(await git(f.root,"ls-files","--stage"),index);
  assert.deepEqual(await readFile(join(f.root,"tracked.txt")),file);
});

test("a failed discard preview reports its error without confirming or writing", async t => {
  const f = await fixture(t), index = await git(f.root,"ls-files","--stage"), file = await readFile(join(f.root,"tracked.txt"));
  const warning = t.mock.method(window,"showWarningMessage",async () => undefined);
  t.mock.method(f.service,"prepareDiscard",async () => { throw new Error("Native discard preview read failed"); });
  await discardChanges(f.deps,["tracked.txt"]);
  assert.equal(warning.mock.callCount(),0); assert.equal(f.mutation.mock.callCount(),0);
  assert.ok(__errorMessages.some(message => message.includes("Native discard preview read failed")));
  assert.equal(await git(f.root,"ls-files","--stage"),index);
  assert.deepEqual(await readFile(join(f.root,"tracked.txt")),file);
});
