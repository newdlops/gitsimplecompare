// graphPanel 이 보관한 commit 목록을 실제 그래프 레이아웃 입력/출력으로 바꾸는 순수 헬퍼.
// - 가상 staged/working commit 삽입 규칙을 패널 수명주기 코드와 분리한다.
import { compactGraphData } from "../graph/graphCompact";
import { layoutGraph } from "../graph/graphLayout";
import type { Commit, GraphData } from "../graph/graphTypes";
import { STAGED_COMMIT_HASH } from "../git/gitLogService";

/**
 * 현재 graph 상태를 compact 설정에 맞는 GraphData 로 변환한다.
 * @param commits 실제 git log 에서 읽은 커밋 목록
 * @param virtualCommits staged/working tree 를 나타내는 가상 커밋 목록
 * @param compact true 면 한 줄 병합 그래프를 압축한다.
 * @returns 웹뷰로 보낼 graph data
 */
export function layoutGraphData(
  commits: readonly Commit[],
  virtualCommits: readonly Commit[],
  compact: boolean
): GraphData {
  const graph = layoutGraph(graphCommits(commits, virtualCommits));
  return compact ? compactGraphData(graph) : graph;
}

/**
 * 가상 커밋은 HEAD 바로 위에 끼워 넣어 작업트리 상태가 현재 branch 와 연결되어 보이게 한다.
 * @param commits 실제 git log 커밋 목록
 * @param virtualCommits staged/working tree 가상 커밋 목록
 * @returns 레이아웃에 사용할 최종 커밋 목록
 */
function graphCommits(
  commits: readonly Commit[],
  virtualCommits: readonly Commit[]
): Commit[] {
  if (virtualCommits.length === 0) {
    return [...commits];
  }
  const headHash = virtualCommits.find(
    (commit) => commit.hash === STAGED_COMMIT_HASH
  )?.parents[0];
  const headIndex = commits.findIndex(
    (commit) => commit.hash === headHash || commit.refs.includes("HEAD")
  );
  if (headIndex < 0) {
    return [...virtualCommits, ...commits];
  }
  return [
    ...commits.slice(0, headIndex),
    ...virtualCommits,
    ...commits.slice(headIndex),
  ];
}
