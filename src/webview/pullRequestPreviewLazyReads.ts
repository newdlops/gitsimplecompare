// PR preview의 지연 조회 결과를 표시 중인 요청 세대에만 게시한다.
import type { PullRequestService, StagedPullRequestPreview } from "../git/pullRequestService";
import { logError } from "../ui/outputLog";

/** 파일/대화 read의 UI 수명만 관리하고 GitHub 조회와 cache는 서비스에 위임한다. */
export class PullRequestPreviewLazyReads {
  private preview?: StagedPullRequestPreview;
  private signal?: AbortSignal;
  /** 서비스와 웹뷰 게시 callback을 받아 패널과 같은 repository 수명을 따른다. */
  constructor(private readonly service: PullRequestService, private readonly post: (message: unknown) => void) {}
  /** 초기 preview가 성공했을 때만 새 요청 ID와 취소 신호를 설치한다. */
  setPreview(preview: StagedPullRequestPreview, signal: AbortSignal): void { this.preview = preview; this.signal = signal; }
  /** 선택된 커밋만 읽고 성공한 빈 파일 목록과 조회 실패를 구분해 게시한다. */
  async loadCommit(hash: string, requestId?: number): Promise<void> {
    const preview = this.preview, signal = this.signal;
    if (!preview || signal?.aborted || requestId !== preview.requestId || !preview.previewCommits.some(commit => commit.hash === hash && !commit.synthetic)) return;
    try {
      const files = await this.service.getPreviewCommitFiles(hash, preview, signal);
      if (this.preview === preview && !signal?.aborted) this.post({ type: "commitFiles", requestId, hash, files });
    } catch (error) {
      if (this.preview !== preview || signal?.aborted) return;
      logError("PR preview commit files failed", error);
      this.post({ type: "commitFiles", requestId, hash, error: message(error) });
    }
  }
  /** Conversation 탭에서 요청한 대화를 읽되 다른 preview의 늦은 응답은 버린다. */
  async loadConversation(requestId?: number): Promise<void> {
    const preview = this.preview, signal = this.signal;
    if (!preview || signal?.aborted || requestId !== preview.requestId) return;
    try {
      const conversation = await this.service.getPreviewConversation(preview, signal);
      if (this.preview === preview && !signal?.aborted) this.post({ type: "previewConversation", requestId, conversation });
    } catch (error) {
      if (this.preview !== preview || signal?.aborted) return;
      logError("PR preview conversation failed", error);
      this.post({ type: "previewConversation", requestId, error: message(error) });
    }
  }
}

/** 알 수 없는 오류 값을 로그/웹뷰의 일반 문자열로 정규화한다. */
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
