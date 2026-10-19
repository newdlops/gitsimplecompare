import type { Commit } from "../graph/graphTypes";
import type { GitLogService } from "../git/gitLogService";
import { logError, logInfo } from "../ui/outputLog";

/**
 * 이력 게시와 독립적으로 local-only 색상 메타데이터를 붙이고 현재 세대의 실제 변화만 알린다.
 * @param service 읽기 시작 당시의 저장소 서비스 @param commits 유지한 실제 행 배열
 * @param current 패널·저장소·세대 검증 @param publish 바뀐 메타데이터를 게시할 UI 경계
 */
export function attachGraphLocalOnlyMarkers(service: Pick<GitLogService, "repoRoot" | "attachLocalOnlyBranches">,
  commits: Commit[], current: () => boolean, publish: () => void): void {
  const started = Date.now();
  void service.attachLocalOnlyBranches(commits).then(changedCount => {
    if (!current() || changedCount === 0) return;
    publish();
    logInfo("graph local-only markers sent", { repoRoot: service.repoRoot, changedCount, loadedCount: commits.length, elapsed: Date.now() - started });
  }).catch(error => logError("graph local-only markers failed", error, { repoRoot: service.repoRoot }));
}
