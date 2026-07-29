import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PullRequestCommentCache } from "../src/providers/pullRequestCommentCache";
import { PullRequestCommentController } from "../src/providers/pullRequestCommentController";
import * as vscodeMock from "./helpers/vscodeMock";

/** 테스트가 완료 시점을 제어할 수 있는 Promise와 resolve 함수를 만든다. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** PR comment 조회용 gh 응답과 호출 횟수를 고정하는 임시 실행 파일을 만든다. */
function createFakeGh(root: string): { executable: string; calls: string } {
  const executable = join(root, "gh");
  const calls = join(root, "gh-calls.txt");
  writeFileSync(executable, `#!/bin/sh\necho "$@" >> "${calls}"\n[ -n "$GSC_FAKE_GH_DELAY" ] && sleep "$GSC_FAKE_GH_DELAY"\ncase "$1:$2" in\n  pr:view) echo '{"number":7,"title":"PR","headRefName":"main"}' ;;\n  repo:view) echo '{"nameWithOwner":"owner/repo"}' ;;\n  api:*) echo '[]' ;;\n  *) exit 1 ;;\nesac\n`);
  chmodSync(executable, 0o755);
  return { executable, calls };
}

/** 임시 Git 저장소를 만들어 실제 branch 조회와 fake gh 조회를 함께 검증한다. */
function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "gsc-pr-comments-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  return root;
}

test("같은 PR cache 요청은 singleflight가 되고 0 comment면 웹 HTML을 읽지 않는다", async (t) => {
  const root = createRepository();
  const fakeGh = createFakeGh(root);
  const previousPath = process.env.GITHUB_CLI_PATH;
  process.env.GITHUB_CLI_PATH = fakeGh.executable;
  t.after(() => {
    process.env.GITHUB_CLI_PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  });
  vscodeMock.__resetOutputLines();

  const cache = new PullRequestCommentCache({ get: async () => undefined } as any);
  const [first, second] = await Promise.all([cache.load(root), cache.load(root)]);
  assert.equal(first?.comments.length, 0);
  assert.deepEqual(second, first);
  await cache.load(root);

  const calls = readFileSync(fakeGh.calls, "utf8");
  assert.equal((calls.match(/^pr view /gm) || []).length, 1);
  assert.equal((calls.match(/^repo view /gm) || []).length, 1);
  assert.equal((calls.match(/^api /gm) || []).length, 1);
  assert.equal(calls.includes("https://github.com/owner/repo/pull/7/files"), false);
  assert.ok(vscodeMock.__outputLines.some((line) => line.includes("cache coalesced")));
  assert.ok(vscodeMock.__outputLines.some((line) => line.includes("cache hit")));
  assert.equal(vscodeMock.__outputLines.join("\n").includes("ghp_"), false);

  process.env.GSC_FAKE_GH_DELAY = "1";
  cache.invalidate("test");
  const controller = new AbortController();
  const cancelled = cache.load(root, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();
  await assert.rejects(cancelled, /cancelled/i);

  delete process.env.GSC_FAKE_GH_DELAY;
  const retry = await cache.load(root);
  assert.equal(retry?.number, 7);
  const retryCalls = readFileSync(fakeGh.calls, "utf8");
  assert.equal((retryCalls.match(/^pr view /gm) || []).length, 2);
});

test("활성 파일 교체와 취소 뒤에는 이전 PR 결과를 표시하지 않는다", async (t) => {
  const windowApi = vscodeMock.window as any;
  const workspaceApi = vscodeMock.workspace as any;
  const originalWindow = { ...windowApi };
  const originalConfiguration = workspaceApi.getConfiguration;
  const firstUri = { scheme: "file", fsPath: "/repo/first.ts", toString: () => "file:///repo/first.ts" };
  const secondUri = { scheme: "file", fsPath: "/repo/second.ts", toString: () => "file:///repo/second.ts" };
  windowApi.state = { focused: true };
  windowApi.activeTextEditor = { document: { uri: firstUri } };
  windowApi.visibleTextEditors = [];
  windowApi.createTextEditorDecorationType = () => ({ dispose() {} });
  workspaceApi.getConfiguration = () => ({ get: () => true });
  t.after(() => { Object.assign(windowApi, originalWindow); workspaceApi.getConfiguration = originalConfiguration; });

  const controller = new PullRequestCommentController({
    resolve: async () => ({ repoRoot: "/repo", toRepoRelative: () => "first.ts" }),
  } as any, { get: async () => undefined } as any);
  const result = deferred<any>();
  const cache = (controller as any).commentCache;
  let cancelled = "";
  cache.load = async (_root: string, signal: AbortSignal) => { assert.equal(signal.aborted, false); return result.promise; };
  cache.cancel = (reason: string) => { cancelled = reason; };
  (controller as any).requestSeq = 1;
  const signal = new AbortController();
  (controller as any).activeRequest = signal;
  const loading = (controller as any).refreshActiveEditor("activeEditor", 1, signal.signal);
  windowApi.activeTextEditor = { document: { uri: secondUri } };
  (controller as any).requestSeq = 2;
  (controller as any).cancelActiveRequest("activeEditor");
  result.resolve({ number: 7, comments: [{ id: "1", path: "first.ts", author: "a", body: "x" }] });
  await loading;

  assert.equal(signal.signal.aborted, true);
  assert.equal(cancelled, "activeEditor");
  assert.equal((controller as any).activeThreads.size, 0);
  controller.dispose();
});
