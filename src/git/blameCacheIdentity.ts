import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveGitExecutable } from "./gitExec";

/**
 * Git 실행 없이 저장된 파일·현재 worktree HEAD/index·공통 refs의 버전을 식별한다.
 * @param root GitBlameService가 실제 실행할 저장소 루트
 * @param file blame 대상 절대 경로
 * @returns 같은 결과를 재사용할 hash. 별도 환경 경계나 읽기 실패 시 undefined로 캐시를 생략한다.
 */
export async function readBlameCacheIdentity(root: string, file: string): Promise<string | undefined> {
  if (["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"].some(name => process.env[name])) return undefined;
  try {
    let gitDir = path.join(root, ".git");
    const marker = await stat(gitDir);
    if (!marker.isDirectory()) {
      const target = /^gitdir:\s*(.+)\s*$/i.exec((await readFile(gitDir, "utf8")).trim())?.[1];
      if (!target) return undefined;
      gitDir = path.resolve(root, target);
    }
    const commonMarker = await optionalText(path.join(gitDir, "commondir"));
    const common = commonMarker ? path.resolve(gitDir, commonMarker.trim()) : gitDir;
    const environment = Object.keys(process.env).filter(name => /^(?:GIT_CONFIG_|GIT_NO_REPLACE_OBJECTS|GIT_SHALLOW_FILE|GIT_GRAFT_FILE|GIT_REPLACE_REF_BASE)/.test(name))
      .sort().map(name => [name, process.env[name]]);
    const files = [file, path.join(gitDir, "HEAD"), process.env.GIT_INDEX_FILE ? path.resolve(root, process.env.GIT_INDEX_FILE) : path.join(gitDir, "index"),
      path.join(common, "packed-refs"), path.join(common, "shallow"), path.join(common, "info", "grafts"),
      path.join(common, "refs", "replace"), path.join(common, "config"), path.join(gitDir, "config.worktree"), path.join(root, ".mailmap"),
      process.env.GIT_CONFIG_GLOBAL ?? path.join(os.homedir(), ".gitconfig"),
      path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "git", "config"),
      process.env.GIT_CONFIG_SYSTEM ?? "/etc/gitconfig"];
    // 공통 디렉터리 확정 뒤 독립적인 refs/HEAD/파일 metadata를 한 번에 읽어 I/O 대기를 겹친다.
    const [tables, head, versions] = await Promise.all([
      Promise.all([...new Set([common, gitDir])].map(dir => fileVersion(path.join(dir, "reftable")))),
      readHeadIdentity(gitDir, common), Promise.all(files.map(fileVersion)),
    ]);
    if (tables.some(value => value !== "missing") || head === undefined || versions[0] === "missing") return undefined;
    return createHash("sha256").update(JSON.stringify([root, file, gitDir, common, head, resolveGitExecutable(root), environment, versions])).digest("hex");
  } catch { return undefined; }
}

/**
 * 기존 루트 아래 새 중첩 저장소가 생겼는지 확인해 준비된 blame의 저장소 경계를 보호한다.
 * @param root 기존 Git 탐색으로 확정한 루트, file 같은 루트에서 읽었던 파일
 * @returns 자식 경로의 Git marker가 없으면 true, 경계 변경·확인 실패는 false
 */
export async function isBlameRepositoryScopeCurrent(root: string, file: string): Promise<boolean> {
  const relative = path.relative(root, file);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
  const directories: string[] = [];
  for (let dir = path.dirname(file); dir !== root; dir = path.dirname(dir)) {
    if (path.dirname(dir) === dir) return false;
    directories.push(dir);
  }
  try {
    const markers = await Promise.all(directories.flatMap(dir => [".git", "HEAD"].map(name => fileVersion(path.join(dir, name)))));
    return markers.every(value => value === "missing");
  } catch { return false; }
}

/** HEAD의 symbolic chain을 작은 파일만 읽어 따라가며 packed/unborn ref는 공통 파일 버전으로 구분한다. */
async function readHeadIdentity(gitDir: string, common: string): Promise<string[] | undefined> {
  let current = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
  const result: string[] = [];
  for (let depth = 0; depth < 8; depth++) {
    result.push(current);
    if (/^[0-9a-f]{40,64}$/i.test(current)) return result;
    const ref = /^ref:\s*(refs\/[^\s\0]+)$/.exec(current)?.[1];
    if (!ref || ref.split("/").some(part => part === ".." || part === "." || !part)) return undefined;
    const directory = /^refs\/(?:bisect|worktree|rewritten)\//.test(ref) ? gitDir : common;
    const text = await optionalText(path.join(directory, ref));
    if (text === undefined) { result.push("packed-or-unborn"); return result; }
    current = text.trim();
  }
  return undefined;
}

/** 존재하지 않는 optional metadata만 누락으로 허용하고 권한·I/O 실패는 상위 캐시 생략으로 전달한다. */
async function optionalText(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** inode/나노초 시각도 포함해 동일 크기 덮어쓰기와 atomic 파일 교체를 구분한다. */
async function fileVersion(file: string): Promise<string> {
  // 설정을 비우는 null device는 다른 명령의 출력으로 시각이 변해도 내용은 항상 비어 있다.
  if (process.platform === "win32" && /^NUL$/i.test(file)) return "empty-config";
  try {
    const value = await stat(file, { bigint: true });
    if (value.isCharacterDevice() && await realpath(file) === "/dev/null") return "empty-config";
    if (!value.isFile() && !value.isDirectory()) throw new Error("Blame metadata identity unavailable.");
    return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}
