// 전체 파일을 요구하는 hook/filter/config가 없다고 확인한 큰 저장소에만 compact replay를 허용한다.
import { open, readdir } from "node:fs/promises";
import * as path from "node:path";
import { readGitConfigSnapshot } from "./gitConfigSnapshot";
import { runGit, runGitWithInput } from "./gitExec";
import { readRepositoryMetadata } from "./repositoryMetadata";
import { REPLAY_WORKTREE_PATH_LIMIT } from "./replayWorktreePaths";

export const REPLAY_WORKTREE_MIN_ENTRIES = 5_000;
const BRANCH_SQUASH_MIN_ENTRIES = 1_000;
export type CompactWorktreeOperation = "replay" | "merge";
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const CONFIG = "^(core\\.(hookspath|sparsecheckout|splitindex|attributesfile)|index\\.sparse|commit\\.gpgsign|filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver)$";

/**
 * 작업 종류별로 전체 checkout보다 index 준비가 유리한 최소 크기를 공유한다.
 * @param operation PR replay 또는 브랜치 squash @returns 원본 index와 준비한 index 양쪽에 적용할 최소 항목 수
 */
export function minimumCompactWorktreeEntries(operation: CompactWorktreeOperation): number {
  return operation === "merge" ? BRANCH_SQUASH_MIN_ENTRIES : REPLAY_WORKTREE_MIN_ENTRIES;
}

/**
 * source index는 12바이트 크기 힌트만 읽고, 실제 실행 조건은 fresh Git config와 Native tree로 확인한다.
 * @param root 원래 저장소 @param beforeHead 고정 시작 OID @param commits replay할 고정 OID 배열
 * @param operation merge는 전체 분기 이력을 적용하므로 상대 hook 경로의 부재를 마지막 patch로 추론하지 않는다.
 * @returns 파일 누락에 영향을 받는 외부 명령·특수 index가 없고 크기 범위가 맞으면 true
 */
export async function canUseCompactReplayWorktree(
  root: string, beforeHead: string, commits: readonly string[], operation: CompactWorktreeOperation = "replay"
): Promise<boolean> {
  if (["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"].some(key => process.env[key])) return false;
  if (!OID.test(beforeHead) || commits.length > 512 || commits.some(hash => !OID.test(hash))) return false;
  const metadata = await readRepositoryMetadata(root);
  if (!metadata) return false;
  const count = await indexEntryHint(path.join(metadata.gitDir, "index"));
  if (count < minimumCompactWorktreeEntries(operation) || count > REPLAY_WORKTREE_PATH_LIMIT) return false;
  const config = await readGitConfigSnapshot(root, CONFIG);
  if (config.keys().some(key => key.startsWith("filter.") || key.startsWith("merge."))) return false;
  if (config.get("core.attributesfile") !== undefined) return false;
  if (["core.sparsecheckout", "core.splitindex", "index.sparse", "commit.gpgsign"]
    .some(key => { const value = config.get(key); return value !== undefined && !/^(false|no|off|0)$/i.test(value); })) return false;
  const configured = config.get("core.hookspath");
  if (configured === undefined) return emptyHookDirectory(path.join(metadata.commonDir, "hooks"));
  const output = await runGit(["config", "--null", "--path", "--get", "core.hooksPath"], root);
  const hooks = output.endsWith("\0") ? output.slice(0, -1) : output;
  // 원본 바이트를 잃은 설정을 ENOENT인 빈 디렉터리로 오인하지 않는다. 긴 경로도 최적화에서 제외한다.
  if (hooks.includes("\ufffd") || Buffer.byteLength(hooks) > 4096) return false;
  if (path.isAbsolute(hooks)) return hooks === "/dev/null" || emptyHookDirectory(hooks);
  // merge에는 중간 커밋·merge base에서 유래한 hook이 포함될 수 있어 상대 경로는 전체 checkout을 유지한다.
  if (operation === "merge") return false;
  // 상대 hook은 새 worktree의 tracked 파일에서만 생긴다. 시작 tree와 모든 적용 patch에 없음을 검증한다.
  if (!hooks || /[\\\r\n\0]/.test(hooks)) return false;
  const relative = path.posix.normalize(hooks);
  if (relative === "." || relative.startsWith("../") || relative === ".." || relative.startsWith(".git/")) return false;
  // ls-tree는 symlink를 따라가지 않는다. 상위 경로까지 부재를 증명해 외부 hook으로 향하는 tracked 링크를 놓치지 않는다.
  const parts = relative.split("/").filter(Boolean);
  if (parts.length > 16) return false;
  const ancestors = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  if (await runGit(["--literal-pathspecs", "ls-tree", "-z", beforeHead, "--", ...ancestors], root)) return false;
  if (!commits.length) return true;
  return !(await runGitWithInput(["--literal-pathspecs", "diff-tree", "--stdin", "--root", "-r", "--no-commit-id",
    "--name-only", "-z", "--no-renames", "--", ...ancestors], root, commits.join("\n") + "\n"));
}

/** index 본문을 메모리에 읽지 않는다. 위치·버전·짧은 읽기가 불확실하면 최적화를 생략한다. */
async function indexEntryHint(file: string): Promise<number> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "r");
    const header = Buffer.alloc(12), result = await handle.read(header, 0, 12, 0);
    return result.bytesRead === 12 && header.toString("ascii", 0, 4) === "DIRC" && [2, 3, 4].includes(header.readUInt32BE(4))
      ? header.readUInt32BE(8) : 0;
  } catch { return 0; } finally { await handle?.close(); }
}

/** 절대·공유 hook은 하나라도 실제 항목이 있으면 전체 checkout을 유지한다. 부재만 안전한 빈 목록이다. */
async function emptyHookDirectory(directory: string): Promise<boolean> {
  try { return (await readdir(directory)).every(name => name.endsWith(".sample")); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}
