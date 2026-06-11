// Stash 섹션 관련 명령 — 목록 조회 + 선택 파일 stash + apply/pop/drop/branch + 파일 보기.
// - stash 의 파일 목록은 해시 기준으로 캐시해, 잦은 새로고침에도 `git stash show` 를 반복하지 않는다
//   (stash 목록 1회 조회만으로 끝나고, 새 stash 가 생겼을 때만 파일을 읽는다).
// - 로직은 GitService 에 두고 여기서는 조립 + 사용자 입력/확인/알림만 담당한다(경계 분리).
import * as vscode from "vscode";
import { CommandDeps } from "./shared";
import { GitService } from "../git/gitService";
import { FileChange, StashEntry } from "../git/gitTypes";
import { openRefVsRefDiff } from "../ui/diffPresenter";

/** 웹뷰로 보낼 stash(목록 항목 + 담긴 파일 목록). */
export type StashView = StashEntry & { files: FileChange[] };

/** `${root}@${hash}` → 파일 목록 캐시(해시가 같으면 재사용). */
const fileCache = new Map<string, FileChange[]>();

/** 활성 저장소의 GitService(없으면 undefined). */
function activeService(deps: CommandDeps): GitService | undefined {
  const root = deps.changesView.getActiveRepo();
  return root ? deps.registry.get(root) : undefined;
}

/** 짧은 에러 메시지 추출. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * stash 목록(+ 각 stash 의 파일)을 다시 읽어 Stashes 섹션을 갱신한다.
 * - 파일은 해시 캐시에서 재사용하고, 없을 때만 `git stash show` 로 읽는다.
 * @param deps 공유 의존성
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
    // 더 이상 없는 해시의 캐시는 정리한다.
    const valid = new Set(entries.map((e) => `${root}@${e.hash}`));
    for (const key of [...fileCache.keys()]) {
      if (key.startsWith(`${root}@`) && !valid.has(key)) {
        fileCache.delete(key);
      }
    }
    const views: StashView[] = await Promise.all(
      entries.map(async (e) => {
        const key = `${root}@${e.hash}`;
        let files = fileCache.get(key);
        if (!files) {
          files = await svc.stashShowFiles(e.ref);
          fileCache.set(key, files);
        }
        return { ...e, files };
      })
    );
    deps.changesView.setStashes(views);
  } catch {
    deps.changesView.setStashes([]);
  }
}

/** 작업트리 + stash 를 함께 새로고친다(stash 가 작업트리를 바꾸는 동작 뒤에 호출). */
function refreshAll(deps: CommandDeps): void {
  void vscode.commands.executeCommand("gitSimpleCompare.refreshWorkingChanges");
  void refreshStashes(deps);
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
  refreshAll(deps);
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
  refreshAll(deps);
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
  refreshAll(deps);
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
  refreshAll(deps);
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
  refreshAll(deps);
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
