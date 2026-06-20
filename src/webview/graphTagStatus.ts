// git graph 웹뷰로 로컬/원격 tag 상태를 보내는 모듈.
// - GraphPanel 은 패널 생애주기와 라우팅만 담당하고, tag 상태 조회/로그는 여기서 처리한다.
import { GitTagService } from "../git/gitTagService";
import { logError, logInfo } from "../ui/outputLog";
import { ToWebviewMessage } from "./graphProtocol";

/**
 * 로컬/원격 tag 상태를 조회해 웹뷰에 보낸다.
 * - 원격 tag 조회는 느릴 수 있으므로 호출부는 await 하지 않고 그래프 렌더링과 병렬로 실행한다.
 * @param repoRoot 대상 git 저장소 루트
 * @param post 웹뷰 메시지 전송 콜백
 */
export async function sendGraphTagStatus(
  repoRoot: string,
  post: (message: ToWebviewMessage) => void
): Promise<void> {
  const started = Date.now();
  try {
    const tags = await new GitTagService(repoRoot).getTagStatuses();
    post({ type: "tagStatus", tags });
    logInfo("graph tag status sent", {
      repoRoot,
      tags: tags.length,
      localTags: tags.filter((tag) => tag.localHash).length,
      remoteTags: tags.filter((tag) => tag.remoteTargets.length > 0).length,
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    logError("graph tag status failed", err, { repoRoot });
  }
}
