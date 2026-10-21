import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { gitCommandIndex } from "../src/git/gitCommandPolicy";
import { captureRebaseCheckout } from "../src/git/rebasePlanSafety";
import { RebaseService } from "../src/git/rebaseService";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

test("Start validates topology and coverage once without reading large commit bodies and retains both fresh guards", async t => {
  const f = await safetyFixture(t, "rebase-range-metadata");
  const messageFile = join(f.directory, "message");
  await writeFile(messageFile, "first\n\n" + "body data\n".repeat(128 * 1024));
  await writeFile(join(f.root, "first.txt"), "first\n"); await git(f.root, "add", "first.txt");
  await git(f.root, "commit", "-qF", messageFile);
  const first = await git(f.root, "rev-parse", "HEAD");
  await writeFile(join(f.root, "second.txt"), "second\n"); await git(f.root, "add", "second.txt");
  await git(f.root, "commit", "-qm", "second");
  const second = await git(f.root, "rev-parse", "HEAD"), tree = await git(f.root, "rev-parse", "HEAD^{tree}");
  const checkout = await captureRebaseCheckout(f.root);
  const calls: { args: string[]; stdoutBytes: number }[] = [], spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const child = (spawn as Function)(...args);
    if (args[0] === "git") {
      const call = { args: [...args[1]], stdoutBytes: 0 }; calls.push(call);
      child.stdout?.on("data", (chunk: Buffer) => { call.stdoutBytes += chunk.length; });
    }
    return child;
  });
  const result = await new RebaseService(f.root, { nativeEditors: true }).start(f.head, false,
    [{ hash: second, action: "pick" }, { hash: first, action: "pick" }], resolve("media/rebase/rebaseEditor.js"), undefined, checkout);
  assert.equal(result.status, "completed", result.message);
  const metadata = calls.filter(call => ["log", "rev-list"].includes(call.args[gitCommandIndex(call.args)]));
  const metadataBytes = metadata.reduce((sum, call) => sum + call.stdoutBytes, 0);
  t.diagnostic(`Start Git calls=${calls.length}, range reads=${metadata.length}, range stdout bytes=${metadataBytes}`);
  assert.equal(metadata.length, 1, "Topology and todo coverage must share one fresh range read");
  assert.ok(metadataBytes < 4096, "Commit bodies are not needed for a valid todo");
  assert.equal(calls.filter(call => call.args.includes("--symbolic-full-name")).length, 2);
  assert.equal(await git(f.root, "rev-parse", "HEAD^{tree}"), tree);
  assert.equal(await git(f.root, "log", "--reverse", "--format=%s", `${f.head}..HEAD`), "second\nfirst");
  assert.equal(await git(f.root, "status", "--porcelain=v1"), "");
  assert.equal(await readFile(join(f.root, "first.txt"), "utf8"), "first\n");
  assert.equal(await git(f.root, "log", "-1", "--format=%B"), (await readFile(messageFile, "utf8")).trim());
});
