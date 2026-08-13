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
  writeFileSync(executable, `#!/bin/sh\n[ -n "$GSC_FAKE_GH_DELAY" ] && sleep "$GSC_FAKE_GH_DELAY"\necho "$@" >> "${calls}"\ncase "$1:$2" in\n  pr:view) echo '{"number":7,"title":"PR","headRefName":"main"}' ;;\n  repo:view) echo '{"nameWithOwner":"owner/repo"}' ;;\n  api:*) echo '[]' ;;\n  *) exit 1 ;;\nesac\n`);
  chmodSync(executable, 0o755);
  return { executable, calls };
}

/** 임시 Git 저장소를 만들어 실제 branch 조회와 fake gh 조회를 함께 검증한다. */
function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "gsc-pr-comments-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  return root;
}

/**
 * 캐시 정책만 검증할 때 원격 응답과 같은 모양의 전체 PR 데이터를 만든다.
 * @param payload body/HTML/diff/suggested changeset 에 그대로 넣을 문자열
 * @returns 축약 여부와 중첩 문자열 weight 를 검증할 수 있는 PR 결과
 */
function policyData(payload = ""): any {
  return {
    number: 7,
    title: "PR",
    headRefName: "main",
    comments: [{
      id: "1",
      author: "reviewer",
      body: payload,
      bodyText: payload,
      bodyHtml: `<p>${payload}</p>`,
      diffHunk: payload,
      suggestedChangesets: [payload],
      path: "file.ts",
    }],
  };
}

/**
 * private 캐시 정책 seam 을 통해 완료 결과를 저장하고 내부 Map 을 반환한다.
 * @param cache 정책 검증용 PullRequestCommentCache 인스턴스
 * @param key 저장할 완료 캐시 키
 * @param data 변형 없이 보존해야 하는 전체 PR 결과
 * @returns 정책 적용 뒤의 완료 캐시 Map
 */
function storePolicyEntry(cache: any, key: string, data = policyData()): Map<string, any> {
  cache.storeCompletedEntry(key, data);
  return cache.cache;
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

test("완료 PR 결과는 활성 1건과 LRU 과거 7건만 보존하고 퇴거 뒤 한 번 재조회한다", async (t) => {
  const root = createRepository();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache: any = new PullRequestCommentCache({ get: async () => undefined } as any);
  const key = `${root}\0main`;
  storePolicyEntry(cache, key);
  for (let index = 1; index <= 8; index++) storePolicyEntry(cache, `other-${index}`);
  assert.equal(cache.cache.size, 8);
  assert.equal(cache.cache.has(key), false);

  let remoteLoads = 0;
  cache.loadUncached = async () => {
    remoteLoads++;
    const data = policyData("reloaded");
    cache.storeCompletedEntry(key, data);
    return data;
  };
  await cache.load(root);
  await cache.load(root);
  assert.equal(remoteLoads, 1);
  assert.equal(cache.cache.get(key).data.comments[0].body, "reloaded");
});

test("LRU hit, 전체 TTL sweep, oversize 활성 해제와 dispose는 완료 캐시만 결정적으로 정리한다", () => {
  let now = 0;
  const cache: any = new PullRequestCommentCache({ get: async () => undefined } as any, {
    now: () => now,
    ttlMs: 10,
    maxHistoricalEntries: 2,
    maxHistoricalWeight: 200,
  });
  vscodeMock.__resetOutputLines();
  storePolicyEntry(cache, "one");
  storePolicyEntry(cache, "two");
  storePolicyEntry(cache, "three");
  assert.equal(cache.cache.has("one"), true);
  cache.freshEntry("one");
  storePolicyEntry(cache, "four");
  assert.equal(cache.cache.has("one"), true);
  assert.equal(cache.cache.has("two"), false);

  now = 10;
  cache.sweepExpiredEntries();
  assert.equal(cache.cache.size, 0);
  assert.ok(vscodeMock.__outputLines.some((line) => line.includes('"reason":"expiry"') && line.includes('"removed":3')));

  const oversized = policyData("x".repeat(500));
  storePolicyEntry(cache, "oversized", oversized);
  assert.equal(cache.cache.get("oversized").data, oversized);
  storePolicyEntry(cache, "next");
  assert.equal(cache.cache.has("oversized"), false);
  assert.equal(cache.cache.has("next"), true);
  assert.ok(vscodeMock.__outputLines.some((line) => line.includes('"reason":"oversizeRelease"')));

  const pending = { controller: new AbortController(), promise: Promise.resolve(undefined) };
  cache.inFlightLoads.set("pending", pending);
  cache.dispose();
  assert.equal(pending.controller.signal.aborted, true);
  assert.equal(cache.cache.size, 0);
  assert.equal(cache.inFlightLoads.size, 0);
  assert.equal(cache.repoGenerations.size, 0);
  assert.ok(vscodeMock.__outputLines.some((line) => line.includes('"reason":"dispose"') && line.includes('"remaining":0')));
});

test("활성 파일 교체는 표시 요청만 취소하고 진행 중인 PR 로드는 유지한다", async (t) => {
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
  let loadSignal: AbortSignal | undefined;
  let cacheCancelReason = "";
  cache.load = async (_root: string, signal?: AbortSignal) => {
    loadSignal = signal;
    return result.promise;
  };
  cache.cancel = (reason: string) => { cacheCancelReason = reason; };
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
  assert.equal(loadSignal, undefined);
  assert.equal(cacheCancelReason, "");
  assert.equal((controller as any).activeThreads.size, 0);
  controller.dispose();
});
