// Git Graph 첫 페이지가 느린 저장소에 commit-graph 생성을 제안하는 UI 모듈.
// - 조용히 저장소에 쓰지 않는다. 느리고(commit-graph 없음) 사용자가 동의할 때만 `git commit-graph write` 를 실행한다.
// - 저장소별로 세션당 한 번만 묻고, "다시 묻지 않기"는 저장소 로컬 git config 에 남긴다.
import * as path from "node:path";
import * as vscode from "vscode";
import {
  hasCommitGraph,
  isCommitGraphOfferSuppressed,
  suppressCommitGraphOffer,
  writeCommitGraph,
} from "../git/commitGraphStatus";
import { logInfo, showErrorWithOutput } from "./outputLog";

/** 첫 페이지 git log 가 이 시간(ms) 이상 걸릴 때만 제안한다. commit-graph 가 있으면 보통 수십~100ms 대다. */
export const COMMIT_GRAPH_OFFER_MIN_LOG_MS = 400;

const consideredRepositories = new Set<string>();

/**
 * commit-graph 제안을 검토할 가치가 있는지 판단한다(순수).
 * @param gitLogMs 첫 페이지 git log 소요 시간
 * @param alreadyConsidered 이번 세션에 이 저장소를 이미 검토했는지
 * @returns 파일 확인과 알림으로 넘어가도 되면 true
 */
export function shouldConsiderCommitGraphOffer(gitLogMs: number, alreadyConsidered: boolean): boolean {
  return !alreadyConsidered && gitLogMs >= COMMIT_GRAPH_OFFER_MIN_LOG_MS;
}

/**
 * 첫 페이지가 느리고 commit-graph 가 없으면 생성을 제안한다.
 * - 세션당 저장소 한 번만 검토하므로 페이지마다 파일 확인이나 알림이 반복되지 않는다.
 * - 생성이 끝나면 다음 새로고침부터 빨라짐을 알리고, 실패하면 OUTPUT 과 함께 오류를 보여 준다.
 * @param repoRoot 저장소 루트
 * @param gitLogMs 첫 페이지 git log 소요 시간
 */
export async function offerCommitGraphIfSlow(repoRoot: string, gitLogMs: number): Promise<void> {
  if (!shouldConsiderCommitGraphOffer(gitLogMs, consideredRepositories.has(repoRoot))) {
    return;
  }
  consideredRepositories.add(repoRoot);
  try {
    if (await isCommitGraphOfferSuppressed(repoRoot) || await hasCommitGraph(repoRoot)) {
      return;
    }
  } catch {
    return;
  }
  logInfo("graph commit-graph offer shown", { repoRoot, gitLogMs });
  const write = vscode.l10n.t("Write commit-graph");
  const never = vscode.l10n.t("Don't Ask Again");
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "Loading history in '{0}' took {1} ms because the repository has no commit-graph. Write one to make the Git Graph load faster? This runs 'git commit-graph write --reachable'.",
      path.basename(repoRoot),
      gitLogMs
    ),
    write,
    never
  );
  if (choice === never) {
    await suppressCommitGraphOffer(repoRoot).catch(() => undefined);
    return;
  }
  if (choice !== write) {
    return;
  }
  const started = Date.now();
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Writing commit-graph...") },
      () => writeCommitGraph(repoRoot)
    );
    logInfo("graph commit-graph written", { repoRoot, elapsedMs: Date.now() - started });
    void vscode.window.showInformationMessage(
      vscode.l10n.t("Commit-graph written. The Git Graph will load faster from the next refresh.")
    );
  } catch (error) {
    showErrorWithOutput(
      "graph commit-graph write failed",
      error,
      vscode.l10n.t("Could not write the commit-graph. See the Git Simple Compare output for details."),
      { repoRoot }
    );
  }
}
