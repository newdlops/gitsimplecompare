// graph commit 점프 요청을 처리하는 보조 모듈.
// - 웹뷰가 요청한 commit 이 아직 로드되지 않았으면 graph 페이지를 더 읽은 뒤 발견 결과를 돌려준다.
import { getHeadHash } from "../git/gitHead";
import { logError, logInfo } from "../ui/outputLog";
import { ToWebviewMessage } from "./graphProtocol";

/** commit visibility 보장에 필요한 graphPanel 콜백 묶음 */
export interface EnsureGraphCommitVisibleOptions {
  repoRoot: string;
  requestId: string;
  hashes: string[];
  loadedHash(hashes: string[]): string | undefined;
  loadWindow(hashes: string[], requestId?: string): Promise<string | undefined>;
  post(message: ToWebviewMessage): void;
}

/**
 * 후보 hash 중 하나가 graph 에 보일 때까지 추가 페이지를 읽고 결과를 웹뷰에 알린다.
 * @param options graphPanel 상태 접근/메시지 콜백
 */
export async function ensureGraphCommitVisible(
  options: EnsureGraphCommitVisibleOptions
): Promise<void> {
  const hashes = Array.from(new Set(options.hashes.filter(Boolean)));
  if (!hashes.length) {
    options.post({ type: "commitVisibility", requestId: options.requestId, found: false });
    return;
  }
  let found: string | undefined;
  try { found = options.loadedHash(hashes) || await options.loadWindow(hashes, options.requestId); }
  catch (error) {
    // 일반 error 메시지는 drawer 전체를 교체한다. PR 문맥과 재시도 버튼은 남기고 OUTPUT에 원인을 기록한다.
    logError("graph commit visibility failed", error, { repoRoot: options.repoRoot, requestId: options.requestId });
    options.post({ type: "commitVisibility", requestId: options.requestId, found: false });
    return;
  }
  options.post({
    type: "commitVisibility",
    requestId: options.requestId,
    hash: found,
    found: Boolean(found),
  });
  logInfo("graph commit visibility resolved", {
    repoRoot: options.repoRoot,
    requestId: options.requestId,
    found: Boolean(found),
    candidateCount: hashes.length,
  });
}

/**
 * 현재 HEAD 가 graph 에 보이도록 보장한다.
 * @param options graphPanel 상태 접근/메시지 콜백
 */
export async function ensureGraphHeadVisible(
  options: Omit<EnsureGraphCommitVisibleOptions, "hashes">
): Promise<void> {
  const headHash = await getHeadHash(options.repoRoot);
  await ensureGraphCommitVisible({ ...options, hashes: headHash ? [headHash] : [] });
}
