// 기존 native Conflicts 트리에 임시 PR 작업의 대상과 다음 행동을 표시한다.
import * as vscode from "vscode";
import type { GitServiceRegistry } from "../git/serviceRegistry";
import { ConflictsController } from "./conflictsController";
import type { ConflictsTreeProvider } from "./conflictsTreeProvider";

/**
 * 트리 표시와 상태 조회를 연결하고 PR 복구 동안만 원래 branch/HEAD와 해결 상태를 안내한다.
 * @param registry 저장소 탐지 서비스 @param provider 충돌 파일 목록 provider
 * @param tree native 제목·toolbar·메시지를 표시할 기존 TreeView
 * @returns 명령과 watcher가 공유할 ConflictsController
 */
export function createConflictsTreeController(
  registry: GitServiceRegistry, provider: ConflictsTreeProvider, tree: vscode.TreeView<string>
): ConflictsController {
  return new ConflictsController(registry, provider, (recovery, count) => {
    tree.message = recovery
      ? recovery.phase === "replaying"
        ? vscode.l10n.t("PR #{0} replay was interrupted. Inspect its preserved worktree before continuing.", recovery.pr.number)
        : count > 0
          ? vscode.l10n.t("PR #{0} → {1} · {2} conflict(s) in a temporary worktree. Resolve them, then Continue PR Operation.", recovery.pr.number, recovery.branch, count)
          : vscode.l10n.t("PR #{0} → {1} · Resolutions ready. Continue PR Operation to apply the result. Original local changes are preserved.", recovery.pr.number, recovery.branch)
      : undefined;
  });
}
