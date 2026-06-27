// 특정 commit 주변만 graph 에 그리기 위한 git log window 로더.
// - 오래된 PR 로 점프할 때 현재 HEAD 부터 대상까지 모든 중간 페이지를 로드하지 않게 한다.
import { Commit } from "../graph/graphTypes";
import { runGit } from "./gitExec";
import { gitLogPrettyFormat, parseGitLogOutput } from "./gitLogParse";

/** 특정 commit 주변 window 크기 옵션 */
export interface CommitWindowOptions {
  before: number;
  after: number;
  refs?: string[];
}

/** graph window 가 전체 로그에서 차지하는 위치 정보 */
export interface CommitWindowResult {
  commits: Commit[];
  startIndex: number;
  targetIndex: number;
  totalCount: number;
}

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
  const targetHash = hash.trim();
  const before = Math.max(0, Math.floor(options.before));
  const after = Math.max(1, Math.floor(options.after));
  const refs = refArgs(options.refs || []);
  const hashes = await loadOrderedHashes(repoRoot, refs);
  const index = hashes.indexOf(targetHash);
  if (index < 0) {
    return { commits: [], startIndex: 0, targetIndex: -1, totalCount: hashes.length };
  }
  const startIndex = Math.max(0, index - before);
  const commits = await loadCommitSlice(repoRoot, startIndex, before + after, refs);
  return { commits, startIndex, targetIndex: index, totalCount: hashes.length };
}

/**
 * reflog 처럼 현재 ref 그래프 밖에 있을 수 있는 commit 을 직접 루트로 삼아 window 를 읽는다.
 * - 대상 hash 자체를 rev 로 넘겨 Git 이 접근 가능한 dangling/reflog commit 도 그래프에 표시한다.
 * - 일반 전체 그래프의 위치 정보가 없으므로 반환 commit 수를 totalCount 로 사용한다.
 * @param repoRoot 저장소 루트
 * @param hash     그래프에 반드시 포함할 commit hash
 * @param limit    대상 commit 과 조상 방향으로 읽을 최대 개수
 */
export async function loadDirectCommitWindow(
  repoRoot: string,
  hash: string,
  limit: number
): Promise<CommitWindowResult> {
  const targetHash = hash.trim();
  const safeLimit = Math.max(1, Math.floor(limit));
  const commits = await loadCommitSlice(repoRoot, 0, safeLimit, [targetHash]);
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
  refs: string[]
): Promise<string[]> {
  const out = await runGit(["rev-list", "--topo-order", ...refs], repoRoot);
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
  refs: string[]
): Promise<Commit[]> {
  const out = await runGit([
    "log",
    "--topo-order",
    "--decorate=short",
    `--pretty=tformat:${gitLogPrettyFormat()}`,
    "-z",
    `-n${limit}`,
    ...(skip > 0 ? [`--skip=${skip}`] : []),
    ...refs,
  ], repoRoot);
  return parseGitLogOutput(out);
}

/**
 * refs 가 비었을 때 전체 graph 와 같은 기본 ref 범위를 반환한다.
 * @param refs 사용자가 선택한 branch filter refs
 */
function refArgs(refs: string[]): string[] {
  return refs.length > 0 ? refs : ["--branches", "--remotes", "--tags"];
}
