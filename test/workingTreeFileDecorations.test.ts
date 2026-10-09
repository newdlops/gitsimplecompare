import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type * as vscode from "vscode";
import { Uri, window, workspace, extensions } from "./helpers/vscodeMock";
import { WorkingTreeFileDecorationProvider, workingTreeFileDecorations } from "../src/providers/workingTreeFileDecorations";
import { GitServiceRegistry } from "../src/git/serviceRegistry";
import { parsePorcelainEntries, parsePorcelainGroups } from "../src/git/diffParse";
import { runGit } from "../src/git/gitExec";
import { readWorkingTreeSnapshot, disposeWorkingTreeSnapshots, onWorkingTreeSnapshotInvalidated, invalidateWorkingTreeSnapshot } from "../src/git/workingTreeSnapshot";
import type { WorkingTreeSnapshot } from "../src/git/workingTreeStatusFormat";

const token = { isCancellationRequested: false } as vscode.CancellationToken;

/** 함수형 이벤트를 만들어 실제 콜백 등록/해제와 알림 순서만 재현한다. */
function signal<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    event: (callback: (value: T) => void) => { listeners.add(callback); return { dispose: () => { listeners.delete(callback); } }; },
    fire: (value: T) => { for (const listener of listeners) listener(value); },
  };
}

/** 즉시 예약된 탐색/조회 Promise가 끝날 때까지 이벤트 루프를 한 번 넘긴다. */
async function settle(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }

/** 원래 XY를 가진 공유 상태 형식의 snapshot을 만들고 캐시 구조를 구현에 맞춰 흉내 내지 않는다. */
function snapshot(root: string, porcelain: string): WorkingTreeSnapshot {
  return { repoRoot: root, branch: "main", porcelain, groups: parsePorcelainGroups(porcelain), hasChanges: porcelain.length > 0 };
}

/**
 * Git 조회 결과와 VS Code 이벤트 경계만 대체하며 실제 provider의 설정·debounce·URI 투영을 실행한다.
 * @param t timer·설정·구독 복원을 관리할 테스트 컨텍스트
 * @param roots multi-root workspace 경로
 * @returns 화면 질의, 상태 전환 및 실제 등록 watcher 이벤트를 조작할 fixture
 */
function fixture(t: TestContext, roots = ["/repo"]) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_700_000_000_000 });
  const enabled = new Map(roots.map(root => [root, false]));
  let outsideEnabled = true;
  const resolverRoots = [...roots];
  const resolutions: string[] = [];
  let decorationsEnabled = true;
  let automaticRefresh = true;
  const saved = signal<{ uri: ReturnType<typeof Uri.file> }>();
  const created = signal<{ files: ReturnType<typeof Uri.file>[] }>();
  const deleted = signal<{ files: ReturnType<typeof Uri.file>[] }>();
  const renamed = signal<{ files: { oldUri: ReturnType<typeof Uri.file>; newUri: ReturnType<typeof Uri.file> }[] }>();
  const configured = signal<{ affectsConfiguration: (key: string) => boolean }>();
  const focused = signal<{ focused: boolean }>();
  const changed = signal<string>();
  const watchers: Array<{ change: ReturnType<typeof signal<ReturnType<typeof Uri.file>>>; disposed: boolean }> = [];
  const values = new Map(roots.map(root => [root, " M nested/changed.txt\0?? new.txt\0"]));
  const reads: Array<{ root: string; signal?: AbortSignal }> = [];
  const notifications: Array<vscode.Uri[] | undefined> = [];
  let loader = async (root: string): Promise<WorkingTreeSnapshot> => snapshot(root, values.get(root) ?? "");
  const originalState = window.state;
  window.state = { focused: true };
  t.after(() => { window.state = originalState; });
  const extra = {
    workspaceFolders: roots.map((root, index) => ({ uri: Uri.file(root), name: path.basename(root), index })),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidCreateFiles: created.event,
    onDidDeleteFiles: deleted.event,
    onDidRenameFiles: renamed.event,
    createFileSystemWatcher: () => {
      const watcher = { change: signal<ReturnType<typeof Uri.file>>(), disposed: false };
      watchers.push(watcher);
      return { onDidChange: watcher.change.event, onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose: () => { watcher.disposed = true; } };
    },
  };
  const original = Object.fromEntries(Object.keys(extra).map(key => [key, Object.getOwnPropertyDescriptor(workspace, key)]));
  Object.assign(workspace, extra);
  t.after(() => {
    for (const key of Object.keys(extra)) {
      if (original[key]) Object.defineProperty(workspace, key, original[key]!);
      else delete (workspace as any)[key];
    }
  });
  t.mock.method(workspace, "getConfiguration", (_section: string, uri?: { fsPath: string }) => ({
    get: (key: string, fallback: unknown) => key === "enabled"
      ? enabled.get(roots.find(root => uri?.fsPath === root || uri?.fsPath.startsWith(root + path.sep)) ?? "") ?? outsideEnabled
      : key === "decorations.enabled" ? decorationsEnabled : key === "autorefresh" ? automaticRefresh : fallback,
  }));
  t.mock.method(workspace, "onDidChangeConfiguration", configured.event);
  t.mock.method(workspace, "onDidSaveTextDocument", saved.event);
  t.mock.method(window, "onDidChangeWindowState", focused.event);
  t.mock.method(Uri, "parse", value => Uri.file(value));
  t.mock.method(extensions, "getExtension", () => { throw new Error("Fallback must never read or activate native Git."); });
  const registry = { resolve: async (directory: string) => {
    resolutions.push(directory);
    const root = [...resolverRoots].sort((a, b) => b.length - a.length).find(root => directory === root || directory.startsWith(root + path.sep));
    return root ? { repoRoot: root } : undefined;
  } } as GitServiceRegistry;
  const provider = new WorkingTreeFileDecorationProvider(registry, {
    version: 1, onDidChange: changed.event,
    getStatus: async (root, options) => { reads.push({ root, signal: options?.signal }); return loader(root); },
  });
  t.mock.method((provider as any).changed, "fire", (uris: vscode.Uri[] | undefined) => { notifications.push(uris); });
  t.after(onWorkingTreeSnapshotInvalidated(root => changed.fire(root)));
  t.after(() => provider.dispose());
  return {
    provider, reads, notifications, watchers, values, saved, created, deleted, renamed, resolutions,
    outsideRoot: (root: string, porcelain: string) => { outsideEnabled = false; resolverRoots.push(root); values.set(root, porcelain); },
    read: (file = "nested/changed.txt", root = roots[0]) => provider.provideFileDecoration(Uri.file(path.join(root, file)) as vscode.Uri, token),
    configure: (value: boolean, root = roots[0]) => { enabled.set(root, value); configured.fire({ affectsConfiguration: key => key === "git.enabled" }); },
    automaticRefresh: (value: boolean) => { automaticRefresh = value; configured.fire({ affectsConfiguration: key => key === "git.autorefresh" }); },
    decorations: (value: boolean) => { decorationsEnabled = value; configured.fire({ affectsConfiguration: key => key === "git.decorations.enabled" }); },
    focus: (value: boolean) => { window.state = { focused: value }; focused.fire(window.state); },
    load: (next: typeof loader) => { loader = next; },
  };
}

/** 임시 Git fixture만 변경하고 공유 status 조회가 실제 인덱스를 바꾸지 않는지 확인한다. */
test("real shared Git status decorates saved/staged/renamed/untracked files without changing the real index", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-file-decorations-"));
  t.after(async () => { await disposeWorkingTreeSnapshots(); await rm(root, { recursive: true, force: true }); });
  await runGit(["-c", "init.templateDir=", "init", "-q"], root);
  await runGit(["config", "user.name", "Decoration Fixture"], root);
  await runGit(["config", "user.email", "decoration@example.invalid"], root);
  await runGit(["config", "core.fsmonitor", "false"], root);
  await runGit(["config", "commit.gpgSign", "false"], root);
  await mkdir(path.join(root, "empty-hooks"));
  await runGit(["config", "core.hooksPath", path.join(root, "empty-hooks")], root);
  await mkdir(path.join(root, "nested"));
  for (const name of ["modified.txt", "staged.txt", "old name.txt", "deleted.txt"]) await writeFile(path.join(root, "nested", name), "base\n");
  await runGit(["add", "."], root); await runGit(["commit", "-qm", "base"], root);
  await writeFile(path.join(root, "nested/staged.txt"), "staged\n");
  await rename(path.join(root, "nested/old name.txt"), path.join(root, "nested/renamed.txt"));
  await runGit(["add", "-A"], root);
  await writeFile(path.join(root, "nested/modified.txt"), "modified\n");
  await rm(path.join(root, "nested/deleted.txt"));
  await writeFile(path.join(root, "nested/new\nname.txt"), "new\n");
  const before = await readFile(path.join(root, ".git/index"));
  const shared = await readWorkingTreeSnapshot(root);
  const decorations = workingTreeFileDecorations(root, shared.porcelain);
  const at = (name: string) => decorations.get(Uri.file(path.join(root, "nested", name)).toString());
  assert.equal(at("modified.txt")?.badge, "M");
  assert.equal(at("staged.txt")?.tooltip, "Index Modified");
  assert.equal(at("new\nname.txt")?.badge, "U");
  assert.equal(at("new\nname.txt")?.color?.id, "gitDecoration.untrackedResourceForeground");
  assert.equal(at("renamed.txt")?.badge, "R");
  assert.equal(at("old name.txt")?.badge, "R");
  assert.equal(at("deleted.txt")?.badge, "D");
  assert.equal(at("deleted.txt")?.propagate, false);
  assert.deepEqual(await readFile(path.join(root, ".git/index")), before);
});

test("paused native automatic refresh does not duplicate native badges; disabling Git transfers decoration ownership", async t => {
  const f = fixture(t);
  f.configure(true);
  await settle();
  assert.equal(await f.read(), undefined);
  f.automaticRefresh(false);
  await settle();
  assert.equal(await f.read(), undefined);
  f.configure(false);
  await settle();
  assert.equal((await f.read())?.badge, "M");
  f.values.set("/repo", "?? nested/changed.txt\0");
  f.saved.fire({ uri: Uri.file("/repo/nested/changed.txt") });
  t.mock.timers.tick(180);
  await settle();
  assert.equal((await f.read())?.badge, "U");
  f.configure(true);
  await settle();
  assert.equal(await f.read(), undefined);
});

test("XY precedence distinguishes untracked, staged, working, intent-to-add and all merge conflicts", () => {
  const raw = "?? new file.txt\0M  staged.txt\0AM mixed.txt\0 A intent.txt\0R  renamed.txt\0old\nname.txt\0C  copied.txt\0source.txt\0 D gone.txt\0!! ignored.txt\0?? ../outside.txt\0";
  const conflicts = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];
  const index = workingTreeFileDecorations("/repo", raw + conflicts.map(xy => `${xy} conflict-${xy}.txt\0`).join(""));
  const at = (name: string) => index.get(Uri.file("/repo/" + name).toString());
  assert.equal(at("new file.txt")?.badge, "U");
  assert.equal(at("staged.txt")?.color?.id, "gitDecoration.stageModifiedResourceForeground");
  assert.equal(at("mixed.txt")?.tooltip, "Modified");
  assert.equal(at("intent.txt")?.badge, "A");
  assert.equal(at("old\nname.txt")?.badge, "R");
  assert.equal(at("source.txt"), undefined, "a clean copy source must not become modified");
  assert.equal(at("ignored.txt"), undefined);
  assert.equal(index.get(Uri.file("/outside.txt").toString()), undefined);
  for (const xy of conflicts) assert.equal(at(`conflict-${xy}.txt`)?.badge, "!");
  assert.deepEqual(parsePorcelainEntries("R  renamed.txt\0old\nname.txt\0?? leading.txt\0"), [
    { xy: "R ", path: "renamed.txt", oldPath: "old\nname.txt" }, { xy: "??", path: "leading.txt" },
  ]);
});

test("fallback starts while Changes is hidden and hundreds of Explorer queries share one snapshot", async t => {
  const f = fixture(t); await settle();
  const decorations = await Promise.all(Array.from({ length: 100 }, () => f.read()));
  assert.ok(decorations.every(decoration => decoration?.badge === "M"));
  assert.equal(f.reads.length, 1);
  assert.equal((await f.read("new.txt"))?.badge, "U");
  const affected = f.notifications.flatMap(uris => uris?.map(uri => uri.fsPath) ?? []);
  assert.ok(affected.includes("/repo/nested"));
  assert.ok(affected.includes("/repo"));
});

test("native Git and decorations settings transfer ownership without activating Git or retaining fallback badges", async t => {
  const f = fixture(t); await settle();
  assert.equal((await f.read())?.badge, "M");
  f.configure(true); await settle();
  assert.equal(await f.read(), undefined);
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].signal?.aborted, true);
  assert.ok(f.watchers.every(watcher => watcher.disposed));
  f.configure(false); await settle();
  assert.equal((await f.read())?.badge, "M");
  f.decorations(false); await settle();
  assert.equal(await f.read(), undefined);
  assert.equal(f.reads.length, 2);
  f.decorations(true); await settle();
  assert.equal((await f.read())?.badge, "M");
});

test("save/external/create/delete/rename bursts refresh once and committing clears file and ancestor decorations", async t => {
  const f = fixture(t); await settle();
  f.values.set("/repo", "A  saved.txt\0");
  f.saved.fire({ uri: Uri.file("/repo/saved.txt") });
  f.watchers[0].change.fire(Uri.file("/repo/nested/changed.txt"));
  f.created.fire({ files: [Uri.file("/repo/new.txt")] });
  f.deleted.fire({ files: [Uri.file("/repo/removed.txt")] });
  f.renamed.fire({ files: [{ oldUri: Uri.file("/repo/old.txt"), newUri: Uri.file("/repo/saved.txt") }] });
  t.mock.timers.tick(179); await settle(); assert.equal(f.reads.length, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(f.reads.length, 2);
  assert.equal((await f.read("saved.txt"))?.badge, "A");
  assert.equal(await f.read(), undefined);
  f.values.set("/repo", ""); invalidateWorkingTreeSnapshot("/repo");
  t.mock.timers.tick(180); await settle();
  assert.equal(await f.read("saved.txt"), undefined);
  assert.ok(f.notifications.at(-1)?.some(uri => uri.fsPath === "/repo"), "last changed folder needs a removal notification");
  const reads = f.reads.length; t.mock.timers.tick(60_000); await settle();
  assert.equal(f.reads.length, reads, "idle Explorer must not poll Git");
});

test("multi-root fallback respects folder overrides and unrelated prefix paths", async t => {
  const f = fixture(t, ["/repo", "/other"]); f.configure(true, "/other"); await settle();
  assert.equal((await f.read())?.badge, "M");
  assert.equal(await f.read("nested/changed.txt", "/other"), undefined);
  assert.ok(f.reads.every(read => read.root === "/repo"));
  assert.equal(await f.provider.provideFileDecoration(Uri.file("/repo-other/nested/changed.txt") as vscode.Uri, token), undefined);
});

test("global native Git disablement does not scan Projects catalog repositories outside the open workspace", async t => {
  const f = fixture(t); f.outsideRoot("/catalog/project", " M changed.txt\0"); await settle();
  const resolutions = f.resolutions.length;
  assert.equal(await f.provider.provideFileDecoration(Uri.file("/catalog/project/changed.txt") as vscode.Uri, token), undefined);
  assert.equal(await f.provider.provideFileDecoration(Uri.file("/catalog/project") as vscode.Uri, token), undefined);
  assert.equal(f.resolutions.length, resolutions, "outside resources must not even start repository discovery");
  assert.deepEqual(f.reads.map(read => read.root), ["/repo"]);
  assert.equal((await f.read())?.badge, "M");
});

test("unfocused windows release worktree watchers and reconcile external edits once on return", async t => {
  const f = fixture(t); await settle();
  f.focus(false); assert.ok(f.watchers.every(watcher => watcher.disposed));
  f.values.set("/repo", "?? returned.txt\0"); invalidateWorkingTreeSnapshot("/repo");
  t.mock.timers.tick(60_000); await settle(); assert.equal(f.reads.length, 1);
  f.focus(true); await settle(); t.mock.timers.tick(180); await settle();
  assert.equal((await f.read("returned.txt"))?.badge, "U");
  assert.equal(await f.read(), undefined);
  assert.equal(f.reads.length, 2);
});

test("a delayed status cannot resurrect decorations after native Git is enabled or the provider is disposed", async t => {
  const f = fixture(t);
  let release!: (value: WorkingTreeSnapshot) => void;
  f.load(() => new Promise(resolve => { release = resolve; }));
  await settle();
  const waiting = f.read(); await settle();
  f.configure(true);
  assert.equal(f.reads[0].signal?.aborted, true);
  release(snapshot("/repo", " M nested/changed.txt\0"));
  assert.equal(await waiting, undefined);
  f.load(async root => snapshot(root, ""));
  f.configure(false); await settle();
  assert.equal(await f.read(), undefined);
  f.provider.dispose();
  assert.ok(f.reads.every(read => read.signal?.aborted));
  const reads = f.reads.length; invalidateWorkingTreeSnapshot("/repo"); t.mock.timers.tick(60_000); await settle();
  assert.equal(f.reads.length, reads);
});
