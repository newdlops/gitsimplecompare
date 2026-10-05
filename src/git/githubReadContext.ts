import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import path from "node:path";

const probes = new Map<string, Promise<string | undefined>>();

/** 요청 당시 환경을 복사해 대기 중 인증·저장소 변경이 실제 실행에 섞이지 않게 한다. */
export function snapshotGitHubEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...env };
}

/**
 * CLI의 저장소·서버·인증 문맥을 비밀값이 노출되지 않는 해시로 구분한다.
 * 설정 파일은 내용 대신 inode/크기/수정 시각을 읽어 계정 전환도 캐시를 무효화한다.
 * @param root 실행 저장소 루트, env 요청 당시 환경, args placeholder 사용 여부를 판별할 인자
 * @param extraFiles Git이 실제로 읽은 include 설정 등 추가 무효화 대상
 * @returns 같은 시점의 비동기 metadata 검사를 공유해 만든 불투명 문맥 키. 완료 검사는 보관하지 않는다.
 */
export async function gitHubReadContext(root: string, env: NodeJS.ProcessEnv,
  args: readonly string[], extraFiles: readonly string[] = []): Promise<string> {
  const variables = Object.keys(env).filter(key => /^(GH_|GITHUB_|GIT_)/.test(key) ||
    ["PATH", "SHELL", "HOME", "USERPROFILE", "APPDATA", "AppData", "XDG_CONFIG_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"].includes(key))
    .sort().map(key => [key, env[key]]);
  const repository = args[0] === "repo" || args.some(arg => arg.includes("{owner}") || arg.includes("{repo}"));
  const probeKey = createHash("sha256").update(JSON.stringify([root, variables, repository, extraFiles])).digest("hex");
  let probe = probes.get(probeKey);
  if (!probe) {
    probe = readContextFiles(root, env, repository, extraFiles);
    probes.set(probeKey, probe);
    const owned = probe;
    void probe.finally(() => { if (probes.get(probeKey) === owned) probes.delete(probeKey); });
  }
  const metadata = await probe;
  // 관찰 실패는 소비자마다 다른 key를 주어 완료 캐시와 진행 요청 공유를 생략한다.
  return createHash("sha256").update(JSON.stringify([probeKey, metadata ?? Math.random()])).digest("hex");
}

/** 인증 파일·Git 경로를 비동기로 검사하며 불확실한 관찰은 공유 불가로 돌린다. */
async function readContextFiles(root: string, env: NodeJS.ProcessEnv, repository: boolean,
  extraFiles: readonly string[]): Promise<string | undefined> {
  try {
    const configDir = env.GH_CONFIG_DIR || (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, "gh") :
      process.platform === "win32" && (env.APPDATA || env.AppData) ? path.join((env.APPDATA || env.AppData)!, "GitHub CLI") :
        path.join(env.HOME || env.USERPROFILE || "", ".config", "gh"));
    const files = [path.join(configDir, "hosts.yml"), path.join(configDir, "config.yml"), ...extraFiles];
    if (repository) files.push(...await gitRepositoryContextFiles(root, env));
    const unique = [...new Set(files)];
    return JSON.stringify(await Promise.all(unique.map(async file => [file, await gitHubFileIdentity(file)])));
  } catch { return undefined; }
}

/** 일반·linked worktree·명시적 GIT_DIR의 설정 경로와 includeIf 조건 변경의 관찰 대상을 반환한다. */
export async function gitRepositoryContextFiles(root: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  let gitDir = env.GIT_DIR ? path.resolve(root, env.GIT_DIR) : path.join(root, ".git");
  const markerPath = gitDir;
  try {
    if ((await stat(gitDir)).isFile()) {
      const marker = (await readSmallMarker(gitDir)).match(/^gitdir:\s*(.+)/);
      if (!marker) throw new Error("Invalid Git directory marker.");
      gitDir = path.resolve(path.dirname(gitDir), marker[1].trim());
    }
  } catch (error) { if (!isMissing(error)) throw error; }
  let commonDir = env.GIT_COMMON_DIR ? path.resolve(root, env.GIT_COMMON_DIR) : gitDir;
  try { if (!env.GIT_COMMON_DIR) commonDir = path.resolve(gitDir, (await readSmallMarker(path.join(gitDir, "commondir"))).trim()); }
  catch (error) { if (!isMissing(error)) throw error; }
  const home = env.HOME || env.USERPROFILE || "";
  return [markerPath, path.join(gitDir, "commondir"), path.join(gitDir, "HEAD"),
    path.join(gitDir, "config.worktree"), path.join(commonDir, "config"),
    env.GIT_CONFIG_GLOBAL || path.join(home, ".gitconfig"),
    path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "git", "config"),
    env.GIT_CONFIG_SYSTEM || "/etc/gitconfig"];
}

/** 짧은 Git 경로 표식을 최대 4097바이트만 읽어 실행 중 교체나 크기 증가를 거절한다. */
async function readSmallMarker(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const before = await handle.stat();
    if (before.size > 4096) throw new Error("Git path marker is too large.");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (bytesRead > 4096 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Git path marker changed.");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

/** 파일 내용을 읽지 않고 inode·나노초 시각으로 교체와 수정을 구별한다. 관찰 실패는 상위로 전달한다. */
export async function gitHubFileIdentity(file: string): Promise<string> {
  if (process.platform === "win32" && /^NUL$/i.test(file)) return "empty-config";
  try {
    const value = await stat(file, { bigint: true });
    if (value.isCharacterDevice() && file === "/dev/null") return "empty-config";
    // .git 디렉터리의 lock/index 생성은 remote/auth 변경이 아니므로 경로 교체만 식별한다.
    if (value.isDirectory()) return [value.dev, value.ino, "directory"].join(":");
    return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
  } catch (error) { if (isMissing(error)) return "missing"; throw error; }
}

/** 존재하지 않는 경로만 정상 누락으로 인정하고 권한·디스크 오류는 공유 불가로 처리한다. */
function isMissing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "");
}
