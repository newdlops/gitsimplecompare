// PR 결과 반영 중 reset --keep이 staged 추가 파일을 지우지 않도록 실제 index lock 안에서 보호한다.
import { withConflictIndexTransaction } from "./conflictIndexTransaction";
import { runGit, runGitWithInput, withGitConfigOverrides } from "./gitExec";
import { logInfo } from "../ui/outputLog";

/** reset 직전 보존할 새 stage-0 파일의 정확한 mode/OID/경로다. */
interface StagedAddition { mode: string; hash: string; file: string }

/**
 * 사용자 index를 잠근 상태에서 임시 index로 PR 결과를 반영하고 추가 파일의 stage를 복구한다.
 * - 추가 파일은 reset 동안 untracked로 취급해 sparse checkout에서도 파일 삭제를 막는다.
 * - 결과가 같은 경로나 상위/하위 경로를 변경하면 사용자 내용을 건드리기 전에 중단한다.
 * @param repoRoot 결과를 반영할 실제 작업트리
 * @param targetRef 시작 HEAD에서 파생된, 이미 검증한 결과 commit
 * @returns index 게시까지 끝나면 완료한다. 실패 시 원본 index와 복구 snapshot을 유지한다.
 */
export async function resetPullRequestResult(repoRoot: string, targetRef: string): Promise<void> {
  const preserved = await withConflictIndexTransaction(repoRoot, true, async ({ indexEnv }) => {
    const env = withGitConfigOverrides(indexEnv, { "core.fsmonitor": "false" });
    const raw = await runGit([
      "diff", "--cached", "--raw", "--no-renames", "--no-abbrev", "--no-ext-diff", "--diff-filter=A", "-z",
    ], repoRoot, { env });
    const additions = stagedAdditions(raw);
    if (additions.length) {
      const incoming = (await runGit(["diff", "--name-only", "--no-renames", "-z", "HEAD", targetRef, "--"], repoRoot, { env }))
        .split("\0").filter(Boolean);
      if (additions.some(addition => incoming.some(file => pathsOverlap(file, addition.file)))) {
        throw new Error("The PR result overlaps staged new files. Your index and working files were kept.");
      }
      await runGitWithInput(["update-index", "--force-remove", "-z", "--stdin"], repoRoot,
        `${additions.map(addition => addition.file).join("\0")}\0`, { env });
    }
    await runGit(["reset", "--keep", targetRef], repoRoot, { env, retryOnLock: false });
    if (additions.length) {
      await runGitWithInput(["update-index", "-z", "--index-info"], repoRoot,
        additions.map(addition => `${addition.mode} ${addition.hash}\t${addition.file}\0`).join(""), { env });
    }
    return additions.length;
  });
  if (preserved) logInfo("PR staged new files preserved", { repoRoot, count: preserved });
}

/** Git의 NUL raw 형식을 읽고 잘리거나 해석할 수 없는 index 정보는 반영 전에 거부한다. */
function stagedAdditions(raw: string): StagedAddition[] {
  if (!raw) return [];
  const parts = raw.split("\0");
  if (parts.pop() !== "" || parts.length % 2 !== 0) throw new Error("Cannot safely read staged new files before applying the PR result.");
  const result: StagedAddition[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const match = /^:000000 (\d{6}) 0{40}(?:0{24})? ([a-f0-9]{40}(?:[a-f0-9]{24})?) A$/.exec(parts[index]);
    if (!match || !parts[index + 1]) throw new Error("Cannot safely preserve a staged new file before applying the PR result.");
    result.push({ mode: match[1], hash: match[2], file: parts[index + 1] });
  }
  return result;
}

/** 파일↔디렉터리 충돌도 포함해 두 Git 상대 경로의 보호 범위가 겹치는지 판정한다. */
function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
