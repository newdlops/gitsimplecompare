// Native Git 탐색을 공유할 수 있는 가장 가까운 작업트리 marker만 찾는다. root 판정은 Git이 한다.
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { resolveGitExecutable } from "./gitExec";

const DISCOVERY_ENVIRONMENT = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"];
const MAX_DEPTH = 64, MAX_PENDING = 512;

/** 완료 결과는 캐시하지 않고 겹치는 경로의 진행 중 파일시스템 확인만 공유한다. */
export class RepositoryDiscoveryAnchors {
  private pending = new Map<string, Promise<string | undefined>>();

  /**
   * 물리 경로에서 가장 가까운 .git을 찾는다. bare·권한 오류·설정 override는 기존 Native 조회로 돌린다.
   * @param cwd 실제 Git 실행의 시작 디렉터리 @returns 공유 후보 작업트리 경로 또는 불확실한 undefined
   */
  async find(cwd: string): Promise<string | undefined> {
    const pending = this.pending;
    try {
      if (DISCOVERY_ENVIRONMENT.some(key => process.env[key] !== undefined) || resolveGitExecutable(cwd) !== "git") return undefined;
      for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) {
        if (process.env[key] && !path.isAbsolute(process.env[key]!)) return undefined;
      }
      const physical = await realpath(cwd);
      if (!(await stat(physical)).isDirectory()) return undefined;
      const anchor = await this.walk(physical, MAX_DEPTH, pending);
      return anchor && resolveGitExecutable(anchor) === "git" ? anchor : undefined;
    } catch { return undefined; }
  }

  /** 무효화 전 경로 확인이 새 세대의 진행 중 확인에 합류하지 않도록 map 수명 자체를 바꾼다. */
  clear(): void { this.pending = new Map(); }

  /**
   * 공유 marker 확인을 위로 연결하되 완료 항목을 즉시 해제하고 filesystem 경계를 넘지 않는다.
   * @param directory 물리 디렉터리 @param remaining 유한한 상위 탐색 깊이 @param pending 호출 세대의 소유 map
   * @returns 가장 가까운 file/directory .git marker. symlink marker나 bare 유사 경로는 Native에 맡긴다.
   */
  private walk(directory: string, remaining: number, pending: Map<string, Promise<string | undefined>>): Promise<string | undefined> {
    if (!remaining) return Promise.resolve(undefined);
    const existing = pending.get(directory); if (existing) return existing;
    const result = this.inspect(directory, remaining, pending);
    if (pending.size < MAX_PENDING) pending.set(directory, result);
    void result.finally(() => { if (pending.get(directory) === result) pending.delete(directory); }).catch(() => undefined);
    return result;
  }

  /** 실제 filesystem marker만 읽고 Git 설정·HEAD·branch 값을 추측하거나 보관하지 않는다. */
  private async inspect(directory: string, remaining: number, pending: Map<string, Promise<string | undefined>>): Promise<string | undefined> {
    try {
      const marker = await lstat(path.join(directory, ".git"));
      return marker.isFile() || marker.isDirectory() ? directory : undefined;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
    // bare repo 안의 경로를 바깥 worktree로 잘못 묶지 않는다. HEAD라는 일반 파일도 보수적으로 fallback한다.
    try { await lstat(path.join(directory, "HEAD")); return undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
    const parent = path.dirname(directory); if (parent === directory) return undefined;
    const [current, above] = await Promise.all([stat(directory), stat(parent)]);
    if (current.dev !== above.dev) return undefined;
    return this.walk(parent, remaining - 1, pending);
  }
}
