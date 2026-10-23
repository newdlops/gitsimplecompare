// Git이 알려 준 경로를 재사용할 때 worktree/commondir 교체 여부를 저렴하게 확인하는 파일시스템 증거.
import type { Stats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

/** identity는 경로 재사용용 연결 증거, boundary는 한 번의 읽기 도중 교체·원복을 감지하는 시각 증거다. */
export interface RepositoryMetadata { gitDir: string; commonDir: string; identity: string; boundary: string; }

/**
 * 저장소 루트의 .git 또는 명시적인 GIT_DIR을 해석하되 불확실하면 undefined로 Git 조회에 맡긴다.
 * - HEAD·index·ref는 읽거나 캐시하지 않는다. 정상 Git 쓰기로 바뀌는 디렉터리 시각은 identity에서 제외한다.
 * - gitfile/commondir의 파일 시각과 읽기 전후 증거로 연결의 교체·원복도 검출한다.
 * - boundary는 현재 조회의 전후에만 비교한다. 다음 정상 조회는 새 boundary로 경로를 재사용한다.
 * @param repoRoot 명령이 고정한 작업트리 루트 @returns 경로 재사용을 검증할 증거, bare/오류이면 undefined
 */
export async function readRepositoryMetadata(repoRoot: string): Promise<RepositoryMetadata | undefined> {
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
    return { gitDir, commonDir, identity, boundary: JSON.stringify([identity, fileVersion(gitInfo), fileVersion(commonInfo)]) };
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
