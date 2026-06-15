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
  const before = Math.max(0, Math.floor(options.before));
  const after = Math.max(1, Math.floor(options.after));
  const refs = refArgs(options.refs || []);
  const hashes = await loadOrderedHashes(repoRoot, refs);
  const index = hashes.indexOf(hash);
  if (index < 0) {
    return [];
  }
  return loadCommitSlice(repoRoot, Math.max(0, index - before), before + after, refs);
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
