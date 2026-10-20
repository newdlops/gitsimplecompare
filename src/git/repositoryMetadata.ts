// Git이 알려 준 경로를 재사용할 때 worktree/commondir 교체 여부를 저렴하게 확인하는 파일시스템 증거.
import { readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

/** 일반 저장소 또는 linked worktree의 실제 metadata 위치와 교체 감지용 식별자다. */
export interface RepositoryMetadata { gitDir: string; commonDir: string; identity: string; }

/**
 * 저장소 루트의 .git 또는 명시적인 GIT_DIR을 해석하되 불확실하면 undefined로 Git 조회에 맡긴다.
 * - HEAD·index·ref는 읽거나 캐시하지 않는다. 디렉터리 mtime은 정상 Git 쓰기로 바뀌므로 비교하지 않는다.
 * - gitfile/commondir 내용과 실제 디렉터리 inode를 포함해 외부 worktree 교체를 감지한다.
 * @param repoRoot 명령이 고정한 작업트리 루트 @returns 경로 재사용을 검증할 증거, bare/오류이면 undefined
 */
export async function readRepositoryMetadata(repoRoot: string): Promise<RepositoryMetadata | undefined> {
  try {
    const locator = path.resolve(repoRoot, process.env.GIT_DIR || ".git");
    const info = await stat(locator);
    const gitfile = info.isFile() ? await readFile(locator, "utf8") : "";
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(gitfile);
    if (!info.isDirectory() && !match) return undefined;
    const gitDir = await realpath(match ? path.resolve(path.dirname(locator), match[1]) : locator);
    const common = process.env.GIT_COMMON_DIR ?? await optionalFile(path.join(gitDir, "commondir"));
    const commonPath = process.env.GIT_COMMON_DIR !== undefined ? common
      : common.endsWith("\r\n") ? common.slice(0, -2) : common.endsWith("\n") ? common.slice(0, -1) : common;
    const commonDir = commonPath ? await realpath(path.resolve(process.env.GIT_COMMON_DIR ? repoRoot : gitDir, commonPath)) : gitDir;
    const [gitInfo, commonInfo] = await Promise.all([stat(gitDir), stat(commonDir)]);
    if (!gitInfo.isDirectory() || !commonInfo.isDirectory() || !gitInfo.ino || !commonInfo.ino) return undefined;
    return { gitDir, commonDir, identity: JSON.stringify([locator, info.dev, info.ino, gitfile,
      gitDir, gitInfo.dev, gitInfo.ino, common, commonDir, commonInfo.dev, commonInfo.ino]) };
  } catch { return undefined; }
}

/** 부재만 빈 marker로 처리하고 권한/I/O 오류는 상위의 재사용 포기로 전달한다. */
async function optionalFile(file: string): Promise<string> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
