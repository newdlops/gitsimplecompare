// Git이 알려 준 경로를 재사용할 때 worktree/commondir 교체 여부를 저렴하게 확인하는 파일시스템 증거.
import type { Stats } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

/** identity는 경로 재사용용 연결 증거, boundary는 한 번의 읽기 도중 교체·원복을 감지하는 시각 증거다. */
export interface RepositoryMetadata {
  gitDir: string; commonDir: string; identity: string; boundary: string;
  /** private status가 별도로 검증하는 index 외의 연결·HEAD·설정 증거다. */
  statusBoundary?: string;
}

/**
 * 저장소 루트의 .git 또는 명시적인 GIT_DIR을 해석하되 불확실하면 undefined로 Git 조회에 맡긴다.
 * - HEAD·index·ref 내용은 읽거나 캐시하지 않는다. 정상 Git 쓰기의 디렉터리 시각은 identity에서 제외한다.
 * - gitfile/commondir의 파일 시각과 읽기 전후 증거로 연결의 교체·원복도 검출한다.
 * - boundary는 현재 조회의 전후에만 비교한다. 다음 정상 조회는 새 boundary로 경로를 재사용한다.
 * @param repoRoot 명령이 고정한 작업트리 루트
 * @param includeStatusBoundary true이면 status용 HEAD·설정 파일 증거도 읽는다. 기존 디렉터리 경계는 그대로 유지한다.
 * @returns 경로 재사용을 검증할 증거, bare/오류이면 undefined
 */
export async function readRepositoryMetadata(repoRoot: string, includeStatusBoundary = false): Promise<RepositoryMetadata | undefined> {
  try {
    const locator = path.resolve(repoRoot, process.env.GIT_DIR || ".git");
    const info = await stat(locator);
    const gitfile = info.isFile() ? await readFile(locator, "utf8") : "";
    const locatorVersion = info.isFile() ? fileVersion(info) : undefined;
    if (locatorVersion && locatorVersion !== fileVersion(await stat(locator))) return undefined;
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(gitfile);
    if (!info.isDirectory() && !match) return undefined;
    const gitDir = await realpath(match ? path.resolve(path.dirname(locator), match[1]) : locator);
    const commonMarker = process.env.GIT_COMMON_DIR === undefined ? await optionalMarker(path.join(gitDir, "commondir")) : undefined;
    const common = process.env.GIT_COMMON_DIR ?? commonMarker!.contents;
    const commonPath = process.env.GIT_COMMON_DIR !== undefined ? common
      : common.endsWith("\r\n") ? common.slice(0, -2) : common.endsWith("\n") ? common.slice(0, -1) : common;
    const commonDir = commonPath ? await realpath(path.resolve(process.env.GIT_COMMON_DIR ? repoRoot : gitDir, commonPath)) : gitDir;
    const [gitInfo, commonInfo] = gitDir === commonDir ? await stat(gitDir).then(value => [value, value])
      : await Promise.all([stat(gitDir), stat(commonDir)]);
    if (!gitInfo.isDirectory() || !commonInfo.isDirectory() || !gitInfo.ino || !commonInfo.ino) return undefined;
    const identity = JSON.stringify([locator, info.dev, info.ino, gitfile, locatorVersion,
      gitDir, gitInfo.dev, gitInfo.ino, common, commonMarker?.version, commonDir, commonInfo.dev, commonInfo.ino]);
    const statusBoundary = includeStatusBoundary ? await readStatusBoundary(gitDir, commonDir, identity) : undefined;
    return { gitDir, commonDir, identity, boundary: JSON.stringify([identity, fileVersion(gitInfo), fileVersion(commonInfo)]),
      ...(statusBoundary ? { statusBoundary } : {}) };
  } catch { return undefined; }
}

/**
 * 파일의 교체·동일 내용 재쓰기를 구분하며 읽기 자체가 바꾸는 atime은 제외한다.
 * @param info 같은 경계에서 읽은 파일 또는 디렉터리 stat @returns 비교에만 사용하는 직렬화된 변경 증거
 */
function fileVersion(info: Stats): string {
  return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
}

/**
 * status 도중 HEAD/설정의 제자리 재쓰기·원복도 검출할 추가 파일 증거를 만든다.
 * - 연결·디렉터리의 기존 boundary에 더해 사용하며, 기존 경계를 대체하지 않는다.
 * - 실제 index의 byte·inode·시각은 PrivateStatusIndex가 별도로 검증하므로 중복 읽지 않는다.
 * @param gitDir 실제 전용 metadata @param commonDir 공통 metadata
 * @param identity 같은 읽기에서 확인한 연결 증거
 * @returns 비교 전용 문자열. 파일 증거를 확인할 수 없으면 예외로 private 조회 증거 생성을 포기한다.
 */
async function readStatusBoundary(gitDir: string, commonDir: string, identity: string): Promise<string> {
  const files = await Promise.all([path.join(gitDir, "HEAD"), path.join(commonDir, "config"), path.join(gitDir, "config.worktree")]
    .map(optionalFileVersion));
  return JSON.stringify([identity, files]);
}

/**
 * HEAD/설정의 부재·교체·동일 내용 재쓰기를 구분하고 symlink 자체와 최종 파일을 함께 검증한다.
 * @param file Native status 의미에 영향을 주는 metadata 파일
 * @returns 파일 내용은 보관하지 않는 시각·inode 증거. ENOENT만 정상 부재로 인정한다.
 */
async function optionalFileVersion(file: string): Promise<string> {
  try {
    const info = await lstat(file);
    const target = info.isSymbolicLink() ? await stat(file) : info;
    if (!target.isFile()) throw new Error("Repository status metadata is not a regular file.");
    return JSON.stringify([file, fileVersion(info), fileVersion(target)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return JSON.stringify([file, "missing"]);
    throw error;
  }
}

/**
 * commondir 부재만 정상 marker로 취급하고 읽는 중 교체·권한/I/O 오류는 재사용 포기로 전달한다.
 * @param file Git metadata의 commondir marker 경로 @returns 전후 검증한 원문과 버전, 부재이면 빈 원문
 */
async function optionalMarker(file: string): Promise<{ contents: string; version: string }> {
  let before: Stats;
  try { before = await stat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { contents: "", version: "missing" };
    throw error;
  }
  if (!before.isFile()) throw new Error("Repository commondir is not a regular file.");
  const contents = await readFile(file, "utf8"), after = await stat(file);
  if (fileVersion(before) !== fileVersion(after)) throw new Error("Repository commondir changed while reading.");
  return { contents, version: fileVersion(after) };
}
