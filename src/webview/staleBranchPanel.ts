// 로컬 브랜치 현황 패널의 수명주기와 삭제 후보 선택만 담당한다. 실제 Git 삭제는 명령 계층이 수행한다.
import * as vscode from "vscode";
import { basename } from "node:path";
import type { StaleBranch, StaleBranchInspection } from "../git/staleBranchService";
import { logInfo } from "../ui/outputLog";
import { buildStaleBranchHtml } from "./staleBranchHtml";

/** 로컬 브랜치 전체를 보여 주면서 삭제 가능한 stale 행만 다음 확인 단계로 전달한다. */
export class StaleBranchPanel {
  /**
   * 저장소에 고정된 현황 표를 열고 사용자가 검토할 삭제 후보를 기다린다.
   * @param extensionUri 설치된 확장의 미디어 루트
   * @param inspection 전체 로컬 현황과 삭제 재검증에 사용할 tip 스냅샷
   * @returns 선택한 stale 브랜치. 패널 닫기·취소는 undefined이며 Git 변경이 없다.
   */
  static pick(extensionUri: vscode.Uri, inspection: StaleBranchInspection): Promise<StaleBranch[] | undefined> {
    const panel = vscode.window.createWebviewPanel(
      "gitSimpleCompare.staleBranches",
      vscode.l10n.t("Local Branches — {0}", basename(inspection.repoRoot)),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")] },
    );
    logInfo("local branch status opened", { repoRoot: inspection.repoRoot, local: inspection.localBranches.length, stale: inspection.branches.length });
    return new Promise((resolve, reject) => {
      const subscriptions: vscode.Disposable[] = [];
      let finished = false;
      /** Promise와 패널을 한 번만 종료해 취소나 중복 메시지가 삭제 흐름을 재개하지 못하게 한다. */
      const finish = (selected?: StaleBranch[]) => {
        if (finished) return;
        finished = true;
        for (const subscription of subscriptions) subscription.dispose();
        panel.dispose();
        logInfo("local branch status closed", { repoRoot: inspection.repoRoot, selected: selected?.length ?? 0 });
        resolve(selected);
      };
      panel.onDidDispose(() => finish(), undefined, subscriptions);
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (finished || !message || typeof message !== "object") return;
        const value = message as { type?: unknown; names?: unknown };
        if (value.type === "cancel") { finish(); return; }
        if (value.type !== "select") return;
        const selected = selectedStaleBranches(inspection, value.names);
        if (!selected) {
          void panel.webview.postMessage({ type: "error", message: vscode.l10n.t("Select only removable stale local branches.") });
          return;
        }
        finish(selected);
      }, undefined, subscriptions);
      try { panel.webview.html = buildStaleBranchHtml(extensionUri, panel.webview, inspection); }
      catch (error) {
        finished = true;
        for (const subscription of subscriptions) subscription.dispose();
        panel.dispose();
        reject(error);
      }
    });
  }
}

/**
 * 웹뷰가 보낸 이름을 host 후보와 대조해 원격 존재·사용 중·임의 브랜치 선택을 차단한다.
 * @param inspection 이 패널이 실제 표시한 원본 조회 결과
 * @param names 신뢰하지 않는 웹뷰 선택 이름 배열
 * @returns 정확한 tip을 가진 후보 목록. 빈 값이나 하나라도 잘못된 이름이면 undefined다.
 */
export function selectedStaleBranches(inspection: StaleBranchInspection, names: unknown): StaleBranch[] | undefined {
  if (!Array.isArray(names) || !names.length || names.length > inspection.localBranches.length) return;
  const candidates = new Map(inspection.branches.filter(branch => !branch.inUse).map(branch => [branch.name, branch]));
  if (names.some(name => typeof name !== "string" || !candidates.has(name))) return;
  return [...new Set(names as string[])].map(name => candidates.get(name)!);
}
