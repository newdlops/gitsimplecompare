// 기능: git 그래프 웹뷰를 연다.
// - 대상 저장소를 탐지해 GitLogService 를 만들고 패널을 띄우는 "배선"만 담당한다.
import { GitLogService } from "../git/gitLogService";
import { GitGraphPanel } from "../webview/graphPanel";
import { CommandDeps, resolveWorkspaceService } from "./shared";

/**
 * "git 그래프 보기" 명령 본문.
 * - 워크스페이스 저장소를 찾고, 그래프 패널을 연다. 커밋은 스크롤에 맞춰 최초 커밋까지 증분 로드된다.
 * @param deps 공유 의존성(레지스트리/확장 URI 등)
 */
export async function showGraph(deps: CommandDeps): Promise<void> {
  const service = await resolveWorkspaceService(deps.registry);
  if (!service) {
    return;
  }

  GitGraphPanel.createOrShow(
    deps.extensionUri,
    new GitLogService(service.repoRoot)
  );
}
