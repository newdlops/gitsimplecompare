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
 * 대상 commit 의 newer descendant 일부와 older ancestor 일부를 합쳐 graph window 를 만든다.
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
  const [newer, older] = await Promise.all([
    loadNewerDescendants(repoRoot, hash, before, options.refs || []),
    loadOlderAncestors(repoRoot, hash, after),
  ]);
  return uniqueCommits([...newer.reverse(), ...older]);
}

/**
 * 대상 commit 위쪽에 그릴 descendant commit 을 읽는다.
 * @param repoRoot 저장소 루트
 * @param hash     중심 commit hash
 * @param limit    가져올 최대 descendant 수
 * @param refs     대상 ref 범위. 비면 전체 branch/remote/tag 를 사용한다.
 */
async function loadNewerDescendants(
  repoRoot: string,
  hash: string,
  limit: number,
  refs: string[]
): Promise<Commit[]> {
  if (limit <= 0) {
    return [];
  }
  const out = await runGit([
    "log",
    "--topo-order",
    "--reverse",
    "--ancestry-path",
    "--decorate=short",
    `--pretty=tformat:${gitLogPrettyFormat()}`,
    "-z",
    `-n${limit}`,
    `${hash}..`,
    ...refArgs(refs),
  ], repoRoot).catch(() => "");
  return parseGitLogOutput(out);
}

/**
 * 대상 commit 과 그 아래쪽 ancestor commit 을 읽는다.
 * @param repoRoot 저장소 루트
 * @param hash     중심 commit hash
 * @param limit    대상 commit 을 포함해 가져올 최대 ancestor 수
 */
async function loadOlderAncestors(
  repoRoot: string,
  hash: string,
  limit: number
): Promise<Commit[]> {
  const out = await runGit([
    "log",
    "--topo-order",
    "--decorate=short",
    `--pretty=tformat:${gitLogPrettyFormat()}`,
    "-z",
    `-n${limit}`,
    hash,
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

/**
 * 여러 경로에서 중복으로 읽힌 commit 을 첫 등장 순서만 남긴다.
 * @param commits 중복 제거 대상 commit 목록
 */
function uniqueCommits(commits: Commit[]): Commit[] {
  const seen = new Set<string>();
  return commits.filter((commit) => {
    if (!commit.hash || seen.has(commit.hash)) {
      return false;
    }
    seen.add(commit.hash);
    return true;
  });
}
