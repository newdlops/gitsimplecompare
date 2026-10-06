import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

/** 빈 창 재검증에 편집기 본문 대신 경로와 상태 해시만 보관한다. */
export interface EmptyCodeWorkspace { storage: string; editorsDigest: string }
/** OS 파일 조회만 주입하여 창 판정과 열린 문서 보호를 독립적으로 검증한다. */
export interface CodeWorkspaceUsageDeps {
  readText(file: string): Promise<string>;
  canonical(file: string): Promise<string>;
  readEditorState(database: string): Promise<string | undefined>;
}
export type CodeWorkspaceUsage =
  | { complete: true; roots: string[]; emptyWorkspaces: EmptyCodeWorkspace[] }
  | { complete: false; reason: string; diagnostic: { stage: string; code: string } };
interface SerializedEditor { id: string; value: string }
const EDITOR_STATE_KEY = "memento/workbench.parts.editor";
const WELCOME_EDITOR = "workbench.editors.gettingStartedInput";
const FILE_EDITOR = "workbench.editors.files.fileEditorInput";
const UNTITLED_EDITOR = "workbench.editors.untitledEditorInput";
const COMPOSITE_EDITORS = new Set(["workbench.editors.diffEditorInput", "workbench.editorinputs.sidebysideEditorInput"]);

/**
 * 열린 상태 DB마다 일반 workspace 또는 입증된 빈 창의 사용 경로를 읽는다.
 * - workspace.json 부재만으로 추측하지 않고 Code의 backupWorkspaces 기록도 확인한다.
 * @param files 현재 Code 프로세스가 실제로 열고 있는 workspace.json 경로
 * @param deps 읽기·실제 경로·읽기 전용 편집기 DB 조회 경계
 * @returns 보호 경로와 빈 창 재검증 증거. 하나라도 불명확하면 전체 관찰을 보류한다.
 */
export async function readCodeWorkspaceUsage(files: readonly string[], deps: CodeWorkspaceUsageDeps): Promise<CodeWorkspaceUsage> {
  const roots: string[] = [], emptyWorkspaces: EmptyCodeWorkspace[] = [];
  for (const file of files) {
    let source: string;
    try { source = await deps.readText(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return unavailable("unreadable-code-workspace", error);
      try {
        const empty = await readEmptyWorkspace(path.dirname(file), deps);
        roots.push(...empty.paths); emptyWorkspaces.push(empty.proof);
        continue;
      } catch (cause) { return unavailable("unverified-empty-code-workspace", cause); }
    }
    try {
      const workspace = JSON.parse(source) as { folder?: string; workspace?: string };
      if (workspace.folder?.startsWith("file:")) roots.push(await deps.canonical(localFileUriPath(workspace.folder)));
      else if (workspace.workspace?.startsWith("file:")) {
        const configFile = localFileUriPath(workspace.workspace);
        const config = JSON.parse(await deps.readText(configFile)) as { folders?: { path?: string; uri?: string }[] };
        if (!Array.isArray(config.folders)) return unavailable("unmapped-code-workspace");
        for (const folder of config.folders) {
          if (folder.path) roots.push(await deps.canonical(path.resolve(path.dirname(configFile), folder.path)));
          else if (folder.uri?.startsWith("file:")) roots.push(await deps.canonical(localFileUriPath(folder.uri)));
          else return unavailable("unmapped-code-workspace");
        }
      } else return unavailable("unmapped-code-workspace");
    } catch (error) { return unavailable("unreadable-code-workspace", error); }
  }
  return { complete: true, roots: [...new Set(roots)], emptyWorkspaces };
}

/**
 * 종료 직전에 빈 창의 타입과 편집기 상태가 바뀌지 않았는지 다시 확인한다.
 * @param proof 실제 OS 관찰에서 얻은 저장 공간 경로와 편집기 해시
 * @param deps 새 메타데이터/편집기 조회 경계
 * @returns 폴더 열기·문서 변경·읽기 실패가 없을 때만 true
 */
export async function emptyCodeWorkspaceUnchanged(proof: EmptyCodeWorkspace, deps: CodeWorkspaceUsageDeps): Promise<boolean> {
  try {
    if (!await workspaceMetadataMissing(proof.storage, deps)) return false;
    if ((await readEmptyWorkspace(proof.storage, deps)).proof.editorsDigest !== proof.editorsDigest) return false;
    // SQLite 조회를 기다리는 중 폴더가 열린 경우도 이전 welcome 상태로 종료를 허용하지 않는다.
    return await workspaceMetadataMissing(proof.storage, deps);
  } catch { return false; }
}

/**
 * 폴더 메타데이터의 실제 부재만 확인하며 권한 오류를 빈 창으로 취급하지 않는다.
 * @param storage 재검증할 빈 창 저장 공간, deps 파일 읽기 경계
 * @returns workspace.json 읽기가 ENOENT로 실패할 때만 true
 */
async function workspaceMetadataMissing(storage: string, deps: CodeWorkspaceUsageDeps): Promise<boolean> {
  try { await deps.readText(path.join(storage, "workspace.json")); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

/**
 * macOS의 기본 SQLite CLI로 편집기 상태만 읽고 사용자 초기화 스크립트는 실행하지 않는다.
 * @param database Code가 열고 있는 DB. SQL/셸 문자열에 경로를 보간하지 않는다.
 * @returns 편집기 JSON 또는 아직 없는 상태. 권한·잠금·손상·출력 초과는 실패로 보존한다.
 */
export function readCodeEditorState(database: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => execFile("/usr/bin/sqlite3", ["-readonly", "-batch", "-noheader", "-init", "/dev/null",
    "-cmd", ".timeout 1000", database, `SELECT value FROM ItemTable WHERE key = '${EDITOR_STATE_KEY}';`],
  { encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024 }, (error, output, stderr) => {
    if (error || stderr.trim()) reject(error ?? Object.assign(new Error("Editor state inspection failed."), { code: "SQLITE_INSPECTION_ERROR" }));
    else resolve(output.trim() || undefined);
  }));
}

/**
 * 빈 창의 백업 식별자와 편집기 그룹을 함께 검증해 열린 로컬 파일도 보호한다.
 * @param storage 현재 열린 상태 DB의 상위 디렉터리
 * @param deps Code 메타데이터와 편집기 상태를 읽는 경계
 * @returns 로컬 문서 경로와 재검증 증거. 알려지지 않은 창/편집기 형식은 실패한다.
 */
async function readEmptyWorkspace(storage: string, deps: CodeWorkspaceUsageDeps): Promise<{ paths: string[]; proof: EmptyCodeWorkspace }> {
  const id = path.basename(storage), home = path.dirname(storage);
  // Code는 Date.now()+난수로 빈 창 ID를 만들고 폴더 ID는 hash다. 이름만으로는 입증하지 않는다.
  if (!/^[1-9]\d{12,15}$/.test(id) || path.basename(home) !== "workspaceStorage") throw inspectionError("UNVERIFIED_EMPTY_WINDOW");
  const metadata = JSON.parse(await deps.readText(path.join(path.dirname(home), "globalStorage", "storage.json"))) as {
    backupWorkspaces?: { emptyWindows?: { backupFolder?: string; remoteAuthority?: string }[] };
  };
  if (!Array.isArray(metadata.backupWorkspaces?.emptyWindows)
    || !metadata.backupWorkspaces.emptyWindows.some(window => window.backupFolder === id && !window.remoteAuthority)) {
    throw inspectionError("UNVERIFIED_EMPTY_WINDOW");
  }
  const editors = await deps.readEditorState(path.join(storage, "state.vscdb"));
  if (!editors) throw inspectionError("EDITOR_STATE_UNAVAILABLE");
  const resources = emptyWindowEditorPaths(editors);
  const paths = await Promise.all(resources.map(async resource => {
    try { return await deps.canonical(resource); }
    catch (error) {
      // 새 파일/연결된 untitled 문서는 없을 수 있으므로 실제 상위 디렉터리까지만 검증한다.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return path.join(await deps.canonical(path.dirname(resource)), path.basename(resource));
    }
  }));
  return { paths, proof: { storage, editorsDigest: createHash("sha256").update(editors).digest("hex") } };
}

/**
 * 저장된 grid의 모든 그룹·미리보기·비활성 탭에서 로컬 문서를 찾는다.
 * @param source memento/workbench.parts.editor 값. 편집기 텍스트 본문은 조회하지 않는다.
 * @returns 보호할 절대 경로. 미지원 구조/직렬화는 빈 목록으로 숨기지 않는다.
 */
export function emptyWindowEditorPaths(source: string): string[] {
  const data = JSON.parse(source) as { "editorpart.state"?: { serializedGrid?: { root?: unknown } } };
  const root = data?.["editorpart.state"]?.serializedGrid?.root;
  if (!root) throw inspectionError("UNSUPPORTED_EDITOR_STATE");
  const paths: string[] = [];
  /** 분할 그룹을 제한된 깊이로 방문하고 모든 leaf의 편집기 직렬화를 확인한다. */
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 32) throw inspectionError("UNSUPPORTED_EDITOR_STATE");
    const grid = node as { type?: string; data?: unknown };
    if (grid.type === "branch" && Array.isArray(grid.data) && grid.data.length) for (const child of grid.data) visit(child, depth + 1);
    else if (grid.type === "leaf" && grid.data && typeof grid.data === "object") {
      const editors = (grid.data as { editors?: unknown }).editors;
      if (!Array.isArray(editors)) throw inspectionError("UNSUPPORTED_EDITOR_STATE");
      for (const editor of editors) paths.push(...serializedEditorPaths(editor, 0));
    } else throw inspectionError("UNSUPPORTED_EDITOR_STATE");
  };
  visit(root, 0);
  return [...new Set(paths)];
}

/**
 * 기본 파일·untitled·diff·side-by-side 편집기의 직렬화 계약만 해석한다.
 * @param input 그룹의 type ID/value 쌍, depth 복합 편집기 재귀 깊이
 * @returns 양쪽 diff와 숨은 탭의 로컬 경로. 미지원 타입은 보호를 위해 실패한다.
 */
function serializedEditorPaths(input: unknown, depth: number): string[] {
  if (!input || typeof input !== "object" || depth > 16) throw inspectionError("UNSUPPORTED_EDITOR_STATE");
  const editor = input as SerializedEditor;
  if (typeof editor.id !== "string" || typeof editor.value !== "string") throw inspectionError("UNSUPPORTED_EDITOR_STATE");
  const value = JSON.parse(editor.value) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw inspectionError("UNSUPPORTED_EDITOR_STATE");
  if (editor.id === WELCOME_EDITOR) return [];
  if (COMPOSITE_EDITORS.has(editor.id)) return [
    ...serializedEditorPaths({ id: value.primaryTypeId, value: value.primarySerialized }, depth + 1),
    ...serializedEditorPaths({ id: value.secondaryTypeId, value: value.secondarySerialized }, depth + 1),
  ];
  if (editor.id !== FILE_EDITOR && editor.id !== UNTITLED_EDITOR) throw inspectionError("UNSUPPORTED_EDITOR_TYPE");
  const resource = value.resourceJSON as { scheme?: string; authority?: string; path?: string } | undefined;
  if (!resource || typeof resource.path !== "string") throw inspectionError("UNSUPPORTED_EDITOR_STATE");
  if (resource.scheme === "untitled" && editor.id === UNTITLED_EDITOR && !resource.authority) {
    return path.isAbsolute(resource.path) ? [resource.path] : [];
  }
  if (resource.scheme !== "file" || (resource.authority && resource.authority !== "localhost") || !path.isAbsolute(resource.path)) {
    throw inspectionError("NON_LOCAL_EDITOR_RESOURCE");
  }
  return [resource.path];
}

/** 로컬 file URI만 해석하며 원격 authority와 상대 경로는 보호 증거로 쓰지 않는다. */
function localFileUriPath(uri: string): string {
  const value = new URL(uri);
  if (value.protocol !== "file:" || (value.host && value.host !== "localhost")) throw inspectionError("NON_LOCAL_WORKSPACE");
  const file = decodeURIComponent(value.pathname);
  if (!path.isAbsolute(file)) throw inspectionError("NON_LOCAL_WORKSPACE");
  return file;
}

/** argv/DB 본문 대신 안정된 실패 코드만 외부 진단으로 전달한다. */
function inspectionError(code: string): Error & { code: string } { return Object.assign(new Error("Code workspace use could not be verified."), { code }); }

/** 파일 오류·손상 JSON·미지원 형식의 경계를 경로/본문 없이 보존한다. */
function unavailable(reason: string, error?: unknown): Extract<CodeWorkspaceUsage, { complete: false }> {
  const code = (error as NodeJS.ErrnoException)?.code;
  return { complete: false, reason, diagnostic: { stage: "code-workspace-identities",
    code: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : error instanceof SyntaxError ? "INVALID_JSON" : "INSPECTION_ERROR" } };
}
