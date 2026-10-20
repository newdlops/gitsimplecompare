// 작업트리의 Git directory, HEAD와 symbolic branch를 한 Git 실행으로 읽는다.
// - 전역 캐시는 두지 않아 rebase 안전 검사의 각 시점마다 실제 checkout을 새로 확인한다.
import { realpath } from "node:fs/promises";
import { GitError, runGit } from "./gitExec";
import { rememberGitOperationDirectory, reuseGitOperationDirectory } from "./gitStatePathScope";

/** detached HEAD에서는 branch와 branchRef가 비어 있는 현재 checkout snapshot이다. */
export interface GitCheckoutIdentity {
  gitDir: string;
  head: string;
  branchRef: string;
  branch: string;
}

/**
 * HEAD가 없는 저장소에서도 worktree 전용 Git 디렉터리를 한 번 읽어 실제 경로로 정규화한다.
 * @param repoRoot 저장소 또는 linked worktree 루트 @param signal 표시 조회를 취소하는 선택적 신호
 * @returns CLI가 덧붙인 마지막 개행만 제거한 경로. 이름 안의 개행과 끝 공백은 보존한다.
 */
export async function readGitDirectory(repoRoot: string, signal?: AbortSignal): Promise<string> {
  // 취소 가능한 UI 소비자는 scope의 공유 promise를 쓰지 않아 다른 소비자의 수명을 빼앗지 않는다.
  return signal ? readDirectory(repoRoot, signal) : reuseGitOperationDirectory(repoRoot, () => readDirectory(repoRoot));
}

/** Git이 반환한 실제 디렉터리를 매번 새로 해석하는 원본 조회다. HEAD/branch 검증은 별도 경로로 유지한다. */
async function readDirectory(repoRoot: string, signal?: AbortSignal): Promise<string> {
  const output = await runGit(["rev-parse", "--absolute-git-dir"], repoRoot, { signal });
  const ending = process.platform === "win32" && output.endsWith("\r\n") ? 2 : output.endsWith("\n") ? 1 : 0;
  const directory = output.slice(0, output.length - ending);
  if (!directory) throw new Error("Cannot verify the current worktree Git directory.");
  const canonical = await realpath(directory);
  signal?.throwIfAborted();
  return canonical;
}

/**
 * 현재 worktree의 경로·커밋 OID·브랜치를 한 번에 확인한다.
 * - rev-parse의 출력 옵션은 뒤 인자부터 적용되므로 첫 HEAD는 OID, 두 번째는 full ref다.
 * - 고정된 마지막 두 필드부터 파싱해 Git directory의 공백·줄바꿈을 손상하지 않는다.
 * - HEAD라는 tag 등으로 symbolic 출력이 모호할 때만 symbolic-ref로 branch를 보강한다.
 * @param repoRoot 조회할 저장소 또는 linked worktree의 루트
 * @param signal 표시용 요청의 취소 신호. mutation 안전 검사는 신호 없이 끝까지 수행한다.
 * @returns 실제 Git directory로 정규화한 checkout identity. unborn HEAD와 Git 조회 실패는 전파한다.
 */
export function readGitCheckoutIdentity(repoRoot: string, signal?: AbortSignal): Promise<GitCheckoutIdentity> {
  return readCheckoutIdentity(repoRoot, "HEAD", signal);
}

/**
 * push할 HEAD가 실제 commit인지 검증하면서 같은 조회에서 브랜치와 worktree도 고정한다.
 * @param repoRoot 저장소 루트 @param signal 선택적인 조회 취소 신호
 * @returns commit으로 검증한 checkout identity. blob/tag를 가리키도록 손상된 branch는 호출자가 ref OID도 비교한다.
 */
export function readGitCommitCheckoutIdentity(repoRoot: string, signal?: AbortSignal): Promise<GitCheckoutIdentity> {
  return readCheckoutIdentity(repoRoot, "HEAD^{commit}", signal);
}

/** @param repoRoot 저장소 루트 @param headReference OID 조회에 사용할 HEAD 표현 @param signal 취소 신호 @returns 공통 형식으로 파싱한 identity */
async function readCheckoutIdentity(repoRoot: string, headReference: "HEAD" | "HEAD^{commit}", signal?: AbortSignal): Promise<GitCheckoutIdentity> {
  let output: string;
  try {
    output = await runGit(["rev-parse", "--absolute-git-dir", headReference, "--symbolic-full-name", "HEAD"], repoRoot, { signal });
  } catch (error) {
    // ref 이름 충돌로 symbolic 표현만 실패한 경우에도 OID와 directory는 stdout에 남을 수 있다.
    if (!(error instanceof GitError) || !/ambiguous/i.test(error.stderr)) throw error;
    output = error.stdout;
  }
  const lineEnd = output.endsWith("\r\n") ? "\r\n" : "\n";
  const full = new RegExp(`${lineEnd}([0-9a-f]{40}|[0-9a-f]{64})${lineEnd}(HEAD|refs/heads/[^\\r\\n]+)${lineEnd}$`).exec(output);
  const oidOnly = full ? undefined : new RegExp(`${lineEnd}([0-9a-f]{40}|[0-9a-f]{64})${lineEnd}$`).exec(output);
  const record = full ?? oidOnly;
  if (!record) throw new Error("Cannot verify the current Git checkout identity.");
  const directory = output.slice(0, record.index);
  if (!directory) throw new Error("Cannot verify the current worktree Git directory.");
  const symbolic = full?.[2] ?? await readSymbolicHead(repoRoot, signal);
  const branchRef = symbolic === "HEAD" ? "" : symbolic;
  if (branchRef && !branchRef.startsWith("refs/heads/")) {
    throw new Error("HEAD does not point at a local branch.");
  }
  const gitDir = await realpath(directory);
  signal?.throwIfAborted();
  if (!signal) await rememberGitOperationDirectory(repoRoot, gitDir);
  return {
    gitDir,
    head: record[1],
    branchRef,
    branch: branchRef.slice("refs/heads/".length),
  };
}

/** 모호한 ref 출력만 보강하고, detached HEAD의 정상 exit=1과 실제 Git 오류를 구분한다. */
async function readSymbolicHead(repoRoot: string, signal?: AbortSignal): Promise<string> {
  try { return (await runGit(["symbolic-ref", "--quiet", "HEAD"], repoRoot, { signal })).trim(); }
  catch (error) {
    if (error instanceof GitError && error.code === 1) return "HEAD";
    throw error;
  }
}
