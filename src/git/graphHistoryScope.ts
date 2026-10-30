// PR 점프와 이후 페이지가 같은 전체 이력·추가 OID·시간순을 사용하도록 Git 조회 범위를 보존한다.
import type { Commit } from "../graph/graphTypes";
import { runGit, runGitWithInput } from "./gitExec";
import { ALL_GRAPH_REF_ARGS, runGitWithRevisions } from "./revisionInput";
import { gitLogPrettyFormat, parseGitLogOutput } from "./gitLogParse";
import type { CandidateCommitWindowResult } from "./gitLogWindow";

/** 일반 브랜치 범위와 ref가 없는 PR 시작 OID를 합친 탐색 수명이다. Git ref를 새로 만들지 않는다. */
export interface GraphHistoryScope {
  allRefs: boolean;
  refs: string[];
  roots: string[];
}

/**
 * 전체 이력과 선택한 PR을 같은 날짜 기반 DAG 순서로 읽고 대상 주변의 실제 위치를 반환한다.
 * @param root 저장소 @param scope 이후 페이징에도 그대로 사용할 범위 @param candidates 우선순위 OID
 * @param before 대상 위 커밋 수 @param after 대상과 아래 커밋 수 @param signal 조회 취소 수명
 * @returns 전체 범위의 offset·개수와 제한된 커밋 목록. 대상이 없으면 빈 결과다.
 */
export async function loadGraphHistoryWindow(root: string, scope: GraphHistoryScope, candidates: readonly string[],
  before: number, after: number, signal?: AbortSignal): Promise<CandidateCommitWindowResult> {
  const output = await readScope(["rev-list", "--date-order"], root, scope, signal);
  const hashes = output.trim().split("\n").filter(Boolean);
  const priorities = new Map(candidates.map((hash, index) => [hash, index]));
  let hash: string | undefined, targetIndex = -1, priority = Infinity;
  for (let index = 0; index < hashes.length; index++) {
    const rank = priorities.get(hashes[index]);
    if (rank !== undefined && rank < priority) {
      hash = hashes[index]; targetIndex = index; priority = rank;
      if (rank === 0) break;
    }
  }
  if (!hash) return { commits: [], startIndex: 0, targetIndex: -1, totalCount: hashes.length };
  const startIndex = Math.max(0, targetIndex - Math.max(0, before));
  const commits = await readGraphHistoryPage(root, scope, startIndex, targetIndex - startIndex + Math.max(1, after), signal);
  return { hash, commits, startIndex, targetIndex, totalCount: hashes.length };
}

/**
 * 점프 때 확정한 전체 범위를 날짜순으로 페이지 조회한다. 추가 OID의 조상만 따로 읽지 않는다.
 * @param root 저장소 @param scope 채택한 점프 범위 @param skip 전체 순서의 offset @param limit 최대 커밋 수
 * @param signal 더 이상 표시하지 않을 읽기의 취소 신호 @returns full decoration을 포함한 실제 커밋
 */
export async function readGraphHistoryPage(root: string, scope: GraphHistoryScope, skip: number, limit: number,
  signal?: AbortSignal): Promise<Commit[]> {
  signal?.throwIfAborted();
  const count = Math.max(0, Math.floor(limit));
  if (!count) return [];
  const output = await readScope(["log", "--date-order", "--decorate=full", `--pretty=tformat:${gitLogPrettyFormat()}`,
    "-z", `-n${count}`, ...(skip > 0 ? [`--skip=${Math.floor(skip)}`] : [])], root, scope, signal);
  signal?.throwIfAborted();
  return parseGitLogOutput(output, true);
}

/**
 * catalog 이후 손상된 ref가 생긴 경우 정상 branch/remote/tag만 OID로 고정해 전체 탐색을 복구한다.
 * @param root 저장소 @param signal 같은 조회 수명 @returns 실제 commit으로 해석된 전체 정상 ref의 OID
 * - 내부 snapshot ref와 누락 객체는 제외하며 ref·FETCH_HEAD·index·작업 파일은 쓰지 않는다.
 */
export async function readAvailableGraphRoots(root: string, signal?: AbortSignal): Promise<string[]> {
  const refs = await runGit(["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes", "refs/tags"], root, { signal });
  const hashes = [...new Set(refs.trim().split("\n").filter(hash => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)))];
  if (!hashes.length) return [];
  const output = await runGitWithInput(["cat-file", "--batch-check=%(objectname) %(objecttype)"], root,
    hashes.map(hash => `${hash}^{commit}\n`).join(""), { signal, env: { GIT_NO_LAZY_FETCH: "1" } });
  return [...new Set(output.trim().split("\n").flatMap(line => {
    const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?) commit$/.exec(line);
    return match ? [match[1]] : [];
  }))];
}

/** 기본 전체 refs와 명시 OID를 동시에 stdin으로 전달하며 빈 명시 범위의 암묵적 확장을 금지한다. */
function readScope(args: string[], root: string, scope: GraphHistoryScope, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const revisions = [...new Set([...scope.refs, ...scope.roots])];
  if (!scope.allRefs && !revisions.length) return Promise.resolve("");
  return runGitWithRevisions([...args, ...(scope.allRefs && revisions.length ? ALL_GRAPH_REF_ARGS : [])],
    revisions, root, { signal });
}
