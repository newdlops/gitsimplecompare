import assert from "node:assert/strict";
import test from "node:test";
import * as vscode from "vscode";
import { ChangesViewProvider } from "../src/webview/changesViewProvider";
import { __executedCommands, __resetWindowMessages } from "./helpers/vscodeMock";

/** 뷰·브라우저 대역 없이 production 메시지 라우터의 명령 경계를 직접 확인할 provider를 만든다. */
function provider(): ChangesViewProvider {
  const memento = { get: (_key: string, fallback?: unknown) => fallback, update: async () => {} };
  return new ChangesViewProvider(vscode.Uri.file(process.cwd()), memento as vscode.Memento, () => false, () => {});
}

/** 실제 postMessage callback이 호출하는 라우터에 미검증 외부 메시지를 전달한다. */
function receive(view: ChangesViewProvider, message: unknown): void {
  (view as unknown as { handleMessage(message: unknown): void }).handleMessage(message);
}

/** 임의 명령·prototype 이름·비문자 액션이 실행 경계로 넘어가지 않는지 검증한다. */
test("onboarding host dispatches only its four setup commands", () => {
  __resetWindowMessages();
  const view = provider();
  for (const action of ["git.clone", "__proto__", "constructor", "toString", undefined, {}, 1]) {
    receive(view, { type: "repositorySetup", action });
  }
  assert.equal(__executedCommands.length, 0);
  for (const action of ["clone", "github", "open", "init"]) receive(view, { type: "repositorySetup", action });
  assert.deepEqual(__executedCommands.map(command => command.id), [
    "gitSimpleCompare.cloneRepository", "gitSimpleCompare.cloneFromGitHub",
    "gitSimpleCompare.openRepository", "gitSimpleCompare.initializeRepository",
  ]);
  assert.ok(__executedCommands.every(command => command.args.length === 0));
});

/** 완료 경로는 host의 실제 성공 결과만 사용하고 웹뷰가 제공한 다른 폴더는 무시한다. */
test("opening a completed repository uses the verified host root", () => {
  __resetWindowMessages();
  const view = provider();
  receive(view, { type: "repositorySetupOpenCompleted", repositoryRoot: "/unverified" });
  assert.equal(__executedCommands.length, 0);
  view.setRepositorySetupState({ phase: "complete", repositoryRoot: "/verified/repository" });
  receive(view, { type: "repositorySetupOpenCompleted", repositoryRoot: "/unverified" });
  assert.deepEqual(__executedCommands, [{ id: "gitSimpleCompare.openRepository", args: [{ directory: "/verified/repository" }] }]);
});

/** 새 저장소 선택 뒤 늦게 끝나는 기존 workspace 조회가 활성 저장소를 되돌리지 않는지 확인한다. */
test("repository discovery preserves a newly selected setup repository", () => {
  const view = provider();
  const repos = [{ root: "/previous", name: "previous", branch: "main" }, { root: "/new", name: "new", branch: "main" }];
  view.setRepositories(repos, "/previous");
  view.selectRepo("/new");
  view.setRepositories(repos, "/previous");
  assert.equal(view.getActiveRepo(), "/new");
  view.setRepositories([repos[0]], "/previous");
  assert.equal(view.getActiveRepo(), "/previous");
});

/** 전체 새로고침을 기다리는 온보딩은 standalone status/stash를 중복 시작하지 않는다. */
test("onboarding repository selection preserves comparison cleanup and defers reads to the awaited refresh", () => {
  __resetWindowMessages();
  const view = provider();
  view.setRepositories([{ root: "/previous", branch: "main" }, { root: "/new", branch: "main" }]);
  view.selectRepo("/new", { refresh: false });
  assert.equal(view.getActiveRepo(), "/new");
  assert.deepEqual(__executedCommands.map(command => command.id), ["gitSimpleCompare.clearExplorerComparison"]);
  __resetWindowMessages();
  view.selectRepo("/previous");
  assert.deepEqual(__executedCommands.map(command => command.id), [
    "gitSimpleCompare.clearExplorerComparison", "gitSimpleCompare.refreshWorkingChanges", "gitSimpleCompare.refreshStashes",
  ]);
});
