// git graph 웹뷰로 로컬/원격 tag 상태를 보내는 모듈.
// - GraphPanel 은 패널 생애주기와 라우팅만 담당하고, tag 상태 조회/로그는 여기서 처리한다.
import { GitTagService } from "../git/gitTagService";
import type { GitTagQueryOptions, GitTagStatus } from "../git/gitTagService";
import { logError, logInfo } from "../ui/outputLog";
import { ToWebviewMessage } from "./graphProtocol";

/** 실제 tag 서비스 또는 시험용 조회를 같은 취소 수명에 연결하는 경계다. */
type TagReader = (repoRoot: string, options: GitTagQueryOptions) => Promise<GitTagStatus[]>;
const readTags: TagReader = (repoRoot, options) => new GitTagService(repoRoot).getTagStatuses(options);

/** Graph tag 작업을 소유하고 교체/숨김/폐기 뒤 실제 조회가 남지 않게 한다. */
export class GraphTagStatusLoading {
  private active?: { controller: AbortController; repoRoot: string; forceRemote?: boolean; promise: Promise<void> };
  private paused?: { repoRoot: string; forceRemote?: boolean };
  /** @param read signal을 실제 Git까지 전달하고 마지막 소비자인 조회의 close를 기다리는 reader */
  constructor(private readonly read: TagReader = readTags) {}

  /**
   * 이전 조회를 취소하고 종료 뒤 최신 요청 하나를 실행한다. 여러 교체 요청은 오래된 queued 조회를 시작하지 않는다.
   * @param repoRoot 대상 저장소 @param post 현재 세대의 게시 함수 @param options 수동 원격 갱신 여부
   * @returns 조회·취소·실패의 정리가 끝나는 Promise. Graph 본문은 이 작업을 await하지 않는다.
   */
  start(repoRoot: string, post: (message: ToWebviewMessage) => void,
    options: Pick<GitTagQueryOptions, "forceRemote" | "localTagsAbsent"> = {}): Promise<void> {
    const previous = this.active;
    this.cancel("superseded");
    this.paused = undefined;
    const active = { controller: new AbortController(), repoRoot, forceRemote: options.forceRemote, promise: undefined! as Promise<void> };
    this.active = active;
    active.promise = Promise.resolve().then(async () => {
      await previous?.promise;
      if (active.controller.signal.aborted) return;
      await sendGraphTagStatus(repoRoot, message => {
        if (this.active === active && !active.controller.signal.aborted) post(message);
      }, { ...options, signal: active.controller.signal }, this.read);
    }).finally(() => { if (this.active === active) this.active = undefined; });
    return active.promise;
  }

  /** @param reason OUTPUT의 취소 원인. active 참조는 실제 close까지 남겨 다음 요청의 중복 실행을 막는다. */
  cancel(reason: string): void {
    const discarded = reason === "dispose" || reason === "repositoryChanged";
    if (discarded) this.paused = undefined;
    const active = this.active;
    if (!active || active.controller.signal.aborted) return;
    if (!discarded) this.paused = { repoRoot: active.repoRoot, forceRemote: active.forceRemote };
    active.controller.abort();
    logInfo("graph tag status cancelled", { repoRoot: active.repoRoot, reason });
  }

  /**
   * 화면 복귀/이력 교체 뒤 중단한 같은 저장소의 요청만 한 번 재개한다. 완료했던 조회는 다시 실행하지 않는다.
   * @param repoRoot 현재 저장소 @param post 현재 Panel의 게시 함수 @returns 재개를 예약했으면 true
   */
  resume(repoRoot: string, post: (message: ToWebviewMessage) => void): boolean {
    const paused = this.paused; this.paused = undefined;
    if (!paused || paused.repoRoot !== repoRoot) return false;
    logInfo("graph tag status resumed", { repoRoot });
    void this.start(repoRoot, post, { forceRemote: paused.forceRemote }); return true;
  }
}

/**
 * 로컬/원격 tag 상태를 조회해 웹뷰에 보낸다.
 * - 원격 tag 조회는 느릴 수 있으므로 호출부는 await 하지 않고 그래프 렌더링과 병렬로 실행한다.
 * @param repoRoot 대상 git 저장소 루트
 * @param post 웹뷰 메시지 전송 콜백
 * @param options 원격 갱신/TTL과 소비자 취소 신호 @param query 독립 실행 가능한 tag 서비스 조회
 */
export async function sendGraphTagStatus(
  repoRoot: string,
  post: (message: ToWebviewMessage) => void,
  options: GitTagQueryOptions = {},
  query: TagReader = readTags
): Promise<void> {
  const started = Date.now();
  try {
    const tags = await query(repoRoot, options);
    options.signal?.throwIfAborted();
    post({ type: "tagStatus", tags });
    logInfo("graph tag status sent", {
      repoRoot,
      tags: tags.length,
      localTags: tags.filter((tag) => tag.localHash).length,
      remoteTags: tags.filter((tag) => tag.remoteTargets.length > 0).length,
      forcedRemote: !!options.forceRemote,
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    if (options.signal?.aborted) logInfo("graph tag status skipped", { repoRoot, reason: "cancelled" });
    else logError("graph tag status failed", err, { repoRoot });
  }
}
