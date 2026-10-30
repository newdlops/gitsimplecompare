// 특정 commit 주변만 graph 에 그리기 위한 git log window 로더.
// - 오래된 PR 로 점프할 때 현재 HEAD 부터 대상까지 모든 중간 페이지를 로드하지 않게 한다.
import { Commit } from "../graph/graphTypes";
import { ALL_GRAPH_REF_ARGS, runGitWithRevisions } from "./revisionInput";
import { gitLogPrettyFormat, parseGitLogOutput } from "./gitLogParse";
import { runGitWithInput } from "./gitExec";

/** 특정 commit 주변 window 크기 옵션 */
export interface CommitWindowOptions {
  before: number;
  after: number;
  refs?: string[];
  /** 점프 대상을 바꾸거나 Graph를 숨기면 진행 중인 Git을 종료한다. */
  signal?: AbortSignal;
}

/** graph window 가 전체 로그에서 차지하는 위치 정보 */
export interface CommitWindowResult {
  commits: Commit[];
  startIndex: number;
  targetIndex: number;
  totalCount: number;
}

/** 여러 후보 중 실제 window의 중심으로 선택된 OID. 없으면 commits도 빈 배열이다. */
export interface CandidateCommitWindowResult extends CommitWindowResult { hash?: string }

/**
 * 전체 graph 순서에서 대상 commit 주변 slice 를 읽어 graph window 를 만든다.
 * @param repoRoot 저장소 루트
 * @param hash     중심 commit hash
 * @param options  위/아래 커밋 개수와 대상 ref 범위
 */
export async function loadCommitWindowAround(
  repoRoot: string,
  hash: string,
  options: CommitWindowOptions
): Promise<Commit[]> {
  return (await loadCommitWindowAroundWithRange(repoRoot, hash, options)).commits;
}

/**
 * 전체 graph 순서에서 대상 commit 주변 slice 와 전체 위치 정보를 함께 읽는다.
 * @param repoRoot 저장소 루트
 * @param hash     중심 commit hash
 * @param options  위/아래 커밋 개수와 대상 ref 범위
 */
export async function loadCommitWindowAroundWithRange(
  repoRoot: string,
  hash: string,
  options: CommitWindowOptions
): Promise<CommitWindowResult> {
  const { hash: _selected, ...window } = await loadCommitWindowForCandidates(repoRoot, [hash], options);
  return window;
}

/**
 * 후보가 많아도 전체 topo-order를 한 번만 읽고, 후보 우선순위에서 처음 존재하는 commit 주변을 읽는다.
 * @param repoRoot 저장소 루트 @param candidates merge 결과·PR head 순서의 OID 후보
 * @param options 앞/뒤 window 크기와 현재 ref 범위·취소 신호
 * @returns 선택 OID와 실제 graph 위치. 후보가 없으면 Git을 실행하지 않는다.
 */
export async function loadCommitWindowForCandidates(
  repoRoot: string, candidates: readonly string[], options: CommitWindowOptions
): Promise<CandidateCommitWindowResult> {
  options.signal?.throwIfAborted();
  const priorities = new Map(Array.from(new Set(candidates.map(hash => hash.trim()).filter(Boolean))).map((hash, index) => [hash, index]));
  if (!priorities.size) return { commits: [], startIndex: 0, targetIndex: -1, totalCount: 0 };
  const before = Math.max(0, Math.floor(options.before));
  const after = Math.max(1, Math.floor(options.after));
  const refs = refArgs(options.refs || []);
  const hashes = await loadOrderedHashes(repoRoot, refs, options.signal);
  let index = -1, priority = Infinity;
  for (let at = 0; at < hashes.length; at++) {
    const candidatePriority = priorities.get(hashes[at]);
    if (candidatePriority !== undefined && candidatePriority < priority) {
      index = at; priority = candidatePriority;
      if (priority === 0) break;
    }
  }
  if (index < 0) {
    return { commits: [], startIndex: 0, targetIndex: -1, totalCount: hashes.length };
  }
  const startIndex = Math.max(0, index - before);
  const commits = await loadCommitSlice(repoRoot, startIndex, before + after, refs, options.signal);
  return { hash: hashes[index], commits, startIndex, targetIndex: index, totalCount: hashes.length };
}

/**
 * 브랜치 삭제 뒤 로컬 object로만 남은 PR commit을 한 번의 batch-check와 제한된 log로 찾는다.
 * @param repoRoot 저장소 루트 @param candidates 우선순위대로 확인할 전체 OID(40/64자리만 허용)
 * @param limit 중심 commit과 조상을 표시할 최대 개수 @param signal 폐기된 Graph 읽기 취소
 * @returns 로컬에 존재하는 첫 commit window. lazy fetch·ref/index/config 쓰기는 하지 않는다.
 */
export async function loadLocalCommitWindowForCandidates(
  repoRoot: string, candidates: readonly string[], limit: number, signal?: AbortSignal
): Promise<CandidateCommitWindowResult | undefined> {
  const hash = await findLocalCommitCandidate(repoRoot, candidates, signal);
  if (!hash) return undefined;
  const commits = await loadCommitSlice(repoRoot, 0, Math.max(1, Math.floor(limit)), [hash], signal, true);
  return { hash, commits, startIndex: 0, targetIndex: commits.findIndex(commit => commit.hash === hash), totalCount: commits.length };
}

/**
 * 후보 전체를 한 batch 조회로 검증하고 우선순위가 가장 높은 로컬 commit OID만 반환한다.
 * @param repoRoot 저장소 @param candidates 전체 SHA-1/SHA-256 후보 @param signal 조회 취소 수명
 * @returns 실제 commit인 첫 OID. 객체를 자동 fetch하거나 특정 branch의 조상을 미리 읽지 않는다.
 */
export async function findLocalCommitCandidate(repoRoot: string, candidates: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  return (await findLocalCommitCandidates(repoRoot, candidates, signal))[0];
}

/** 전체 OID 후보 중 실제로 존재하는 commit만 입력 순서로 반환해 PR의 head와 선택 OID를 함께 검증한다. */
export async function findLocalCommitCandidates(repoRoot: string, candidates: readonly string[], signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const hashes = Array.from(new Set(candidates.map(hash => hash.trim().toLowerCase()).filter(hash => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash))));
  if (!hashes.length) return [];
  const output = await runGitWithInput(["cat-file", "--batch-check=%(objectname) %(objecttype)"], repoRoot,
    hashes.join("\n") + "\n", { signal, env: { GIT_NO_LAZY_FETCH: "1" } });
  const lines = output.trim().split("\n");
  return hashes.filter((candidate, index) => lines[index] === `${candidate} commit`);
}

/**
 * reflog 처럼 현재 ref 그래프 밖에 있을 수 있는 commit 을 직접 루트로 삼아 window 를 읽는다.
 * - 대상 hash 자체를 rev 로 넘겨 Git 이 접근 가능한 dangling/reflog commit 도 그래프에 표시한다.
 * - 일반 전체 그래프의 위치 정보가 없으므로 반환 commit 수를 totalCount 로 사용한다.
 * @param repoRoot 저장소 루트
 * @param hash     그래프에 반드시 포함할 commit hash
 * @param limit    대상 commit 과 조상 방향으로 읽을 최대 개수
 * @param signal   Graph 수명주기 변경 시 Git 프로세스를 종료할 신호
 */
export async function loadDirectCommitWindow(
  repoRoot: string,
  hash: string,
  limit: number,
  signal?: AbortSignal
): Promise<CommitWindowResult> {
  const targetHash = hash.trim();
  const safeLimit = Math.max(1, Math.floor(limit));
  const commits = await loadCommitSlice(repoRoot, 0, safeLimit, [targetHash], signal);
  const targetIndex = commits.findIndex((commit) => commit.hash === targetHash);
  return {
    commits,
    startIndex: 0,
    targetIndex,
    totalCount: commits.length,
  };
}

/**
 * 전체 graph topo-order 에서 commit hash 목록만 가볍게 읽는다.
 * @param repoRoot 저장소 루트
 * @param refs     대상 ref 범위
 */
async function loadOrderedHashes(
  repoRoot: string,
  refs: string[],
  signal?: AbortSignal
): Promise<string[]> {
  const out = await runGitWithRevisions(["rev-list", "--topo-order"], explicitRefs(refs), repoRoot, { signal });
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * 전체 graph topo-order 의 일부 구간을 Commit 객체로 읽는다.
 * @param repoRoot 저장소 루트
 * @param skip     graph 순서 앞에서 건너뛸 commit 수
 * @param limit    읽을 commit 수
 * @param refs     대상 ref 범위
 */
async function loadCommitSlice(
  repoRoot: string,
  skip: number,
  limit: number,
  refs: string[],
  signal?: AbortSignal,
  localOnly = false
): Promise<Commit[]> {
  const out = await runGitWithRevisions([
    "log",
    "--topo-order",
    "--decorate=full",
    `--pretty=tformat:${gitLogPrettyFormat()}`,
    "-z",
    `-n${limit}`,
    ...(skip > 0 ? [`--skip=${skip}`] : []),
  ], explicitRefs(refs), repoRoot, { signal, ...(localOnly ? { env: { GIT_NO_LAZY_FETCH: "1" } } : {}) });
  return parseGitLogOutput(out, true);
}

/**
 * refArgs 결과를 runGitWithRevisions 입력으로 되돌린다.
 * - 전체 범위(`--branches --remotes --tags`)면 빈 배열을, 명시 ref 면 그대로 반환해 stdin 으로 넘기게 한다.
 * @param refs refArgs 가 만든 git 인자
 * @returns 명시 ref 목록(전체 범위면 빈 배열)
 */
function explicitRefs(refs: string[]): string[] {
  return refs.every((ref) => ALL_GRAPH_REF_ARGS.includes(ref)) ? [] : refs;
}

/**
 * refs 가 비었을 때 전체 graph 와 같은 기본 ref 범위를 반환한다.
 * @param refs 사용자가 선택한 branch filter refs
 */
function refArgs(refs: string[]): string[] {
  return refs.length > 0 ? refs : ["--branches", "--remotes", "--tags"];
}
