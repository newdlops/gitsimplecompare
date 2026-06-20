// git graph 검색 요청을 처리하는 웹뷰 액션 모듈.
// - GraphPanel 은 메시지 라우팅만 담당하고, repository-wide 검색/fetch 흐름은 여기로 분리한다.
import * as vscode from "vscode";
import {
  GraphRepositorySearchScope,
  GraphSearchService,
} from "../git/graphSearchService";
import { GitLogService } from "../git/gitLogService";
import { logError, logInfo } from "../ui/outputLog";
import { GraphSearchFetchTarget, ToWebviewMessage } from "./graphProtocol";

/** graph 검색 액션에 필요한 패널 콜백 묶음 */
export interface GraphSearchActionDeps {
  logService: GitLogService;
  post(message: ToWebviewMessage): void;
  refreshGraph(): Promise<void>;
}

/**
 * 검색창의 repository-wide 검색 요청을 처리해 웹뷰로 돌려보낸다.
 * @param deps graph 패널 상태/전송 콜백
 * @param requestId 웹뷰가 최신 응답만 적용하기 위해 붙인 요청 ID
 * @param query 사용자가 입력한 검색어
 * @param scope 검색할 대상 종류. all 이면 commit/hash/branch/tag 를 모두 검색한다.
 */
export async function sendGraphRepositorySearch(
  deps: Pick<GraphSearchActionDeps, "logService" | "post">,
  requestId: string,
  query: string,
  scope?: GraphRepositorySearchScope
): Promise<void> {
  try {
    const result = await new GraphSearchService(deps.logService.repoRoot).search(query, { scope });
    deps.post({ type: "graphRepositorySearchResult", requestId, result });
    logInfo("graph repository search completed", {
      repoRoot: deps.logService.repoRoot,
      requestId,
      query,
      scope: result.scope,
      matches: result.matches.length,
      skippedCommitSearch: result.skippedCommitSearch,
      elapsedMs: result.elapsedMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.post({ type: "graphRepositorySearchError", requestId, query, message });
    logError("graph repository search failed", err, {
      repoRoot: deps.logService.repoRoot,
      requestId,
      query,
      scope,
    });
  }
}

/**
 * 사용자가 명시적으로 요청했을 때만 remote-tracking ref 를 fetch 하고 같은 검색어를 다시 검색한다.
 * @param deps graph 패널 상태/전송/갱신 콜백
 * @param requestId fetch 뒤 재검색 응답에 유지할 요청 ID
 * @param query fetch 완료 뒤 다시 실행할 검색어
 * @param scope fetch 완료 뒤 다시 실행할 검색 범위
 * @param target 최신화할 ref 종류. tags 면 tag 만 가져온다.
 */
export async function fetchRefsForGraphSearch(
  deps: GraphSearchActionDeps,
  requestId: string,
  query: string,
  scope?: GraphRepositorySearchScope,
  target: GraphSearchFetchTarget = "refs"
): Promise<void> {
  try {
    logInfo("graph search fetch requested", {
      repoRoot: deps.logService.repoRoot,
      requestId,
      query,
      scope,
      target,
    });
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: target === "tags"
          ? vscode.l10n.t("Fetching tags...")
          : vscode.l10n.t("Fetching remote refs..."),
      },
      () => target === "tags" ? deps.logService.fetchTags() : deps.logService.fetchAll()
    );
    await deps.refreshGraph();
    vscode.window.showInformationMessage(
      target === "tags"
        ? vscode.l10n.t("Tags fetched.")
        : vscode.l10n.t("Remote refs fetched.")
    );
    await sendGraphRepositorySearch(deps, requestId, query, scope);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.post({ type: "graphRepositorySearchError", requestId, query, message });
    logError("graph search fetch failed", err, {
      repoRoot: deps.logService.repoRoot,
      requestId,
      query,
      scope,
      target,
    });
  }
}
