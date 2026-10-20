// PR/reflog 점프의 비동기 결과를 현재 패널 세대에만 게시하는 공통 경계다.
import type { GraphCommitWindowResult } from "./graphCommitWindowLoading";
import { logInfo } from "../ui/outputLog";

/** 점프의 Git 읽기와 패널 상태 효과를 분리해 늦은 결과/finally가 새 세대를 침범하지 않게 한다. */
export interface GraphWindowRequest {
  repoRoot: string;
  cause: string;
  read(): Promise<GraphCommitWindowResult | undefined>;
  current(): boolean;
  accept(window: GraphCommitWindowResult): void;
  finish(): void;
}

/**
 * 현재 세대에서 실제로 찾은 window만 게시한다. 실패해도 소유 세대의 로딩 상태는 정리한다.
 * @param request 읽기, 세대 확인과 UI 효과 @returns 표시한 hash. 취소/범위 밖이면 undefined
 */
export async function executeGraphWindowRequest(request: GraphWindowRequest): Promise<string | undefined> {
  try {
    const window = await request.read();
    if (!request.current() || !window) return undefined;
    request.accept(window);
    logInfo("graph commit window sent", { repoRoot: request.repoRoot, cause: request.cause, hash: window.hash,
      count: window.commits.length, rangeStartIndex: window.startIndex, totalCount: window.totalCount });
    return window.hash;
  } finally { if (request.current()) request.finish(); }
}
