// History 섹션 관련 명령 — 활성 에디터 파일의 커밋 목록 조회와 커밋 diff 열기.
// - 저장소 탐지/사용자 메시지는 명령 레이어에서 처리하고, 실제 git log 조회는 FileHistoryService 에 맡긴다.
import * as vscode from "vscode";
import { EMPTY_TREE_REF, FileHistoryService } from "../git/fileHistoryService";
import { openRefVsRefDiff } from "../ui/diffPresenter";
import { logError, logInfo } from "../ui/outputLog";
import { CommandDeps } from "./shared";

/** 파일 히스토리 refresh 요청 출처. */
export interface FileHistoryRefreshRequest {
  reason?: string;
  uri?: vscode.Uri;
}

/** History 커밋 클릭 시 diff 를 열기 위해 필요한 인자. */
export interface OpenFileHistoryCommitArgs {
  repoRoot: string;
  path: string;
  oldPath?: string;
  baseRef: string;
  headRef: string;
  shortHash?: string;
  title?: string;
}

/**
 * 현재 활성 에디터 파일의 git history 를 읽어 Changes 웹뷰 History 섹션에 반영한다.
 * - background refresh 에서 호출되므로 저장소가 없거나 로컬 파일이 아니어도 경고 팝업은 띄우지 않는다.
 * - 사용자가 다른 탭으로 이동한 경우 현재 탭 기준으로 즉시 교체된다.
 * @param deps 공유 의존성
 * @param request refresh 사유와 명시 URI(없으면 활성 에디터)
 */
export async function refreshFileHistory(
  deps: CommandDeps,
  request: FileHistoryRefreshRequest = {}
): Promise<void> {
  const started = Date.now();
  const reason = request.reason ?? "command";
  const uri = request.uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri) {
    deps.changesView.setFileHistory({ commits: [] });
    logInfo("file history skipped", { reason, reasonDetail: "no-active-file" });
    return;
  }
  if (uri.scheme !== "file") {
    deps.changesView.setFileHistory({
      commits: [],
      message: vscode.l10n.t("History is available for local files only."),
    });
    logInfo("file history skipped", {
      reason,
      reasonDetail: "non-file-uri",
      scheme: uri.scheme,
    });
    return;
  }
  const service = await deps.registry.resolve(dirNameOf(uri.fsPath));
  if (!service) {
    deps.changesView.setFileHistory({
      commits: [],
      message: vscode.l10n.t("This file is not inside a git repository."),
    });
    logInfo("file history skipped", {
      reason,
      reasonDetail: "not-a-repository",
      path: uri.fsPath,
    });
    return;
  }

  const relPath = service.toRepoRelative(uri.fsPath);
  try {
    const history = await new FileHistoryService(service.repoRoot).listFileHistory(
      relPath
    );
    deps.changesView.setFileHistory({
      repoRoot: service.repoRoot,
      path: relPath,
      commits: history,
    });
    logInfo("file history refreshed", {
      reason,
      root: service.repoRoot,
      path: relPath,
      commits: history.length,
      elapsed: Date.now() - started,
    });
  } catch (error) {
    deps.changesView.setFileHistory({
      repoRoot: service.repoRoot,
      path: relPath,
      commits: [],
      message: vscode.l10n.t("Could not load file history."),
    });
    logError("file history refresh failed", error, {
      reason,
      root: service.repoRoot,
      path: relPath,
    });
  }
}

/**
 * History 커밋 행을 클릭했을 때 해당 커밋에서 그 파일이 변한 diff 를 연다.
 * - 왼쪽은 첫 부모(또는 root commit 의 empty tree), 오른쪽은 클릭한 커밋이다.
 * - rename 은 oldPath 를 왼쪽 경로로 넘겨 부모 시점의 파일과 커밋 시점 파일을 비교한다.
 * @param arg 웹뷰가 넘긴 커밋 diff 인자
 */
export async function openFileHistoryCommit(
  arg: OpenFileHistoryCommitArgs
): Promise<void> {
  if (!arg?.repoRoot || !arg.path || !arg.baseRef || !arg.headRef) {
    return;
  }
  const label = baseName(arg.path);
  await openRefVsRefDiff(
    arg.repoRoot,
    arg.baseRef,
    arg.headRef,
    arg.path,
    label,
    arg.oldPath,
    {
      leftLabel:
        arg.baseRef === EMPTY_TREE_REF
          ? vscode.l10n.t("Empty Tree")
          : arg.baseRef.slice(0, 7),
      rightLabel: arg.shortHash || arg.headRef.slice(0, 7),
    }
  );
  logInfo("file history diff opened", {
    root: arg.repoRoot,
    path: arg.path,
    oldPath: arg.oldPath,
    commit: arg.headRef,
  });
}

/**
 * 경로에서 디렉터리 부분만 떼어낸다.
 * @param fsPath 파일 시스템 경로
 */
function dirNameOf(fsPath: string): string {
  const idx = Math.max(fsPath.lastIndexOf("/"), fsPath.lastIndexOf("\\"));
  return idx >= 0 ? fsPath.slice(0, idx) : fsPath;
}

/**
 * 파일 경로의 마지막 세그먼트를 반환한다.
 * @param relPath 저장소 상대 경로
 */
function baseName(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx >= 0 ? relPath.slice(idx + 1) : relPath;
}
