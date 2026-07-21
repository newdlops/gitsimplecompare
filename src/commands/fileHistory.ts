// History 섹션 관련 명령 — 활성 에디터 파일의 커밋 목록 조회와 커밋 diff 열기.
// - 저장소 탐지/사용자 메시지는 명령 레이어에서 처리하고, 실제 git log 조회는 FileHistoryService 에 맡긴다.
import * as vscode from "vscode";
import { EMPTY_TREE_REF, FileHistoryService } from "../git/fileHistoryService";
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

interface FileHistoryCacheEntry {
  repoRoot: string;
  path: string;
  commits: Awaited<ReturnType<FileHistoryService["listFileHistory"]>>;
  loadedAt: number;
}

const historyCache = new Map<string, FileHistoryCacheEntry>();
const pendingLoads = new Map<string, Promise<FileHistoryCacheEntry>>();
const MAX_HISTORY_CACHE_ENTRIES = 40;
let historyCacheGeneration = 0;
let latestHistoryRequestId = 0;

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
    deps.changesView.setFileHistory({ commits: [] });
    logInfo("file history skipped", { reason, reasonDetail: "no-active-file" });
    return;
  }
  const location = fileHistoryResourceLocation(uri);
  if (!location) {
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
  const repositoryLookupPath =
    location.kind === "workingFile"
      ? dirNameOf(location.fsPath)
      : location.repoRoot;
  const service = await deps.registry.resolve(repositoryLookupPath);
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
  const cacheKey = fileHistoryCacheKey(service.repoRoot, relPath);
  const forceReload = shouldForceHistoryReload(reason, request.force);
  if (forceReload) {
    invalidateHistoryCache(reason);
  }
  const cached = historyCache.get(cacheKey);
  if (cached && !forceReload) {
    deps.changesView.setFileHistory(cached);
    logInfo("file history cache hit", {
      reason,
      root: service.repoRoot,
      path: relPath,
      resourceKind: location.kind,
      commits: cached.commits.length,
      ageMs: Date.now() - cached.loadedAt,
    });
    return;
  }

  try {
    const entry = await loadFileHistoryCached(service.repoRoot, relPath, cacheKey);
    if (requestId !== latestHistoryRequestId) {
      logInfo("file history render skipped", {
        reason,
        root: service.repoRoot,
        path: relPath,
        reasonDetail: "superseded",
      });
      return;
    }
    deps.changesView.setFileHistory(entry);
    logInfo("file history refreshed", {
      reason,
      root: service.repoRoot,
      path: relPath,
      resourceKind: location.kind,
      commits: entry.commits.length,
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
 * 특정 파일의 캐시 키를 만든다.
 * @param repoRoot 저장소 루트
 * @param relPath 저장소 상대 경로
 */
function fileHistoryCacheKey(repoRoot: string, relPath: string): string {
  return `${repoRoot}\0${relPath}`;
}

/**
 * 히스토리를 반드시 다시 읽어야 하는 refresh 사유인지 판정한다.
 * - 탭 전환/뷰 재표시는 캐시를 쓰고, 수동 새로고침이나 ref 변경은 최신 커밋 목록을 다시 읽는다.
 * @param reason refresh 요청 사유
 * @param force 명시 강제 갱신 플래그
 */
function shouldForceHistoryReload(reason: string, force?: boolean): boolean {
  if (force) {
    return true;
  }
  return reason
    .split(",")
    .map((part) => part.trim())
    .some(
      (part) =>
        part === "command" ||
        part === "commit" ||
        part === "checkoutBranch" ||
        part.startsWith("branchOperation") ||
        part === "workspaceFolders" ||
        part.startsWith("git:") ||
        part.startsWith("commit:") ||
        part.startsWith("checkout:")
    );
}

/**
 * git ref 변경/수동 새로고침처럼 히스토리 기준이 바뀔 수 있는 이벤트에서 캐시를 비운다.
 * - 진행 중인 로드도 재사용하지 않도록 pending map 을 비우고 generation 을 올린다.
 * @param reason 캐시 무효화 사유
 */
function invalidateHistoryCache(reason: string): void {
  if (!historyCache.size && !pendingLoads.size) {
    return;
  }
  historyCache.clear();
  pendingLoads.clear();
  historyCacheGeneration++;
  logInfo("file history cache invalidated", { reason });
}

/**
 * 같은 파일의 중복 로드를 합치면서 git history 를 읽고 캐시에 저장한다.
 * @param repoRoot 저장소 루트
 * @param relPath 저장소 상대 경로
 * @param cacheKey 캐시 키
 */
async function loadFileHistoryCached(
  repoRoot: string,
  relPath: string,
  cacheKey: string
): Promise<FileHistoryCacheEntry> {
  const pending = pendingLoads.get(cacheKey);
  if (pending) {
    return pending;
  }
  const generation = historyCacheGeneration;
  const promise = new FileHistoryService(repoRoot)
    .listFileHistory(relPath)
    .then((commits) => {
      const entry = { repoRoot, path: relPath, commits, loadedAt: Date.now() };
      if (generation === historyCacheGeneration) {
        historyCache.set(cacheKey, entry);
        pruneHistoryCache();
      }
      return entry;
    })
    .finally(() => {
      pendingLoads.delete(cacheKey);
    });
  pendingLoads.set(cacheKey, promise);
  return promise;
}

/**
 * 히스토리 캐시가 과도하게 커지지 않도록 오래된 항목부터 제거한다.
 */
function pruneHistoryCache(): void {
  while (historyCache.size > MAX_HISTORY_CACHE_ENTRIES) {
    const oldest = [...historyCache.entries()].sort(
      (a, b) => a[1].loadedAt - b[1].loadedAt
    )[0]?.[0];
    if (!oldest) {
      return;
    }
    historyCache.delete(oldest);
  }
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
