// History 섹션 관련 명령 — 활성 에디터 파일의 커밋 목록 조회와 커밋 diff 열기.
// - 저장소 탐지/사용자 메시지는 명령 레이어에서 처리하고, 실제 git log 조회는 FileHistoryService 에 맡긴다.
import * as vscode from "vscode";
import { EMPTY_TREE_REF } from "../git/fileHistoryService";
import { readFileHistorySnapshot } from "../git/fileHistoryReadCache";
import { openRefVsRefDiff } from "../ui/diffPresenter";
import { logError, logInfo } from "../ui/outputLog";
import { fileHistoryResourceLocation } from "../utils/fileHistoryResource";
import { CommandDeps } from "./shared";

/** 파일 히스토리 refresh 요청 출처. */
export interface FileHistoryRefreshRequest {
  reason?: string;
  uri?: vscode.Uri;
  force?: boolean;
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

let latestHistoryRequestId = 0;
let activeHistory: { key: string; controller: AbortController; cancelDisplay?: () => void } | undefined;

/**
 * 탭/창/Host의 소비자 수명을 실제 Git 조회 신호로 연결한다.
 * @returns 확장 dispose 때 소비자와 모든 이벤트 구독을 해제하는 Disposable
 */
export function registerFileHistoryLifetime(): vscode.Disposable {
  const subscriptions = [
    vscode.window.onDidChangeWindowState(state => { if (!state.focused) cancelFileHistoryRefresh("window-unfocused"); }),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      const key = editor?.document.uri ? historyResourceKey(editor.document.uri) : undefined;
      if (activeHistory && activeHistory.key !== key) cancelFileHistoryRefresh("active-editor-changed");
    }),
  ];
  return new vscode.Disposable(() => { cancelFileHistoryRefresh("extension-dispose"); for (const subscription of subscriptions) subscription.dispose(); });
}

/** 선택을 잃은 소비자만 취소하고 오래된 성공·오류가 새 파일의 UI를 바꾸지 않게 한다. */
export function cancelFileHistoryRefresh(reason: string): void {
  latestHistoryRequestId++;
  if (activeHistory) { activeHistory.controller.abort(); activeHistory.cancelDisplay?.(); activeHistory = undefined; logInfo("file history consumer cancelled", { reason }); }
}

/** 파일/가상 diff 리소스의 같은 실제 대상은 같은 소비자 신호를 공유한다. */
function historyResourceKey(uri: vscode.Uri): string | undefined {
  const location = fileHistoryResourceLocation(uri);
  return location?.kind === "workingFile" ? location.fsPath : location ? `${location.repoRoot}\0${location.relPath}` : undefined;
}

/**
 * 현재 활성 에디터 파일의 git history 를 읽어 Changes 웹뷰 History 섹션에 반영한다.
 * - 실제 작업 파일뿐 아니라 삭제 diff에 남은 ref 가상 문서도 원래 저장소 경로로 해석한다.
 * - background refresh 에서 호출되므로 저장소가 없거나 지원하지 않는 문서여도 경고 팝업은 띄우지 않는다.
 * - 사용자가 다른 탭으로 이동한 경우 현재 탭 기준으로 즉시 교체된다.
 * @param deps 공유 의존성
 * @param request refresh 사유와 명시 URI(없으면 활성 에디터)
 */
export async function refreshFileHistory(
  deps: CommandDeps,
  request: FileHistoryRefreshRequest = {}
): Promise<void> {
  const requestId = ++latestHistoryRequestId;
  const started = Date.now();
  const reason = request.reason ?? "command";
  const uri = request.uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri) {
    cancelFileHistoryRefresh("no-active-file");
    deps.changesView.setFileHistory({ commits: [] });
    logInfo("file history skipped", { reason, reasonDetail: "no-active-file" });
    return;
  }
  const location = fileHistoryResourceLocation(uri);
  if (!location) {
    cancelFileHistoryRefresh("unsupported-resource");
    deps.changesView.setFileHistory({
      commits: [],
      message: vscode.l10n.t(
        "History is available for repository files only."
      ),
    });
    logInfo("file history skipped", {
      reason,
      reasonDetail: "unsupported-resource",
      scheme: uri.scheme,
    });
    return;
  }
  const key = historyResourceKey(uri)!;
  if (activeHistory?.key !== key) {
    activeHistory?.controller.abort();
    activeHistory = { key, controller: new AbortController() };
  }
  const signal = activeHistory.controller.signal;
  const repositoryLookupPath =
    location.kind === "workingFile"
      ? dirNameOf(location.fsPath)
      : location.repoRoot;
  const service = await deps.registry.resolve(repositoryLookupPath);
  if (requestId !== latestHistoryRequestId || signal.aborted) return;
  if (!service) {
    deps.changesView.setFileHistory({
      commits: [],
      message: vscode.l10n.t("This file is not inside a git repository."),
    });
    logInfo("file history skipped", {
      reason,
      reasonDetail: "not-a-repository",
      path: repositoryLookupPath,
      resourceKind: location.kind,
    });
    return;
  }

  const relPath =
    location.kind === "workingFile"
      ? service.toRepoRelative(location.fsPath)
      : location.relPath;
  let partial = false;
  activeHistory.cancelDisplay = () => {
    if (partial) deps.changesView.setFileHistory({ repoRoot: service.repoRoot, path: relPath, commits: [],
      message: vscode.l10n.t("History loading paused. Refresh to load all commits.") });
  };
  try {
    const entry = await readFileHistorySnapshot(service.repoRoot, relPath, { signal, force: request.force, onProgress: snapshot => {
      if (requestId !== latestHistoryRequestId || signal.aborted) return;
      partial = true; deps.changesView.setFileHistory(snapshot);
      if (snapshot.commits.length) logInfo("file history first render ready", { reason, root: service.repoRoot,
        path: relPath, commits: snapshot.commits.length, elapsed: Date.now() - started });
    } });
    if (requestId !== latestHistoryRequestId || signal.aborted) {
      logInfo("file history render skipped", {
        reason,
        root: service.repoRoot,
        path: relPath,
        reasonDetail: "superseded",
      });
      return;
    }
    partial = false; deps.changesView.setFileHistory(entry);
    logInfo("file history refreshed", {
      reason,
      root: service.repoRoot,
      path: relPath,
      resourceKind: location.kind,
      commits: entry.commits.length,
      source: entry.source,
      elapsed: Date.now() - started,
    });
  } catch (error) {
    partial = false;
    if (signal.aborted || requestId !== latestHistoryRequestId || error instanceof Error && error.name === "AbortError") {
      logInfo("file history render skipped", { reason, reasonDetail: "cancelled-or-superseded" }); return;
    }
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
