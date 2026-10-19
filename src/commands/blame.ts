// git blame 표시 관련 명령 핸들러.
// - 명령 레이어는 VS Code command id 와 컨트롤러를 연결만 하고, 상태/decoration 로직은 provider 에 위임한다.
import type { CommandDeps } from "./shared";
import * as vscode from "vscode";
import path from "node:path";
import { SHOW_BLOCK_BLAME_COMMAND } from "../providers/blockBlameCodeLensPresentation";
import { showBlameLineHistory } from "../ui/lineHistoryPresenter";

/** toolbar의 기존 checked/unchecked 별칭과 새 파일 단위 동작을 한곳에서 등록한다. */
export function registerBlameCommands(deps: CommandDeps): vscode.Disposable[] {
  const group = (name: string, action: () => unknown) => [name, `${name}.checked`, `${name}.unchecked`]
    .map(command => vscode.commands.registerCommand(`gitSimpleCompare.${command}`, action));
  return [
    ...group("toggleBlameDecorator", () => toggleBlameDecorator(deps)),
    ...group("toggleBlameLineVisible", () => toggleBlameLineVisible(deps)),
    ...group("toggleBlameBlockVisible", () => deps.blockBlameCodeLens.toggleVisible()),
    vscode.commands.registerCommand(SHOW_BLOCK_BLAME_COMMAND, request => deps.blockBlamePresenter.show(request)),
    vscode.commands.registerCommand("gitSimpleCompare.toggleBlameAnnotations", value => deps.blockBlamePresenter.showFile(blameContext(value).uri)),
    vscode.commands.registerCommand("gitSimpleCompare.showBlameAnnotations", value => deps.blockBlamePresenter.showFile(blameContext(value).uri, "show")),
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

/**
 * 활성 에디터의 git blame decorator 를 켜거나 끈다.
 * @param deps 명령 공용 의존성
 */
export async function toggleBlameDecorator(deps: CommandDeps): Promise<void> {
  await deps.blameDecorations.toggleDecorator();
}

/**
 * 활성 에디터 왼쪽 라인 영역의 git blame 텍스트 표시를 켜거나 끈다.
 * @param deps 명령 공용 의존성
 */
export async function toggleBlameLineVisible(deps: CommandDeps): Promise<void> {
  await deps.blameDecorations.toggleLineVisible();
}
