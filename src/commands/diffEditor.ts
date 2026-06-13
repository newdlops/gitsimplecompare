// diff editor 에서 현재 비교 중인 작업 파일을 일반 파일 편집기로 여는 명령 모듈.
// - UI 기여(editor/title)는 package.json 에 두고, 여기서는 활성 diff 탭 해석과 파일 열기만 담당한다.
import * as path from "path";
import * as vscode from "vscode";
import { logError, logInfo, logWarn } from "../ui/outputLog";
import { COMPARE_SCHEME, parseRefUri } from "../utils/uri";

interface DiffFileTarget {
  uri: vscode.Uri;
  source: "modifiedFile" | "modifiedRef" | "originalRef";
}

/**
 * 활성 Git Simple Compare diff 에서 실제 작업 파일 편집기를 연다.
 * - 우측이 file 스킴이면 그 파일을 그대로 연다.
 * - 우측이 가상 ref 문서이면 URI 의 repoRoot/path 를 작업트리 파일 경로로 변환해 연다.
 * - 삭제된 파일처럼 작업트리에 실제 파일이 없으면 새 파일을 만들지 않도록 안내 후 중단한다.
 */
export async function openDiffFileEditor(): Promise<void> {
  const target = resolveActiveDiffFileTarget();
  if (!target) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Open a Git Simple Compare diff first.")
    );
    return;
  }

  try {
    await vscode.workspace.fs.stat(target.uri);
    await vscode.commands.executeCommand("vscode.open", target.uri, {
      preview: false,
    });
    logInfo("diff file editor opened", {
      path: target.uri.fsPath,
      source: target.source,
    });
  } catch (err) {
    logError("diff file editor open failed", err, {
      path: target.uri.fsPath,
      source: target.source,
    });
    vscode.window.showWarningMessage(
      vscode.l10n.t("Working file could not be opened: {0}", errText(err))
    );
  }
}

/**
 * 현재 활성 탭에서 열 수 있는 실제 작업 파일 URI 를 찾는다.
 * @returns 열 수 있는 작업 파일 URI 와 어느 diff side 에서 유도했는지, 없으면 undefined
 */
function resolveActiveDiffFileTarget(): DiffFileTarget | undefined {
  const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input;
  if (!(input instanceof vscode.TabInputTextDiff)) {
    return undefined;
  }

  const { original, modified } = input;
  if (original.scheme !== COMPARE_SCHEME && modified.scheme !== COMPARE_SCHEME) {
    return undefined;
  }
  if (modified.scheme === "file") {
    return { uri: modified, source: "modifiedFile" };
  }

  const modifiedFile = workingFileFromRefUri(modified);
  if (modifiedFile) {
    return { uri: modifiedFile, source: "modifiedRef" };
  }
  const originalFile = workingFileFromRefUri(original);
  return originalFile ? { uri: originalFile, source: "originalRef" } : undefined;
}

/**
 * 가상 ref 문서 URI 에 담긴 저장소 루트와 상대 경로로 작업트리 파일 URI 를 만든다.
 * @param uri makeRefUri 로 만든 gitsimplecompare URI
 * @returns 작업트리 실제 파일 URI, 변환할 수 없으면 undefined
 */
function workingFileFromRefUri(uri: vscode.Uri): vscode.Uri | undefined {
  if (uri.scheme !== COMPARE_SCHEME) {
    return undefined;
  }
  try {
    const parsed = parseRefUri(uri);
    if (!parsed.repoRoot || !parsed.path) {
      return undefined;
    }
    const relative = parsed.path.replace(/^\/+/, "");
    return vscode.Uri.file(path.join(parsed.repoRoot, relative));
  } catch (err) {
    logWarn("diff ref uri parse failed", {
      uri: uri.toString(),
      error: errText(err),
    });
    return undefined;
  }
}

/**
 * 사용자 메시지와 로그에 넣을 짧은 오류 문자열을 만든다.
 * @param err 알 수 없는 throw 값
 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
