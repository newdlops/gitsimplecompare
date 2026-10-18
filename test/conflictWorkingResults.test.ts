import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ConflictWorkingResult } from "../src/git/conflictContentService";
import { ConflictService } from "../src/git/conflictService";
import { safetyFixture } from "./helpers/gitSafetyFixture";

/** 묶음 결과 중 성공한 한 파일을 꺼내 실패가 text로 위장되지 않게 검사한다. */
function value(results: ReadonlyMap<string, PromiseSettledResult<ConflictWorkingResult>>, rel: string): ConflictWorkingResult {
  const result = results.get(rel); assert.equal(result?.status, "fulfilled", rel);
  return (result as PromiseFulfilledResult<ConflictWorkingResult>).value;
}

/** NUL 경로 전달과 binary/absent/nonfile 분류가 기존 단일 파일 읽기와 일치해야 한다. */
test("one working Result batch preserves every path, kind, full text and CAS version", async t => {
  const { root } = await safetyFixture(t, "conflict-working-batch");
  const newline = process.platform === "win32" ? "line name.txt" : "line\nname.txt";
  const paths = ["plain.txt", "한글 [literal].txt", newline, "forced.txt", "bytes.bin", "missing.txt", "directory"];
  await writeFile(join(root, ".gitattributes"), "forced.txt -diff\n");
  for (const rel of paths.slice(0, 4)) await writeFile(join(root, rel), `${rel}\r\n한글🙂\r\n`);
  await writeFile(join(root, "bytes.bin"), Buffer.from([0xff, 97])); await mkdir(join(root, "directory"));
  const service = new ConflictService(root), original = childProcess.spawn; let calls = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => { calls++; return (original as Function)(...args); });
  const batch = await service.getWorkingResults([...paths, "plain.txt"], true);
  assert.equal(calls, 1); assert.equal(batch.size, paths.length);
  for (const rel of paths) assert.deepEqual(value(batch, rel), await service.getWorkingResult(rel, true));
  assert.equal(value(batch, newline).content, `${newline}\r\n한글🙂\r\n`);
  assert.equal(value(batch, "forced.txt").state.kind, "binary"); assert.equal(value(batch, "bytes.bin").state.kind, "binary");
  assert.equal(value(batch, "missing.txt").state.kind, "absent"); assert.equal(value(batch, "directory").state.kind, "nonfile");
  await writeFile(join(root, ".gitattributes"), "forced.txt diff\n");
  assert.equal(value(await service.getWorkingResults(["forced.txt"], true), "forced.txt").state.kind, "text");
});

/** symlink leaf는 대상 원문을 읽지 않고, 부모 symlink의 실패는 다른 파일과 분리한다. */
test("working Result batches keep no-follow paths and isolate one unsafe parent", { skip: process.platform === "win32" }, async t => {
  const { root, directory } = await safetyFixture(t, "conflict-working-symlink");
  const outside = join(directory, "outside"); await mkdir(outside);
  const secret = join(outside, "secret.txt"); await writeFile(secret, "external content must stay private\n");
  await writeFile(join(root, "normal.txt"), "safe content\n");
  await symlink(secret, join(root, "link.txt")); await symlink(outside, join(root, "parent-link"));
  const service = new ConflictService(root);
  const batch = await service.getWorkingResults(["normal.txt", "link.txt", "parent-link/secret.txt"], true);
  assert.equal(value(batch, "normal.txt").content, "safe content\n");
  const link = value(batch, "link.txt"); assert.equal(link.state.kind, "symlink"); assert.equal(link.content, secret);
  assert.equal(batch.get("parent-link/secret.txt")?.status, "rejected");
  assert.equal(await readFile(secret, "utf8"), "external content must stay private\n");
});

/** 잘못된 경로나 끝난 요청은 실제 Git/파일 IO 전에 거부하고 빈 요청은 바로 끝낸다. */
test("empty, unsafe and already cancelled working batches never start Git", async t => {
  const { root } = await safetyFixture(t, "conflict-working-empty");
  const service = new ConflictService(root), original = childProcess.spawn; let calls = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => { calls++; return (original as Function)(...args); });
  assert.equal((await service.getWorkingResults([])).size, 0);
  await assert.rejects(service.getWorkingResults(["tracked.txt", "../outside.txt"]));
  await assert.rejects(service.getWorkingResults(["bad\0name.txt"]));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.getWorkingResults(["tracked.txt"], true, controller.signal), { name: "AbortError" });
  assert.equal(calls, 0);
});

/** 실행 중 취소도 실제 Git close를 기다려 background queue에 종료 전 프로세스가 쌓이지 않게 한다. */
test("cancelled working Result batches finish only after the owned Git process closes", async t => {
  const { root } = await safetyFixture(t, "conflict-working-cancel");
  const service = new ConflictService(root), controller = new AbortController(), original = childProcess.spawn;
  let closed = false;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const child = (original as Function)(...args); child.once("close", () => { closed = true; });
    queueMicrotask(() => controller.abort()); return child;
  });
  await assert.rejects(service.getWorkingResults(["tracked.txt"], true, controller.signal), { name: "AbortError" });
  assert.equal(closed, true);
});
