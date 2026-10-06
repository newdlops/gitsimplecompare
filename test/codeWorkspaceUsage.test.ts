import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCodeWorkspaceUsage, emptyCodeWorkspaceUnchanged, emptyWindowEditorPaths, readCodeEditorState, type CodeWorkspaceUsageDeps } from "../src/git/codeWorkspaceUsage";

const FILE = "workbench.editors.files.fileEditorInput", WELCOME = "workbench.editors.gettingStartedInput";
const UNTITLED = "workbench.editors.untitledEditorInput", DIFF = "workbench.editors.diffEditorInput";

/** 기본 편집기의 실제 type ID/value 직렬화를 만들어 경로 보호 동작을 검증한다. */
function editor(id: string, value: unknown = {}) { return { id, value: JSON.stringify(value) }; }
/** 현재 Code가 저장하는 grid 구조에 모든 편집기 그룹을 넣는다. */
function state(...groups: ReturnType<typeof editor>[][]): string {
  return JSON.stringify({ "editorpart.state": { serializedGrid: { root: { type: "branch",
    data: groups.map(editors => ({ type: "leaf", data: { editors } })) } } } });
}
/** 빈 창 식별자·백업 기록·상태 DB만 가짜로 주입하고 제품의 판정은 그대로 실행한다. */
function fixture() {
  const storage = "/code/User/workspaceStorage/1791253333828", file = `${storage}/workspace.json`;
  const text = new Map<string, string>([["/code/User/globalStorage/storage.json",
    JSON.stringify({ backupWorkspaces: { emptyWindows: [{ backupFolder: "1791253333828" }] } })]]);
  let editors: string | undefined = state([editor(WELCOME)]);
  const deps: CodeWorkspaceUsageDeps = {
    readText: async file => { const value = text.get(file); if (value === undefined) throw Object.assign(new Error("fixture missing"), { code: "ENOENT" }); return value; },
    canonical: async file => file,
    readEditorState: async () => editors,
  };
  return { storage, file, text, deps, setEditors: (value: string | undefined) => { editors = value; } };
}

test("a backed empty welcome window does not make other mapped workspaces unavailable", async () => {
  const f = fixture(), normal = "/code/User/workspaceStorage/abc/workspace.json";
  f.text.set(normal, JSON.stringify({ folder: "file:///repos/active" }));
  const result = await readCodeWorkspaceUsage([normal, f.file], f.deps);
  assert.equal(result.complete, true);
  if (!result.complete) return;
  assert.deepEqual(result.roots, ["/repos/active"]);
  assert.equal(result.emptyWorkspaces.length, 1);
  assert.match(result.emptyWorkspaces[0].editorsDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /gettingStartedInput|editorpart.state/);
});

test("numeric storage names alone, missing hashed identities and remote empty windows stay protected", async () => {
  for (const kind of ["unregistered", "hashed", "remote"] as const) {
    const f = fixture();
    if (kind === "unregistered") f.text.set("/code/User/globalStorage/storage.json", "{}");
    if (kind === "remote") f.text.set("/code/User/globalStorage/storage.json", JSON.stringify({ backupWorkspaces: {
      emptyWindows: [{ backupFolder: "1791253333828", remoteAuthority: "ssh-remote+private-host" }] } }));
    const result = await readCodeWorkspaceUsage([kind === "hashed" ? "/code/User/workspaceStorage/abc/workspace.json" : f.file], f.deps);
    assert.equal(result.complete, false, kind);
    assert.doesNotMatch(JSON.stringify(result), /private-host/);
  }
});

test("permissions, corrupt metadata and unsupported editor state are never treated as an empty window", async () => {
  for (const kind of ["permission", "corrupt-identity", "corrupt-backup", "missing-state", "unknown-editor", "unknown-grid", "remote-file"] as const) {
    const f = fixture();
    if (kind === "permission") f.deps.readText = async () => { throw Object.assign(new Error("private file path"), { code: "EACCES" }); };
    if (kind === "corrupt-identity") f.text.set(f.file, "{broken");
    if (kind === "corrupt-backup") f.text.set("/code/User/globalStorage/storage.json", "{broken");
    if (kind === "missing-state") f.setEditors(undefined);
    if (kind === "unknown-editor") f.setEditors(state([editor("extension.customEditor", { repository: "/private/repo" })]));
    if (kind === "unknown-grid") f.setEditors("{}");
    if (kind === "remote-file") f.setEditors(state([editor(FILE, { resourceJSON: { scheme: "file", authority: "server", path: "/repo/file" } })]));
    const result = await readCodeWorkspaceUsage([f.file], f.deps);
    assert.equal(result.complete, false, kind);
    assert.doesNotMatch(JSON.stringify(result), /private file|private\/repo/);
  }
});

test("all groups, inactive tabs and both sides of a diff protect local documents in a folderless window", () => {
  const first = editor(FILE, { resourceJSON: { scheme: "file", path: "/repo/한글 file.txt" } });
  const second = editor(FILE, { resourceJSON: { scheme: "file", path: "/other/file.txt" } });
  const diff = editor(DIFF, { primaryTypeId: second.id, primarySerialized: second.value,
    secondaryTypeId: first.id, secondarySerialized: first.value });
  assert.deepEqual(emptyWindowEditorPaths(state([editor(WELCOME), first], [diff])), ["/repo/한글 file.txt", "/other/file.txt"]);
});

test("unassociated untitled buffers need no repository while associated new files protect their real parent", async () => {
  const f = fixture();
  f.setEditors(state([editor(UNTITLED, { resourceJSON: { scheme: "untitled", path: "Untitled-1" } }),
    editor(UNTITLED, { resourceJSON: { scheme: "file", path: "/alias/repo/new.txt" } })]));
  f.deps.canonical = async file => {
    if (file.endsWith("new.txt")) throw Object.assign(new Error("not yet saved"), { code: "ENOENT" });
    return file.replace("/alias", "/real");
  };
  const result = await readCodeWorkspaceUsage([f.file], f.deps);
  assert.equal(result.complete, true);
  if (result.complete) assert.deepEqual(result.roots, ["/real/repo/new.txt"]);
});

test("workspace and editor changes or lost evidence invalidate a selected empty window proof", async () => {
  for (const kind of ["editor", "workspace", "backup", "database"] as const) {
    const f = fixture(), result = await readCodeWorkspaceUsage([f.file], f.deps);
    assert.equal(result.complete, true);
    if (!result.complete) continue;
    assert.equal(await emptyCodeWorkspaceUnchanged(result.emptyWorkspaces[0], f.deps), true);
    if (kind === "editor") f.setEditors(state([editor(FILE, { resourceJSON: { scheme: "file", path: "/repo/file.txt" } })]));
    if (kind === "workspace") f.text.set(f.file, JSON.stringify({ folder: "file:///repo" }));
    if (kind === "backup") f.text.set("/code/User/globalStorage/storage.json", "{}");
    if (kind === "database") f.deps.readEditorState = async () => { throw Object.assign(new Error("busy"), { code: "ETIMEDOUT" }); };
    assert.equal(await emptyCodeWorkspaceUnchanged(result.emptyWorkspaces[0], f.deps), false, kind);
  }
});

test("deep or malformed editor serialization fails without hiding nested repository use", () => {
  let grid: unknown = { type: "leaf", data: { editors: [editor(WELCOME)] } };
  for (let i = 0; i < 34; i++) grid = { type: "branch", data: [grid] };
  assert.throws(() => emptyWindowEditorPaths(JSON.stringify({ "editorpart.state": { serializedGrid: { root: grid } } })));
  assert.throws(() => emptyWindowEditorPaths(state([{ id: FILE, value: "{broken" }])));
  assert.throws(() => emptyWindowEditorPaths(state([editor(DIFF, { primaryTypeId: FILE, primarySerialized: "{}" })])));
});

test("the real SQLite reader preserves the DB and does not create missing or corrupt databases", { skip: process.platform !== "darwin" }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-code-editor-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "한글's state.vscdb"), missing = path.join(directory, "missing.vscdb");
  const editors = state([editor(FILE, { resourceJSON: { scheme: "file", path: "/repo/quote's file" } })]);
  await promisify(execFile)("/usr/bin/sqlite3", ["-init", "/dev/null", database,
    `CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB); INSERT INTO ItemTable VALUES ('memento/workbench.parts.editor', '${editors.replaceAll("'", "''")}');`]);
  const before = await readFile(database);
  assert.equal(await readCodeEditorState(database), editors);
  assert.deepEqual(await readFile(database), before);
  await assert.rejects(readCodeEditorState(missing));
  await assert.rejects(stat(missing), { code: "ENOENT" });
  const broken = path.join(directory, "broken.vscdb");
  await writeFile(broken, "corrupt database");
  await assert.rejects(readCodeEditorState(broken));
  assert.equal(await readFile(broken, "utf8"), "corrupt database");
});
