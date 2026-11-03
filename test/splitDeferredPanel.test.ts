import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SplitPanel } from "../src/webview/splitPanel";
import { DiffHunkService } from "../src/git/diffHunkService";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 패널의 메시지 처리·상세 읽기를 사용하되 VS Code 전송과 창 생성만 대체한다. */
function panel(service: DiffHunkService, files: unknown[]) {
  const posted: any[] = [], instance = Object.create(SplitPanel.prototype) as any;
  Object.assign(instance, { service, files, readGeneration: 1, detailReads: new Map(),
    panel: { webview: { postMessage: (message: unknown) => { posted.push(message); } } } });
  return { instance, posted };
}

test("deferred file messages load only the named file and the resulting hunks stage precisely", async t => {
  const { root } = await safetyFixture(t, "deferred-panel-bridge");
  for (const file of ["selected.txt", "neighbor.txt"]) await writeFile(join(root, file), "one\ntwo\n");
  const service = new DiffHunkService(root), files = await service.getWorkingDiff({ syntheticByteBudget: 0 });
  const { instance, posted } = panel(service, files);
  await instance.handleMessage({ type: "loadFileDetails", path: "selected.txt", generation: 1 });
  assert.equal(posted.length, 1); assert.equal(posted[0].type, "fileDetails");
  assert.deepEqual(posted[0].files.map((file: any) => file.path), ["selected.txt"]);
  assert.equal(posted[0].workingFile.text, "one\ntwo\n");
  const selected = instance.files.find((file: any) => file.path === "selected.txt");
  assert.equal(selected.deferred, undefined);
  assert.equal(instance.files.find((file: any) => file.path === "neighbor.txt").deferred, true);
  await service.stageSelections(instance.files, [{ path: selected.path, stage: "unstaged", binary: false,
    hunkIds: selected.hunks.map((hunk: any) => hunk.id) }]);
  assert.equal(await git(root, "diff", "--cached", "--name-only"), "selected.txt");
});

test("snapshot replacement cancels a pending deferred file and suppresses publication", async t => {
  const service = new DiffHunkService("/fixture"), { instance, posted } = panel(service,
    [{ path: "new.txt", stage: "unstaged", header: "", hunks: [], binary: false, deferred: true }]);
  let started!: () => void, cancelled = false;
  const ready = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(service, "getFileWorkingDiff", async (_path, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => { cancelled = true; reject(new DOMException("cancelled", "AbortError")); }, { once: true }); started();
  }));
  const loading = instance.handleMessage({ type: "loadFileDetails", path: "new.txt", generation: 1 });
  await ready; instance.cancelDetails(); await loading;
  assert.equal(cancelled, true); assert.deepEqual(posted, []); assert.equal(instance.detailReads.size, 0);
});

test("unexpected paths and obsolete snapshots never start deferred Git reads", async t => {
  const service = new DiffHunkService("/fixture"), { instance, posted } = panel(service,
    [{ path: "new.txt", stage: "unstaged", header: "", hunks: [], binary: false, deferred: true }]);
  let reads = 0; t.mock.method(service, "getFileWorkingDiff", async () => { reads++; return []; });
  await instance.handleMessage({ type: "loadFileDetails", path: "../outside.txt", generation: 1 });
  await instance.handleMessage({ type: "loadFileDetails", path: "new.txt", generation: 0 });
  assert.equal(reads, 0); assert.deepEqual(posted, []);
});
