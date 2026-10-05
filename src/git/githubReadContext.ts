import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** 요청 당시 환경을 복사해 대기 중 인증·저장소 변경이 실제 실행에 섞이지 않게 한다. */
export function snapshotGitHubEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...env };
}

/**
 * CLI의 저장소·서버·인증 문맥을 비밀값이 노출되지 않는 해시로 구분한다.
 * 설정 파일은 내용 대신 inode/크기/수정 시각을 읽어 계정 전환도 캐시를 무효화한다.
 * @param root 실행 저장소 루트, env 요청 당시 환경, args placeholder 사용 여부를 판별할 인자
 * @returns 캐시 내부에서만 사용하는 불투명 문맥 키
 */
export function gitHubReadContext(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): string {
  const variables = Object.keys(env).filter(key => /^(GH_|GITHUB_|GIT_)/.test(key) ||
    ["PATH", "SHELL", "HOME", "USERPROFILE", "APPDATA", "AppData", "XDG_CONFIG_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"].includes(key))
    .sort().map(key => [key, env[key]]);
  const configDir = env.GH_CONFIG_DIR || (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, "gh") :
    process.platform === "win32" && (env.APPDATA || env.AppData) ? path.join((env.APPDATA || env.AppData)!, "GitHub CLI") :
      path.join(env.HOME || env.USERPROFILE || "", ".config", "gh"));
  const files = [path.join(configDir, "hosts.yml"), path.join(configDir, "config.yml")];
  if (args[0] === "repo" || args.some(arg => arg.includes("{owner}") || arg.includes("{repo}"))) {
    let gitDir = env.GIT_DIR ? path.resolve(root, env.GIT_DIR) : path.join(root, ".git");
    files.push(gitDir);
    try {
      if (statSync(gitDir).isFile()) {
        const marker = readSmallMarker(gitDir).match(/^gitdir:\s*(.+)/);
        if (marker) gitDir = path.resolve(root, marker[1].trim());
      }
    } catch { /* 파일이 없는 테스트/비저장소 경로도 같은 문맥으로 처리한다. */ }
    files.push(path.join(gitDir, "config.worktree"), path.join(gitDir, "commondir"));
    let commonDir = gitDir;
    try { commonDir = path.resolve(gitDir, readSmallMarker(path.join(gitDir, "commondir")).trim()); }
    catch { /* 일반 저장소에는 commondir가 없다. */ }
    files.push(path.join(commonDir, "config"));
  }
  return createHash("sha256").update(JSON.stringify([variables, files.map(file => [file, fileIdentity(file)])])).digest("hex");
}

/** 짧은 Git 경로 표식만 읽으며 잘못된 대형 파일을 메모리로 적재하지 않는다. */
function readSmallMarker(file: string): string {
  if (statSync(file).size > 4096) throw new Error("Git path marker is too large.");
  return readFileSync(file, "utf8");
}

/** 파일 내용을 읽지 않고 교체·수정을 구별하며 관찰 실패 시 응답 공유를 피한다. */
function fileIdentity(file: string): string {
  try {
    const stat = statSync(file, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")) return "missing";
    return `unreadable:${Math.random()}`;
  }
}
