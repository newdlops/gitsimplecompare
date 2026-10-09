import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import * as vscode from "vscode";
import { registerRepositorySetupCommands, type RepositorySetupDependencies } from "../src/commands/repositorySetup";
import { RepositorySetupError, RepositorySetupService } from "../src/git/repositorySetupService";
import { GitHubRepositoryCatalog } from "../src/git/githubRepositoryCatalog";
import { runGit } from "../src/git/gitExec";
import { REPOSITORY_HANDOFF_STATE, registerBuiltinGitControl } from "../src/ui/builtinGitControl";
import { __executedCommands, __errorMessages, __outputLines, __resetWindowMessages, __resetOutputLines } from "./helpers/vscodeMock";

/** Memento의 비동기 저장·기본값을 유지해 실제 폴더 handoff가 완료됐는지 확인한다. */
function storage() {
  const values = new Map<string, unknown>();
  return { get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T,
    update: async (key: string, value: unknown) => { values.set(key, value); } };
}

/** native Git 설정 쓰기와 native Git API 활성화를 금지하는 production 명령 fixture다. */
async function fixture(t: TestContext, enabled = false, dependencies: RepositorySetupDependencies = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "gsc-setup-command-")));
  const root = path.join(directory, "workspace"); await mkdir(root);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = vscode.workspace as any, window = vscode.window as any;
  const originals = { folders: workspace.workspaceFolders, update: workspace.updateWorkspaceFolders, change: workspace.onDidChangeWorkspaceFolders, dialog: window.showOpenDialog };
  const native = Object.freeze({ enabled, autorefresh: false, autofetch: "all", defaultBranchName: "main" });
  const user: Record<string, unknown> = {}, current: Record<string, unknown> = {};
  const writes: Array<{ key: string; target: unknown }> = [];
  t.mock.method(vscode.workspace, "getConfiguration", (section: string) => ({
    get: (key: string, fallback?: unknown) => section === "git" ? (native as any)[key] ?? fallback : current[key] ?? user[key] ?? fallback,
    inspect: (key: string) => ({ defaultValue: false, globalValue: user[key], workspaceValue: current[key] }),
    update: async (key: string, value: unknown, target: unknown) => {
      assert.equal(section, "gitSimpleCompare", "The setup command attempted a native Git setting write.");
      writes.push({ key, target }); (target === vscode.ConfigurationTarget.Global ? user : current)[key] = value;
    },
  }));
  t.mock.method(vscode.extensions, "getExtension", () => { throw new Error("Native Git activation is forbidden in repository setup."); });
  workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: "workspace", index: 0 }];
  let folderEvent: (() => void) | undefined;
  workspace.onDidChangeWorkspaceFolders = (callback: () => void) => { folderEvent = callback; return { dispose() { folderEvent = undefined; } }; };
  workspace.updateWorkspaceFolders = (_start: number, _deleteCount: number, folder: { uri: vscode.Uri }) => {
    workspace.workspaceFolders.push({ ...folder, name: "new", index: workspace.workspaceFolders.length });
    folderEvent?.(); return true;
  };
  window.showOpenDialog = async () => undefined;
  __resetWindowMessages(); __resetOutputLines();
  const globalState = storage(), states: any[] = [], registered: string[] = [], repositories: any[] = [];
  let selected: string | undefined;
  const deps = {
    globalState,
    registry: { invalidateResolveCache() {}, get(value: string) { registered.push(value); } },
    changesView: { setRepositorySetupState(state: any) { states.push(state); }, getRepositories: () => [...repositories],
      setRepositories(values: any[]) { repositories.splice(0, repositories.length, ...values); }, selectRepo(value: string) { selected = value; } },
  } as unknown as Parameters<typeof registerRepositorySetupCommands>[0];
  const subscriptions = registerRepositorySetupCommands(deps, dependencies);
  t.after(() => {
    subscriptions.forEach(subscription => subscription.dispose());
    workspace.workspaceFolders = originals.folders; workspace.updateWorkspaceFolders = originals.update;
    workspace.onDidChangeWorkspaceFolders = originals.change; window.showOpenDialog = originals.dialog;
  });
  return { directory, root, user, current, writes, native, states, registered, repositories, globalState,
    selected: () => selected, setSelected: (value: string) => { selected = value; },
    updateFolders: (callback: typeof workspace.updateWorkspaceFolders) => { workspace.updateWorkspaceFolders = callback; },
    folderEvent: () => folderEvent?.(),
  };
}

/** 테스트용 원본 저장소를 생성하되 사용자 서명·hook·monitor 설정은 사용하지 않는다. */
async function repository(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await runGit(["-c", "init.templateDir=", "init", "-q", "--initial-branch=main"], root);
  await writeFile(path.join(root, "source.txt"), "source\n");
  await runGit(["add", "source.txt"], root);
  await runGit(["-c", "core.hooksPath=", "-c", "commit.gpgSign=false", "-c", "user.name=Setup Test", "-c", "user.email=setup@example.invalid", "commit", "-qm", "source"], root);
}

for (const enabled of [false, true]) {
  test(`native Git ${enabled}: Get Started, Init, Open and Clone use own commands and preserve native settings`, async t => {
    const f = await fixture(t, enabled);
    const before = structuredClone(f.native);
    f.user.useBuiltinGitStatus = true;
    await vscode.commands.executeCommand("gitSimpleCompare.getStarted");
    assert.equal(f.current.useBuiltinGitStatus, false);
    await vscode.commands.executeCommand("gitSimpleCompare.initializeRepository");
    assert.ok((await readFile(path.join(f.root, ".git/HEAD"), "utf8")).includes("refs/heads/main"));
    assert.equal(f.selected(), f.root);
    await vscode.commands.executeCommand("gitSimpleCompare.openRepository", { directory: f.root });
    const source = path.join(f.directory, "source"); await repository(source);
    await vscode.commands.executeCommand("gitSimpleCompare.cloneRepository", { source, parentDirectory: f.root, folderName: "cloned", open: "none" });
    assert.equal(await readFile(path.join(f.root, "cloned/source.txt"), "utf8"), "source\n");
    assert.equal(f.states.at(-1).phase, "complete");
    assert.deepEqual(f.native, before);
    assert.ok(__executedCommands.every(command => !command.id.startsWith("git.") && command.id !== "workbench.action.reloadWindow"));
    assert.equal(__errorMessages.length, 0);
  });
}

test("GitHub setup pages through repositories, keeps OAuth transient and adopts the completed clone", async t => {
  const pages: number[] = [], cloneCalls: any[] = [];
  const catalog = new GitHubRepositoryCatalog(async (url, options) => {
    pages.push(Number(new URL(url).searchParams.get("page")));
    assert.equal(new Headers(options.headers).get("authorization"), "Bearer ephemeral-token");
    return { ok: true, status: 200, headers: new Headers(pages.length === 1 ? { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } : {}),
      json: async () => [{ full_name: pages.length === 1 ? "user/public" : "organization/private", private: pages.length > 1 }] };
  });
  const service = new RepositorySetupService();
  const f = await fixture(t, false, { catalog, service });
  t.mock.method(vscode.authentication, "getSession", async (provider, scopes, options) => {
    assert.equal(provider, "github"); assert.deepEqual(scopes, ["repo"]); assert.equal((options as any).createIfNone, true);
    return { accessToken: "ephemeral-token" } as any;
  });
  let choices = 0;
  t.mock.method(vscode.window, "showQuickPick", async (items: any) => ++choices === 1
    ? items.find((item: any) => item.action === "more") : items.find((item: any) => item.repository?.isPrivate));
  t.mock.method(service, "clone", async (...args) => {
    cloneCalls.push(args); return { root: f.root, branch: "main", created: true };
  });
  await vscode.commands.executeCommand("gitSimpleCompare.cloneFromGitHub", { parentDirectory: f.directory, folderName: "cloned" });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(cloneCalls[0][0], "https://github.com/organization/private.git");
  assert.equal(cloneCalls[0][3].githubToken, "ephemeral-token");
  assert.equal(f.selected(), f.root);
  assert.equal(f.native.enabled, false);
  assert.equal(JSON.stringify([...f.states, ...__executedCommands, ...__outputLines]).includes("ephemeral-token"), false);
});

test("clone from an empty window opens a verified folder with a durable handoff", async t => {
  const f = await fixture(t);
  (vscode.workspace as any).workspaceFolders = undefined;
  const source = path.join(f.directory, "source"); await repository(source);
  await vscode.commands.executeCommand("gitSimpleCompare.cloneRepository", { source, parentDirectory: f.directory, folderName: "new repository" });
  const root = path.join(f.directory, "new repository");
  assert.deepEqual(f.globalState.get(REPOSITORY_HANDOFF_STATE), [root]);
  const opening = __executedCommands.find(command => command.id === "vscode.openFolder")!;
  assert.equal((opening.args[0] as vscode.Uri).fsPath, root);
  assert.deepEqual(opening.args[1], { forceNewWindow: false });
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
  const next = registerBuiltinGitControl({ globalState: f.globalState, workspaceState: storage() } as any);
  await next.ready; next.dispose();
  assert.equal(f.selected(), root);
  assert.deepEqual(f.globalState.get(REPOSITORY_HANDOFF_STATE), []);
});

test("adding a repository waits for the real workspace event before selection or handoff consumption", async t => {
  const f = await fixture(t);
  f.repositories.push({ root: f.root, branch: "main" }); f.setSelected(f.root);
  const source = path.join(f.directory, "new root"); await repository(source);
  let signalStarted!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  f.updateFolders(() => { signalStarted(); return true; });
  const opening = vscode.commands.executeCommand("gitSimpleCompare.openRepository", { directory: source, open: "add" });
  await started;
  assert.equal(f.selected(), f.root);
  assert.deepEqual(f.globalState.get(REPOSITORY_HANDOFF_STATE), [source]);
  (vscode.workspace as any).workspaceFolders.push({ uri: vscode.Uri.file(source) });
  f.folderEvent(); await opening;
  assert.equal(f.selected(), source);
  assert.deepEqual(f.globalState.get(REPOSITORY_HANDOFF_STATE), []);
  assert.equal(__errorMessages.length, 0);
});

test("failed folder addition preserves the completed repository and a retryable handoff", async t => {
  const f = await fixture(t);
  const source = path.join(f.directory, "outside"); await repository(source);
  f.updateFolders(() => false);
  await vscode.commands.executeCommand("gitSimpleCompare.openRepository", { directory: source, open: "add" });
  assert.equal(f.states.at(-1).phase, "error");
  assert.deepEqual(f.globalState.get(REPOSITORY_HANDOFF_STATE), [source]);
  assert.equal(await readFile(path.join(source, "source.txt"), "utf8"), "source\n");
  assert.equal(__executedCommands.at(-1)?.args[1], false);
});

test("input, sign-in and running Git cancellation restore idle without a successful repository", async t => {
  const service = new RepositorySetupService();
  const f = await fixture(t, false, { service });
  await vscode.commands.executeCommand("gitSimpleCompare.cloneRepository");
  assert.equal(f.states.at(-1).phase, "idle");
  t.mock.method(vscode.authentication, "getSession", async () => { throw new Error("User did not consent to login."); });
  await vscode.commands.executeCommand("gitSimpleCompare.cloneFromGitHub");
  assert.equal(f.states.at(-1).phase, "idle");
  t.mock.method(vscode.window, "withProgress", async (_options: any, task: any) => task({ report() {} }, {
    isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }),
  }));
  t.mock.method(service, "initialize", async (_root, _branch, signal) => {
    assert.equal(signal?.aborted, true); throw new RepositorySetupError("cancelled", "Cancelled");
  });
  await vscode.commands.executeCommand("gitSimpleCompare.initializeRepository");
  assert.equal(f.states.at(-1).phase, "idle");
  assert.equal(f.selected(), undefined);
  assert.equal(__errorMessages.length, 0);
  assert.equal(f.native.enabled, false);
});

test("busy setup ignores duplicate commands and errors release the next attempt", async t => {
  const service = new RepositorySetupService();
  const f = await fixture(t, false, { service });
  let reject!: (error: Error) => void, begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const pending = new Promise<never>((_resolve, reject_) => { reject = reject_; });
  const setup = t.mock.method(service, "initialize", async () => { begin(); return pending; });
  const first = vscode.commands.executeCommand("gitSimpleCompare.initializeRepository");
  await started;
  await vscode.commands.executeCommand("gitSimpleCompare.initializeRepository");
  assert.equal(setup.mock.callCount(), 1);
  reject(new Error("Git unavailable")); await first;
  assert.equal(f.states.at(-1).phase, "error");
  await vscode.commands.executeCommand("gitSimpleCompare.cloneRepository");
  assert.equal(f.states.at(-1).phase, "idle");
  assert.ok(__outputLines.some(line => line.includes("operation-pending")));
  assert.ok(__executedCommands.some(command => command.args[0] === "gitSimpleCompare.onboarding.busy" && command.args[1] === false));
});
