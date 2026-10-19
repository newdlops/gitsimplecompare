// git blame 표시 관련 명령 핸들러.
// - 명령 레이어는 VS Code command id 와 컨트롤러를 연결만 하고, 상태/decoration 로직은 provider 에 위임한다.
import type { CommandDeps } from "./shared";
import * as vscode from "vscode";
import path from "node:path";
import { SHOW_BLOCK_BLAME_COMMAND } from "../providers/blockBlameCodeLensPresentation";
import { showBlameLineHistory } from "../ui/lineHistoryPresenter";

/** Block Author 표시 토글과 단일 거터 닫기·줄 이력 명령만 등록한다. 거터 열기는 Code Vision 클릭이 담당한다. */
export function registerBlameCommands(deps: CommandDeps): vscode.Disposable[] {
  const group = (name: string, action: () => unknown) => [name, `${name}.checked`, `${name}.unchecked`]
    .map(command => vscode.commands.registerCommand(`gitSimpleCompare.${command}`, action));
  return [
    ...group("toggleBlameBlockVisible", () => deps.blockBlameCodeLens.toggleVisible()),
    vscode.commands.registerCommand(SHOW_BLOCK_BLAME_COMMAND, request => deps.blockBlamePresenter.show(request)),
    vscode.commands.registerCommand("gitSimpleCompare.hideBlameAnnotations", value => deps.blockBlamePresenter.hideFile(blameContext(value).uri)),
    vscode.commands.registerCommand("gitSimpleCompare.showLineHistory", value => showCurrentLineHistory(deps, value)),
  ];
}

/**
 * line-number 메뉴의 1-based 줄/URI 또는 명령 팔레트의 활성 selection을 해석한다.
 * @param value VS Code 메뉴가 전달한 URI 또는 {uri,lineNumber} @returns 실제 파일 리소스와 줄
 */
function blameContext(value?: unknown): { uri?: vscode.Uri; line: number } {
  const context = value as { uri?: vscode.Uri; scheme?: string; lineNumber?: number } | undefined;
  const active = vscode.window.activeTextEditor;
  const uri = context?.uri?.scheme ? context.uri : context?.scheme ? value as vscode.Uri : active?.document.uri;
  const explicit = context?.lineNumber;
  return { uri, line: Number.isSafeInteger(explicit) && explicit! > 0 ? explicit! : (active?.selection.active.line ?? 0) + 1 };
}

/**
 * 현재 파일을 저장소에 연결한 뒤 줄 이력의 검증·조회·표시는 재사용 UI 서비스에 위임한다.
 * @param deps 저장소 레지스트리 @param value 메뉴 컨텍스트 또는 활성 에디터 기본값
 */
async function showCurrentLineHistory(deps: CommandDeps, value?: unknown): Promise<void> {
  const { uri, line } = blameContext(value);
  if (!uri || uri.scheme !== "file") return;
  const service = await deps.registry.resolve(path.dirname(uri.fsPath));
  if (!service) { vscode.window.showInformationMessage(vscode.l10n.t("This file is not inside a git repository.")); return; }
  await showBlameLineHistory({ repoRoot: service.repoRoot, uri, line });
}
