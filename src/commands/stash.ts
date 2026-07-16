// Stash 섹션 관련 명령 — 목록 조회 + 선택 파일 stash + apply/pop/drop/branch + 파일 보기.
// - 초기 새로고침은 stash 메타데이터만 읽고, 파일 목록은 사용자가 항목을 펼칠 때 해당 stash 만 조회한다.
// - 한 번 읽은 파일 목록은 해시 기준으로 캐시해, 이후 펼침/새로고침에서 `git stash show` 를 반복하지 않는다.
// - 로직은 GitService 에 두고 여기서는 조립 + 사용자 입력/확인/알림만 담당한다(경계 분리).
import * as vscode from "vscode";
import { CommandDeps } from "./shared";
import { GitService } from "../git/gitService";
import { GitError } from "../git/gitExec";
import { FileChange, StashEntry } from "../git/gitTypes";
import { openRefVsRefDiff } from "../ui/diffPresenter";
import { logError, logInfo } from "../ui/outputLog";

/** 웹뷰의 일반 render payload로 보낼 stash 메타데이터. 파일 목록은 직접 메시지로 분리한다. */
export type StashView = StashEntry;

/** 웹뷰에 직접 전달할 stash 한 건의 지연 파일 조회 결과. */
export interface StashFilesLoadResult {
  ref: string;
  key: string;
  files: FileChange[];
}

/** `${root}@${ref}@${hash}` → 파일 목록 캐시(같은 stash 항목이면 재사용). */
const fileCache = new Map<string, FileChange[]>();

/** 동일 stash 가 렌더 사이에 다시 요청돼도 하나의 git 프로세스만 기다리게 하는 진행 중 조회 맵. */
const fileLoads = new Map<string, Promise<FileChange[]>>();

/**
 * Changes 뷰가 선택한 활성 저장소의 GitService 를 찾는다.
 * @param deps 저장소 레지스트리와 뷰 상태를 담은 공유 의존성
 * @returns 활성 저장소가 등록돼 있으면 서비스, 아직 선택되지 않았으면 undefined
 */
function activeService(deps: CommandDeps): GitService | undefined {
  const root = deps.changesView.getActiveRepo();
  return root ? deps.registry.get(root) : undefined;
}

/**
 * Git 명령 또는 일반 예외에서 사용자에게 보여 줄 짧은 오류 문구를 만든다.
 * @param e GitError 또는 임의의 예외 값
 * @returns stderr/stdout/message 중 의미 있는 내용을 합친 문자열
 */
function errText(e: unknown): string {
  if (e instanceof GitError) {
    return [e.stderr.trim(), e.stdout.trim(), e.message]
      .filter(Boolean)
      .join("\n");
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * stash 한 개의 파일 목록을 읽고 캐시에 저장한다.
 * - 긴 조회 중 다른 상태 렌더가 DOM 을 교체해 같은 ref 를 다시 요청해도 진행 중 Promise 를 공유한다.
 * - 성공한 빈 배열도 유효한 캐시 값으로 보존하며, 실패한 Promise 는 제거해 다음 펼침에서 재시도한다.
 * @param svc 실제 `git stash show` 를 실행할 활성 저장소 서비스
 * @param root 로그와 저장소별 캐시 구분에 사용하는 저장소 루트
 * @param entry 파일을 읽을 stash 메타데이터
 * @param key root/ref/hash 로 만든 캐시 및 진행 중 조회 키
 * @returns 해당 stash 에 포함된 파일 변경 목록
 */
async function loadStashFiles(
  svc: GitService,
  root: string,
  entry: StashEntry,
  key: string
): Promise<FileChange[]> {
  const cached = fileCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const existing = fileLoads.get(key);
  if (existing) {
    return existing;
  }
  logInfo("stash files load started", { root, ref: entry.ref });
  const load = svc
    // ref 번호는 drop/pop으로 바뀔 수 있으므로 목록에서 확정한 hash를 사용해 다른 stash를 읽지 않는다.
    .stashShowFiles(entry.hash || entry.ref)
    .then((files) => {
      fileCache.set(key, files);
      logInfo("stash files load completed", {
        root,
        ref: entry.ref,
        files: files.length,
      });
      return files;
    })
    .catch((error) => {
      logError("stash files load failed", error, { root, ref: entry.ref });
      throw error;
    })
    .finally(() => {
      fileLoads.delete(key);
    });
  fileLoads.set(key, load);
  return load;
}

/**
 * stash 메타데이터만 다시 읽어 Stashes 섹션을 갱신한다.
 * - 파일 배열은 provider 상태에 보관하지 않아 한 번 펼친 대형 stash가 이후 모든 render payload를 키우지 않는다.
 * - 파일 캐시는 별도로 유지하며 loadStashFilesForView가 실제 펼침 요청에만 직접 반환한다.
 * @param deps 저장소 레지스트리와 Changes 뷰를 포함한 공유 의존성
 * @returns 메타데이터가 현재 활성 저장소의 뷰에 반영되면 완료되는 Promise
 */
export async function refreshStashes(deps: CommandDeps): Promise<void> {
  const root = deps.changesView.getActiveRepo();
  const svc = root ? deps.registry.get(root) : undefined;
  if (!svc || !root) {
    deps.changesView.setStashes([]);
    return;
  }
  try {
    const entries = await svc.listStashes();
    logInfo("stashes listed", { root, count: entries.length });
    // 더 이상 없는 stash 항목의 파일 캐시는 정리한다.
    const valid = new Set(entries.map((e) => stashFileCacheKey(root, e)));
    for (const key of [...fileCache.keys()]) {
      if (key.startsWith(`${root}@`) && !valid.has(key)) {
        fileCache.delete(key);
      }
    }
    const views: StashView[] = entries;
    logInfo("stashes rendered", {
      root,
      count: views.length,
    });
    if (deps.changesView.getActiveRepo() !== root) {
      logInfo("stashes result skipped", {
        root,
        activeRoot: deps.changesView.getActiveRepo(),
        reason: "repository-changed",
      });
      return;
    }
    deps.changesView.setStashes(views);
  } catch (error) {
    logError("stashes refresh failed", error, { root });
    if (deps.changesView.getActiveRepo() === root) {
      deps.changesView.setStashes([]);
    }
  }
}

/**
 * 사용자가 펼친 stash 하나의 파일만 읽어 웹뷰 직접 메시지용 결과를 반환한다.
 * - 목록에서 얻은 hash로 `stash show`를 실행해 조회 중 drop/pop이 ref 번호를 바꿔도 다른 stash를 읽지 않는다.
 * - provider의 metadata 상태는 수정하지 않으므로 느린 결과가 새 stash 목록을 덮어쓸 수 없다.
 * @param deps 현재 활성 저장소와 GitService를 찾을 공유 의존성
 * @param requestedRef 웹뷰가 펼친 시점의 stash ref
 * @returns hash 기반 key와 파일 목록, ref가 사라졌거나 저장소가 바뀌면 undefined
 */
export async function loadStashFilesForView(
  deps: CommandDeps,
  requestedRef: string
): Promise<StashFilesLoadResult | undefined> {
  const root = deps.changesView.getActiveRepo();
  const svc = root ? deps.registry.get(root) : undefined;
  if (!root || !svc || !requestedRef) {
    return undefined;
  }
  const entries = await svc.listStashes();
  const entry = entries.find((candidate) => candidate.ref === requestedRef);
  if (!entry) {
    return undefined;
  }
  const files = await loadStashFiles(
    svc,
    root,
    entry,
    stashFileCacheKey(root, entry)
  );
  if (deps.changesView.getActiveRepo() !== root) {
    logInfo("stash files result skipped", {
      root,
      activeRoot: deps.changesView.getActiveRepo(),
      ref: requestedRef,
      reason: "repository-changed",
    });
    return undefined;
  }
  return {
    ref: requestedRef,
    key: entry.hash || entry.ref || String(entry.index),
    files,
  };
}

/**
 * 저장소와 stash 항목을 함께 묶어 파일 목록 캐시 키를 만든다.
 * @param root stash 를 소유한 저장소 루트
 * @param entry ref/hash/index 를 가진 stash 메타데이터
 * @returns 저장소 전환과 stash 번호 이동을 구분할 수 있는 캐시 키
 */
function stashFileCacheKey(root: string, entry: StashEntry): string {
  return `${root}@${entry.ref}@${entry.hash || entry.index}`;
}

/**
 * stash 변경 뒤 작업트리, stash, ref, 비교 결과를 하나의 전체 새로고침으로 동기화한다.
 * @returns 반환값 없이 명령 큐에 새로고침을 예약한다
 */
function refreshAll(): void {
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges");
}

/**
 * 선택한 파일(없으면 전체)을 stash 한다. 메시지를 입력받는다(빈 값 허용, 취소면 중단).
 * @param deps  공유 의존성
 * @param paths stash 할 경로(빈/undefined 면 전체 변경)
 */
export async function stashSelected(
  deps: CommandDeps,
  paths?: string[]
): Promise<void> {
  const svc = activeService(deps);
  if (!svc) {
    return;
  }
  const message = await vscode.window.showInputBox({
    title:
      paths && paths.length
        ? vscode.l10n.t("Stash {0} selected file(s)", paths.length)
        : vscode.l10n.t("Stash all changes"),
    prompt: vscode.l10n.t("Optional stash message"),
    placeHolder: vscode.l10n.t("Stash message"),
  });
  if (message === undefined) {
    return; // 취소
  }
  try {
    await svc.stashPush(paths ?? [], message || undefined);
  } catch (e) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Action failed: {0}", errText(e))
    );
  }
  refreshAll();
}

/** stash 를 작업트리에 적용한다(목록 유지). */
export async function applyStash(deps: CommandDeps, ref: string): Promise<void> {
  const svc = activeService(deps);
  if (!svc || !ref) {
    return;
  }
  try {
    await svc.stashApply(ref);
  } catch (e) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Action failed: {0}", errText(e))
    );
  }
  refreshAll();
}

/** stash 를 적용하고 목록에서 제거한다(pop). */
export async function popStash(deps: CommandDeps, ref: string): Promise<void> {
  const svc = activeService(deps);
  if (!svc || !ref) {
    return;
  }
  try {
    await svc.stashPop(ref);
  } catch (e) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Action failed: {0}", errText(e))
    );
  }
  refreshAll();
}

/** stash 를 버린다(모달 확인). */
export async function dropStash(
  deps: CommandDeps,
  ref: string,
  message?: string
): Promise<void> {
  const svc = activeService(deps);
  if (!svc || !ref) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("Drop stash '{0}'? This is irreversible.", message || ref),
    { modal: true },
    vscode.l10n.t("Drop Stash")
  );
  if (!choice) {
    return;
  }
  try {
    await svc.stashDrop(ref);
  } catch (e) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Action failed: {0}", errText(e))
    );
  }
  refreshAll();
}

/** stash 를 새 브랜치로 펼친다(브랜치 이름 입력). */
export async function branchStash(
  deps: CommandDeps,
  ref: string
): Promise<void> {
  const svc = activeService(deps);
  if (!svc || !ref) {
    return;
  }
  const name = await vscode.window.showInputBox({
    title: vscode.l10n.t("Create Branch from Stash"),
    prompt: vscode.l10n.t("New branch name"),
  });
  if (!name) {
    return;
  }
  try {
    await svc.stashBranch(name, ref);
  } catch (e) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Action failed: {0}", errText(e))
    );
  }
  refreshAll();
}

/**
 * stash 안의 파일 변경을 읽기 전용 diff 로 연다(stash 부모 ↔ stash).
 * @param deps 공유 의존성
 * @param arg  { ref, path } stash 참조와 저장소 상대 경로
 */
export async function openStashFile(
  deps: CommandDeps,
  arg: { ref: string; path: string }
): Promise<void> {
  const root = deps.changesView.getActiveRepo();
  if (!root || !arg?.ref || !arg?.path) {
    return;
  }
  const fileName = arg.path.slice(arg.path.lastIndexOf("/") + 1);
  // stash 커밋의 첫 부모(^1)는 stash 가 만들어진 시점의 상태다.
  await openRefVsRefDiff(root, `${arg.ref}^1`, arg.ref, arg.path, fileName);
}
