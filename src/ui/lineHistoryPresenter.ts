// 저장된 한 줄의 변경 이력을 네이티브 picker로 탐색하고 선택한 파일 diff를 연다.
import * as vscode from "vscode";
import path from "node:path";
import { LineHistoryService, type LineHistoryAnchor, type LineHistoryEntry, type LineHistoryPage } from "../git/lineHistoryService";
import { openRefVsRefDiff } from "./diffPresenter";
import { logError, logInfo } from "./outputLog";
import { EMPTY_TREE_REF } from "../git/gitTypes";

/** host에서 검증한 실제 문서와 원래 줄만 받으며 renderer가 Git 명령을 지정할 수 없게 한다. */
export interface BlameLineHistoryTarget { repoRoot: string; uri: vscode.Uri; line: number; revision?: number; anchor?: LineHistoryAnchor }
interface HistoryPick extends vscode.QuickPickItem { entry?: LineHistoryEntry; more?: boolean }

/**
 * 현재 줄을 불변 commit 위치에 고정하고 최대 30개씩 요청할 때만 이력을 늘린다.
 * @param target 메뉴/검증된 hover가 지정한 문서·줄·선택적 원래 blame 위치
 * @returns 취소·빈 결과·오류는 현재 문서를 바꾸지 않고 안내한 뒤 종료한다.
 */
export async function showBlameLineHistory(target: BlameLineHistoryTarget): Promise<void> {
  if (target.uri.scheme !== "file" || !Number.isSafeInteger(target.line) || target.line < 1) return;
  const document = await vscode.workspace.openTextDocument(target.uri);
  if (document.isDirty) { vscode.window.showInformationMessage(vscode.l10n.t("Save the file before viewing line history.")); return; }
  if (target.line > document.lineCount || target.revision !== undefined && document.version !== target.revision) {
    vscode.window.showInformationMessage(vscode.l10n.t("The file changed. Reopen line history from the current line.")); return;
  }
  const version = document.version, controller = new AbortController();
  const subscriptions = [
    vscode.workspace.onDidChangeTextDocument(event => { if (event.document.uri.toString() === target.uri.toString() && event.contentChanges.length) controller.abort(); }),
    vscode.workspace.onDidCloseTextDocument(closed => { if (closed.uri.toString() === target.uri.toString()) controller.abort(); }),
  ];
  let selected: LineHistoryEntry | undefined;
  try {
    const service = new LineHistoryService(target.repoRoot);
    let anchor = target.anchor, limit = 30;
    while (!controller.signal.aborted) {
      const page = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Loading history for line {0}…", target.line), cancellable: true }, async (_progress, token): Promise<LineHistoryPage> => {
        const cancel = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try {
          anchor ||= await service.anchor(target.uri.fsPath, target.line, controller.signal);
          return anchor ? await service.read(anchor, limit, controller.signal) : { entries: [], hasMore: false };
        } finally { cancel.dispose(); }
      });
      if (controller.signal.aborted || document.isDirty || document.version !== version) return;
      if (!page.entries.length) {
        vscode.window.showInformationMessage(vscode.l10n.t("No committed line history is available. The line may be new or untracked.")); return;
      }
      const picks: HistoryPick[] = page.entries.map(entry => ({
        label: `$(git-commit) ${entry.hash.slice(0, 8)} · ${entry.title.replace(/\s+/g, " ")}`,
        description: `${entry.author} · ${entry.dateIso.slice(0, 10)}`,
        detail: `${entry.path.replace(/\t/g, "\\t").replace(/\n/g, "\\n")} · ${vscode.l10n.t("Line {0}", entry.line)}`,
        entry,
      }));
      if (page.hasMore && limit < 200) picks.push({ label: `$(ellipsis) ${vscode.l10n.t("Load more line changes")}`, more: true });
      else if (page.hasMore) picks.push({ label: vscode.l10n.t("Showing the first {0} line changes", limit) });
      const choice = await vscode.window.showQuickPick(picks, {
        title: vscode.l10n.t("Line {0} history · {1}", target.line, path.basename(target.uri.fsPath)),
        placeHolder: vscode.l10n.t("Select a change to open its file diff. History follows the first parent."),
        matchOnDescription: true, matchOnDetail: true,
      });
      if (!choice) return;
      if (controller.signal.aborted || document.isDirty || document.version !== version) {
        vscode.window.showInformationMessage(vscode.l10n.t("The file changed. Reopen line history from the current line.")); return;
      }
      if (choice.more) { limit = Math.min(200, limit + 30); continue; }
      selected = choice.entry; break;
    }
  } catch (error) {
    if (controller.signal.aborted) { logInfo("blame line history cancelled", { path: target.uri.fsPath }); return; }
    logError("blame line history failed", error, { repoRoot: target.repoRoot, path: target.uri.fsPath, line: target.line });
    vscode.window.showErrorMessage(vscode.l10n.t("Could not load line history. See Git Simple Compare Output."));
  } finally { for (const subscription of subscriptions) subscription.dispose(); }
  if (!selected) return;
  const row = Math.max(0, selected.line - 1);
  await openRefVsRefDiff(target.repoRoot, selected.baseRef, selected.hash, selected.path, path.basename(selected.path), selected.oldPath,
    { leftLabel: selected.baseRef === EMPTY_TREE_REF ? vscode.l10n.t("Empty Tree") : selected.baseRef.slice(0, 8), rightLabel: selected.hash.slice(0, 8) },
    { selection: new vscode.Range(row, 0, row, 0) });
}
