// 원격 연결 설정 화면의 branch/upstream/후보를 정확한 full ref로 읽는다. ahead/behind 순회는 수행하지 않는다.
import { GitError, runGit } from "./gitExec";
import type { CurrentRemoteBranchState, RemoteTrackingBranch } from "./remoteBranchService";
import { logInfo } from "../ui/outputLog";

interface RefRecord { fullRef: string; upstream: string; symbolic: string; }
const FORMAT = "%(refname)%00%(upstream)%00%(symref)";

/**
 * HEAD·remote 이름·ref catalog를 세 번 읽어 현재 upstream과 모든 원격 후보를 만든다.
 * @param root 현재 worktree 루트. linked worktree의 HEAD를 메인 저장소와 혼동하지 않는다.
 * @returns detached/unborn/gone을 구분하는 상태. 저장소·설정·권한 오류는 빈 성공으로 바꾸지 않는다.
 */
export async function readCurrentRemoteBranchState(root: string): Promise<CurrentRemoteBranchState> {
  const started = Date.now();
  const [branch, remoteOutput] = await Promise.all([readCurrentBranch(root), runGit(["remote"], root)]);
  const remotes = remoteOutput.trim().split(/\r?\n/).filter(Boolean);
  const patterns = [...(branch ? [`refs/heads/${branch}`] : []), "refs/remotes"];
  const output = await runGit(["for-each-ref", `--format=${FORMAT}`, ...patterns], root);
  const records = parseRefs(output);
  const byRef = new Map(records.map(row => [row.fullRef, row]));
  // for-each-ref의 경로 패턴은 자식도 포함하므로 현재 branch는 full ref가 같은 행만 선택한다.
  const upstreamRef = branch ? byRef.get(`refs/heads/${branch}`)?.upstream : undefined;
  let upstreamExists = !upstreamRef || byRef.has(upstreamRef);
  // local '.' remote와 사용자 fetch refspec은 refs/remotes 밖에 있으므로 정확한 ref만 추가 확인한다.
  if (upstreamRef && !upstreamExists && !upstreamRef.startsWith("refs/remotes/")) {
    upstreamExists = await refExists(root, upstreamRef);
  }
  const remoteBranches = remoteBranchesFor(records, remotes);
  const result = { branch, remotes, upstream: upstreamRef ? shortRef(upstreamRef) : undefined,
    upstreamRef: upstreamRef || undefined,
    upstreamGone: Boolean(upstreamRef && !upstreamExists), remoteBranches };
  logInfo("remote branch state loaded", { repoRoot: root, remoteCount: remotes.length,
    branchCount: remoteBranches.length, upstreamGone: result.upstreamGone, elapsedMs: Date.now() - started });
  return result;
}

/** detached HEAD의 정상 exit=1만 허용한다. 실패한 symbolic-ref를 detached로 숨기지 않는다. */
async function readCurrentBranch(root: string): Promise<string | undefined> {
  try {
    const value = (await runGit(["symbolic-ref", "--quiet", "HEAD"], root)).trim();
    if (!value.startsWith("refs/heads/")) throw new Error("HEAD does not point at a local branch.");
    return value.slice("refs/heads/".length);
  } catch (error) {
    if (error instanceof GitError && error.code === 1 && !error.stderr.trim()) return undefined;
    throw error;
  }
}

/** ref가 실제로 누락된 경우만 false로 반환하고 디스크·저장소 오류는 상위로 전달한다. */
async function refExists(root: string, ref: string): Promise<boolean> {
  try { await runGit(["show-ref", "--verify", "--quiet", ref], root); return true; }
  catch (error) {
    if (error instanceof GitError && error.code === 1 && !error.stderr.trim()) return false;
    throw error;
  }
}

/** Git 원본 필드를 손실 없이 나누고 누락 필드나 예상하지 못한 ref 응답은 성공으로 인정하지 않는다. */
function parseRefs(output: string): RefRecord[] {
  return output.split(/\r?\n/).filter(Boolean).map(line => {
    const fields = line.split("\0");
    if (fields.length !== 3 || !fields[0].startsWith("refs/") || fields[1] && !fields[1].startsWith("refs/")) {
      throw new Error("Cannot verify remote branch references.");
    }
    return { fullRef: fields[0], upstream: fields[1], symbolic: fields[2] };
  });
}

/** 모호한 refname:short 대신 namespace를 제거해 로컬 branch와 이름이 겹쳐도 원격 이름을 보존한다. */
function shortRef(ref: string): string {
  for (const prefix of ["refs/remotes/", "refs/heads/", "refs/"]) if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  throw new Error("Invalid upstream reference.");
}

/**
 * symbolic alias만 제외하고 등록된 가장 긴 remote prefix로 원격 branch를 분해한다.
 * @param records 조회한 전체 ref, remotes 설정된 이름 목록. 정렬은 전체 catalog에서 한 번만 한다.
 * @returns Git 순서의 원격 후보. 실제 commit을 가리키는 HEAD라는 branch도 숨기지 않는다.
 */
function remoteBranchesFor(records: readonly RefRecord[], remotes: readonly string[]): RemoteTrackingBranch[] {
  const names = [...remotes].sort((a, b) => b.length - a.length);
  return records.flatMap(row => {
    if (!row.fullRef.startsWith("refs/remotes/") || row.symbolic) return [];
    const name = shortRef(row.fullRef), remote = names.find(candidate => name.startsWith(`${candidate}/`));
    return remote && name.length > remote.length + 1 ? [{ name, remote, branch: name.slice(remote.length + 1) }] : [];
  });
}
