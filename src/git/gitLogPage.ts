// Graph 이력 조회와 containment 색인 반영을 분리해 선행 조회가 현재 화면의 캐시를 바꾸지 않게 한다.
import type { Commit } from "../graph/graphTypes";
import { runGitWithRevisions } from "./revisionInput";
import { gitLogPrettyFormat, parseGitLogOutput } from "./gitLogParse";

/**
 * Git의 실제 topo-order 페이지를 읽되 서비스의 표시 상태·색인은 변경하지 않는다.
 * @param repoRoot 대상 저장소 @param limit 최대 행 수 @param skip 건너뛸 행 수
 * @param refs 빈 배열이면 기존 --all 범위, 그 외에는 stdin으로 전달할 revision 목록
 * @param signal 숨김·요청 교체 시 소유 Git 조회를 종료하는 신호
 * @returns full decoration을 파싱한 새 커밋 배열. 실패·취소는 원래 오류를 전파한다.
 */
export async function readGitLogPage(repoRoot: string, limit: number, skip: number, refs: string[], signal?: AbortSignal): Promise<Commit[]> {
  const count = Math.max(0, Math.floor(limit)), offset = Math.max(0, Math.floor(skip));
  if (count === 0) return [];
  const output = await runGitWithRevisions(["log", "--topo-order", "--decorate=full",
    `--pretty=tformat:${gitLogPrettyFormat()}`, "-z", `-n${count}`, ...(offset ? [`--skip=${offset}`] : [])], refs, repoRoot, { signal });
  signal?.throwIfAborted();
  return parseGitLogOutput(output, true);
}
