import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as vscode from "vscode";
import {
  finishRepositoryHandoff, registerBuiltinGitControl, rememberRepositoryHandoff,
  REPOSITORY_HANDOFF_STATE, setBuiltinGitStatusReuse, syncBuiltinGitContext, toggleBuiltinGit,
} from "../src/ui/builtinGitControl";
import { VscodeGitStatusProvider } from "../src/providers/vscodeGitStatusProvider";
import { registerViewConfigurationEvents } from "../src/ui/viewConfiguration";
import {
  __errorMessages, __executedCommands, __informationMessages, __outputLines,
  __resetOutputLines, __resetWindowMessages,
} from "./helpers/vscodeMock";

/**  실제 Memento의 기본값·삭제·재등록 의미를 갖는 확장 전용 상태 대역이다. */
function memoryStorage() {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback,
    update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, value); },
  };
}
type Settings = Record<string, unknown>;

/**
 * 두 설정 namespace를 분리하고 native Git 쓰기를 기록하는 실제 상속 경계 fixture다.
 * @param t 설정 객체와 확장 상태의 정리를 관리하는 컨텍스트
 * @param nativeEnabled 기존 사용자가 선택한 git.enabled 값
 * @returns 확장 설정·native 설정·저장 기록과 새 activation을 실행할 fixture
 */
async function fixture(t: TestContext, nativeEnabled = false) {
  const workspace = vscode.workspace as unknown as { workspaceFolders?: unknown[]; getConfiguration: (...args: unknown[]) => unknown };
  const originalFolders = workspace.workspaceFolders, originalConfiguration = workspace.getConfiguration;
  const native = { enabled: nativeEnabled, autorefresh: false, autofetch: "all" } as Settings;
  const user = {} as Settings, current = {} as Settings;
  const writes: Array<{ section: string; key: string; value: unknown; target: unknown }> = [];
  let beforeWrite = async () => {};
  workspace.workspaceFolders = [{ uri: vscode.Uri.file("/repo"), name: "repo", index: 0 }];
  workspace.getConfiguration = (section) => ({
    get: (key: string, fallback: unknown) => section === "git" ? native[key] ?? fallback : current[key] ?? user[key] ?? fallback,
    inspect: (key: string) => section === "git"
      ? { defaultValue: true, globalValue: native[key], workspaceValue: native[key] }
      : { defaultValue: key === "useBuiltinGitStatus" ? false : undefined, globalValue: user[key], workspaceValue: current[key] },
    update: async (key: string, value: unknown, target: unknown) => {
      writes.push({ section: String(section), key, value, target });
      assert.equal(section, "gitSimpleCompare", "Native Git settings must never be written.");
      await beforeWrite();
      const values = target === vscode.ConfigurationTarget.Global ? user : current;
      if (value === undefined) delete values[key]; else values[key] = value;
    },
  });
  __resetWindowMessages();
  __resetOutputLines();
  const context = { globalState: memoryStorage(), workspaceState: memoryStorage() };
  let registration = registerBuiltinGitControl(context as unknown as vscode.ExtensionContext);
  await registration.ready;
  t.after(() => {
    registration.dispose(); workspace.workspaceFolders = originalFolders; workspace.getConfiguration = originalConfiguration;
    __resetWindowMessages(); __resetOutputLines();
  });
  return {
    user, current, native, writes, context,
    beforeWrite: (callback: () => Promise<void>) => { beforeWrite = callback; },
    restart: async () => { registration.dispose(); registration = registerBuiltinGitControl(context as unknown as vscode.ExtensionContext); await registration.ready; },
  };
}

/** 활성화·설정 선택·재시작이 사용자 기존 false를 그대로 보존하는지 검증한다. */
test("자체 Git이 기본이며 activation과 조회 엔진 토글은 git.enabled 및 모든 기본 Git 설정을 보존한다", async t => {
  const f = await fixture(t);
  const original = structuredClone(f.native);
  assert.equal(f.writes.length, 0);
  syncBuiltinGitContext();
  const state = (key: string) => __executedCommands.filter(command => command.args[0] === key).at(-1)?.args[1];
  assert.equal(state("gitSimpleCompare.builtinGit.enabled"), false);
  await toggleBuiltinGit();
  assert.equal(f.current.useBuiltinGitStatus, true);
  await toggleBuiltinGit();
  assert.equal(f.current.useBuiltinGitStatus, false);
  await f.restart();
  assert.deepEqual(f.native, original);
  assert.ok(f.writes.every(write => write.section === "gitSimpleCompare"));
  assert.ok(__informationMessages.every(message => message.includes("settings are unchanged")));
});

/** native Git이 켜진 사용자에게도 background 설정 변경을 부수 효과로 추가하지 않는지 확인한다. */
test("기본 Git이 켜져 있어도 자체 설정만 저장한다", async t => {
  const f = await fixture(t, true);
  await setBuiltinGitStatusReuse(true, "user");
  await setBuiltinGitStatusReuse(false, "workspace");
  assert.deepEqual(f.native, { enabled: true, autorefresh: false, autofetch: "all" });
  assert.equal(f.user.useBuiltinGitStatus, true);
  assert.equal(f.current.useBuiltinGitStatus, false);
});

/** workspace의 명시적 자체 엔진 선택을 전역 변경이 덮어쓰지 않는지 확인한다. */
test("사용자 기본값과 workspace 조회 엔진 선택은 독립된 메뉴 체크로 표시한다", async t => {
  const f = await fixture(t);
  f.current.useBuiltinGitStatus = false;
  await toggleBuiltinGit("user");
  assert.equal(f.user.useBuiltinGitStatus, true);
  assert.equal(f.current.useBuiltinGitStatus, false);
  const state = (key: string) => __executedCommands.filter(command => command.args[0] === key).at(-1)?.args[1];
  assert.equal(state("gitSimpleCompare.builtinGit.enabled"), false);
  assert.equal(state("gitSimpleCompare.builtinGit.userEnabled"), true);
});

/** 빈 시작 창의 엔진 선택이 사용자 범위에만 저장되고 native flags는 유지되는지 확인한다. */
test("workspace가 없는 시작 창에서는 사용자 조회 엔진 기본값만 저장한다", async t => {
  const f = await fixture(t);
  Object.assign(vscode.workspace, { workspaceFolders: undefined });
  await toggleBuiltinGit();
  assert.equal(f.writes.length, 0);
  await toggleBuiltinGit("user");
  assert.equal(f.user.useBuiltinGitStatus, true);
  assert.equal(f.native.enabled, false);
  assert.ok(f.writes.every(write => write.target === vscode.ConfigurationTarget.Global));
});

/** 저장 도중 반복 입력은 한 번만 저장하고 UI busy를 정상 해제하는지 확인한다. */
test("조회 엔진 저장 중 중복 토글은 무시한다", async t => {
  const f = await fixture(t);
  let finish!: () => void;
  f.beforeWrite(() => new Promise<void>(resolve => { finish = resolve; }));
  __executedCommands.length = 0;
  const running = toggleBuiltinGit();
  while (!finish) await new Promise<void>(resolve => setImmediate(resolve));
  await toggleBuiltinGit("user");
  assert.equal(f.writes.length, 1);
  finish(); await running;
  assert.deepEqual(__executedCommands.filter(command => command.args[0] === "gitSimpleCompare.builtinGit.busy")
    .map(command => command.args), [["gitSimpleCompare.builtinGit.busy", true], ["gitSimpleCompare.builtinGit.busy", false]]);
});

/** own 설정 쓰기 실패가 native 설정 복구라는 별도 쓰기를 만들지 않는지 확인한다. */
test("조회 엔진 저장 실패는 OUTPUT에 기록하며 기본 Git 설정은 계속 보존한다", async t => {
  const f = await fixture(t);
  f.beforeWrite(async () => { throw new Error("own settings are read-only"); });
  await toggleBuiltinGit();
  assert.equal(__errorMessages.length, 1);
  assert.equal(__informationMessages.length, 0);
  assert.equal(f.native.enabled, false);
  assert.ok(__outputLines.some(line => line.includes("own settings are read-only")));
  f.beforeWrite(async () => {});
  await toggleBuiltinGit();
  assert.equal(f.current.useBuiltinGitStatus, true);
});

/** 자체 Git을 선택한 경우 native 확장 조회·활성화를 한 번도 실행하지 않는지 확인한다. */
test("상태 어댑터는 기본값에서 이미 켜진 VS Code Git도 읽거나 활성화하지 않는다", async t => {
  const f = await fixture(t, true);
  f.native.autorefresh = true;
  let reads = 0;
  t.mock.method(vscode.extensions, "getExtension", () => { reads++; throw new Error("Native API must not be accessed."); });
  const provider = new VscodeGitStatusProvider(() => {});
  t.after(() => provider.dispose());
  assert.equal(await provider.ensureReady(), false);
  assert.equal(await provider.getRepositories(), undefined);
  assert.equal(await provider.getStatusGroups("/repo"), undefined);
  assert.equal(provider.getStatusRevision("/repo"), undefined);
  assert.equal(reads, 0);
});

/** 명시적 재사용 선택이 있어도 git.enabled=false 또는 오래된 cache는 CLI로 폴백하는지 확인한다. */
test("명시적 native 캐시 재사용도 기본 Git의 활성화·자동 갱신 설정을 읽기만 한다", async t => {
  const f = await fixture(t);
  f.current.useBuiltinGitStatus = true;
  const event = () => ({ dispose() {} });
  let reads = 0;
  t.mock.method(vscode.extensions, "getExtension", () => {
    reads++;
    return { isActive: true, exports: { getAPI: () => ({
      repositories: [{ rootUri: vscode.Uri.file("/repo"), state: {
        HEAD: { name: "main", commit: "head" }, indexChanges: [], workingTreeChanges: [],
        untrackedChanges: [], mergeChanges: [], onDidChange: event,
      } }], onDidOpenRepository: event, onDidCloseRepository: event,
    }), onDidChangeEnablement: event } } as any;
  });
  const provider = new VscodeGitStatusProvider(() => {});
  t.after(() => provider.dispose());
  assert.equal(await provider.ensureReady(), false);
  assert.equal(reads, 0);
  f.native.enabled = true;
  assert.equal(await provider.ensureReady(), false);
  f.native.autorefresh = true;
  assert.equal(await provider.ensureReady(), true);
  assert.deepEqual(await provider.getRepositories(), [{ root: "/repo", branch: "main" }]);
  const configuration = vscode.workspace.getConfiguration;
  let folderRefresh = false;
  t.mock.method(vscode.workspace, "getConfiguration", (section: string, uri?: vscode.Uri) => {
    const config = configuration(section, uri);
    return section === "git" && uri ? { ...config, get: (key: string, fallback?: unknown) =>
      key === "autorefresh" ? folderRefresh : config.get(key, fallback) } : config;
  });
  assert.equal(await provider.getRepositories(), undefined);
  assert.equal(await provider.getStatusGroups("/repo"), undefined);
  assert.equal(provider.getStatusRevision("/repo"), undefined);
  folderRefresh = true;
  assert.deepEqual(await provider.getRepositories(), [{ root: "/repo", branch: "main" }]);
  f.current.useBuiltinGitStatus = false;
  assert.equal(await provider.getStatusGroups("/repo"), undefined);
  assert.equal(f.writes.length, 0);
});

/** 창 재시작 뒤 일치한 저장소만 한 번 Changes로 이어 주고 기본 Git 설정을 유지하는지 확인한다. */
test("온보딩 handoff는 해당 저장소에서만 소비하며 native Git이나 window reload를 실행하지 않는다", async t => {
  const f = await fixture(t);
  const registration = vscode.commands.registerCommand("gitSimpleCompare.openRepository", async (args: { directory: string; open: string }) => {
    assert.deepEqual(args, { directory: "/repo", open: "current" });
    await vscode.commands.executeCommand("gitSimpleCompare.showChanges");
    await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges");
    await finishRepositoryHandoff(f.context.globalState as vscode.Memento, args.directory);
  });
  t.after(() => registration.dispose());
  await rememberRepositoryHandoff(f.context.globalState as vscode.Memento, "/another");
  await rememberRepositoryHandoff(f.context.globalState as vscode.Memento, "/repo");
  __executedCommands.length = 0;
  await f.restart();
  assert.deepEqual(f.context.globalState.get(REPOSITORY_HANDOFF_STATE), ["/another"]);
  assert.ok(__executedCommands.some(command => command.id === "gitSimpleCompare.showChanges"));
  assert.ok(__executedCommands.some(command => command.id === "gitSimpleCompare.refreshChanges"));
  assert.ok(__executedCommands.every(command => command.id !== "workbench.action.reloadWindow" && !command.id.startsWith("git.")));
  assert.equal(f.native.enabled, false);
  assert.equal(f.writes.length, 0);
  __executedCommands.length = 0;
  await f.restart();
  assert.ok(!__executedCommands.some(command => command.id === "gitSimpleCompare.showChanges"));
  await finishRepositoryHandoff(f.context.globalState as vscode.Memento, "/another");
  assert.deepEqual(f.context.globalState.get(REPOSITORY_HANDOFF_STATE), []);
});

test("저장소 handoff는 연결 명령이 실패하거나 완료하지 못하면 다음 시작을 위해 보존한다", async t => {
  const f = await fixture(t);
  await rememberRepositoryHandoff(f.context.globalState as vscode.Memento, "/repo");
  const registration = vscode.commands.registerCommand("gitSimpleCompare.openRepository", async () => { throw new Error("open failed"); });
  t.after(() => registration.dispose());
  await f.restart();
  assert.deepEqual(f.context.globalState.get(REPOSITORY_HANDOFF_STATE), ["/repo"]);
  assert.match(__errorMessages.join("\n"), /Could not open Git Simple Compare/);
});

/** 자체 엔진 설정도 기존 cache 무효화 경계에 전달하는지 확인한다. */
test("엔진 선택 변경은 상태 무효화와 뷰 새로고침에 전달한다", async t => {
  await fixture(t);
  let callback!: (event: { affectsConfiguration(key: string): boolean }) => void;
  t.mock.method(vscode.workspace, "onDidChangeConfiguration", listener => { callback = listener; return { dispose() {} }; });
  const window = vscode.window as unknown as { onDidChangeActiveColorTheme: () => unknown };
  const original = window.onDidChangeActiveColorTheme;
  window.onDidChangeActiveColorTheme = () => ({ dispose() {} });
  t.after(() => { window.onDidChangeActiveColorTheme = original; });
  let changes = 0;
  const subscriptions = registerViewConfigurationEvents({ onGitEnablementChanged: () => { changes++; }, refreshView: () => {} });
  callback({ affectsConfiguration: key => key === "gitSimpleCompare.useBuiltinGitStatus" });
  assert.equal(changes, 1);
  subscriptions.forEach(subscription => subscription.dispose());
});
