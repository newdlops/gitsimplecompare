import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveGitExecutable, runGit } from "./gitExec";

/** 불변 HEAD와 이력 해석을 구분하는 불투명 키. 경로·설정 값은 로그에 내보내지 않는다. */
export interface FileHistoryContext { revision: string; key: string }

/**
 * 현재 HEAD와 이력 해석 설정을 읽어 작업트리/index 갱신만으로 느린 log를 반복하지 않게 한다.
 * @param root 일반·linked worktree·명시 GIT_DIR를 Git이 직접 해석할 저장소 루트
 * @param file 캐시할 상대 경로. 상위 .gitattributes 변화도 numstat 해석에 포함한다.
 * @param signal 소비자 해제 시 context Git까지 중단할 신호
 * @returns 불변 조회 ref와 config/include·replace·shallow·attributes·환경 식별자
 */
export async function readFileHistoryContext(root: string, file: string, signal?: AbortSignal): Promise<FileHistoryContext> {
  const [location, configuration, replacements] = await Promise.all([
    runGit(["rev-parse", "--absolute-git-dir", "--git-common-dir", "HEAD"], root, { signal }),
    runGit(["config", "--null", "--list", "--show-origin"], root, { signal }),
    runGit(["for-each-ref", "--format=%(refname) %(objectname)", "refs/replace"], root, { signal }),
  ]);
  signal?.throwIfAborted();
  const lines = location.trimEnd().split("\n"), revision = lines.pop()!;
  if (lines.length !== 2 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)) throw new Error("Git history HEAD is not available.");
  const [gitDir, commonDir] = lines.map(directory => path.resolve(root, directory));
  const files = [gitDir, commonDir, path.join(commonDir, "shallow"), path.join(commonDir, "info/grafts"), path.join(commonDir, "info/attributes")];
  let directory = path.dirname(file);
  for (;;) {
    files.push(path.join(root, directory, ".gitattributes"));
    if (directory === ".") break;
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
  }
  const metadata = await Promise.all([...new Set(files)].map(identity));
  const environment = Object.keys(process.env).filter(name => name.startsWith("GIT_") || ["PATH", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "LANG", "LC_ALL", "TZ"].includes(name))
    .sort().map(name => [name, process.env[name]]);
  return { revision, key: createHash("sha256").update(JSON.stringify([root, revision, lines, metadata, configuration, replacements, environment, resolveGitExecutable(root)])).digest("hex") };
}

/** 디렉터리는 inode만, 파일은 bytes 교체 시각까지 구분하고 정상 누락만 허용한다. */
async function identity(file: string): Promise<string> {
  try {
    const info = await stat(file, { bigint: true });
    return [file, info.dev, info.ino, ...(info.isDirectory() ? [] : [info.size, info.mtimeNs, info.ctimeNs])].join(":");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")) return `${file}:missing`;
    throw error;
  }
}
