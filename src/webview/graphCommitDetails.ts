// graph commit 상세 전송을 담당하는 보조 모듈.
// - 느린 파일/브랜치 상세 계산 전에 header-only 요약을 먼저 보내 drawer 반응성을 높인다.
import { getCommitDetailSummary } from "../git/commitDetailSummary";
import {
  GitLogService,
  ONGOING_COMMIT_HASH,
  STAGED_COMMIT_HASH,
} from "../git/gitLogService";
import { CommitDetail } from "../graph/graphTypes";
import { ToWebviewMessage } from "./graphProtocol";

type DetailResult =
  | { ok: true; detail: CommitDetail }
  | { ok: false; error: unknown };

/** CommitDetail 메시지를 순서 보장과 함께 보내는 sender */
export class GraphCommitDetailSender {
  private generation = 0;

  /**
   * 선택 커밋의 상세를 웹뷰로 보낸다.
   * - 실제 커밋은 요약을 먼저 보내고, 전체 상세가 준비되면 다시 보낸다.
   * - 사용자가 다른 커밋을 고르면 이전 비동기 결과는 버린다.
   * @param hash 선택된 커밋 해시
   * @param logService 전체 상세를 읽는 git 로그 서비스
   * @param post 웹뷰 메시지 전송 콜백
   */
  async send(
    hash: string,
    logService: GitLogService,
    post: (message: ToWebviewMessage) => void
  ): Promise<void> {
    const current = ++this.generation;
    const detailPromise: Promise<DetailResult> = logService.getCommitDetail(hash).then(
      (detail) => ({ ok: true, detail }),
      (error) => ({ ok: false, error })
    );
    if (!isVirtualCommit(hash)) {
      const summary = await getCommitDetailSummary(logService.repoRoot, hash).catch(() => undefined);
      if (summary && current === this.generation) {
        post({ type: "commitDetail", detail: summary });
      }
    }
    const result = await detailPromise;
    if (!result.ok) {
      throw result.error;
    }
    const detail = result.detail;
    if (current === this.generation) {
      post({ type: "commitDetail", detail });
    }
  }
}

/** 작업트리/index 를 나타내는 가상 커밋인지 확인한다. */
function isVirtualCommit(hash: string): boolean {
  return hash === ONGOING_COMMIT_HASH || hash === STAGED_COMMIT_HASH;
}
