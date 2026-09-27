// 대용량 파일의 diff 미리보기 한도와 안내 UI 를 담당하는 모듈.
// - 한도 계산 규칙은 git/largeChangeSet(순수 정책)에 두고, 여기서는 VS Code 설정 읽기·문구·알림만 맡는다.
// - 대용량 파일을 확장 호스트 메모리에 올려 diff 를 만들지 않고, VS Code 가 직접 여는 실제 파일로 안내한다.
// - 한도를 넘는 가상 문서는 가짜 내용 대신 오류로 거부한다(실제 파일과 짝지은 diff 의 되돌리기 보호).
import * as path from "node:path";
import * as vscode from "vscode";
import { FileTooLargeError, diffPreviewLimitBytes } from "../git/largeChangeSet";
import { logInfo } from "./outputLog";

/**
 * 현재 VS Code `diffEditor.maxFileSize` 설정으로 diff 미리보기 크기 상한을 계산한다.
 * - VS Code diff 편집기도 이 크기를 넘으면 차이를 계산하지 않으므로, 그 이상은 내용을 읽을 이유가 없다.
 * @returns 버전 하나당 읽을 최대 byte 수
 */
export function currentDiffPreviewLimitBytes(): number {
  return diffPreviewLimitBytes(
    vscode.workspace.getConfiguration("diffEditor").get<number>("maxFileSize")
  );
}

/**
 * byte 수를 사용자 표시용 MB 문자열로 바꾼다.
 * @param bytes 크기(byte)
 * @returns 소수점 한 자리 MB 문자열
 */
export function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** 한도를 넘어 가상 문서 제공을 거부할 때 쓰는 오류 이름. */
const LARGE_FILE_PREVIEW_ERROR = "LargeFilePreviewError";

/**
 * 한도를 넘는 버전의 가상 문서 요청을 거부할 지역화된 오류를 만든다.
 * - 안내문을 문서 내용으로 돌려주지 않는다. 실제 파일과 짝지은 diff·gutter 에서 되돌리기를 누르면
 *   안내문이 사용자 파일에 써질 수 있기 때문이다. VS Code 는 이 메시지를 편집기 오류로 보여 준다.
 * @param error 내용 읽기에서 발생한 크기 초과 오류
 * @returns 사용자에게 보여 줄 메시지를 가진 오류
 */
export function largeFilePreviewError(error: FileTooLargeError): Error {
  const result = new Error(
    `${error.path}: ` +
      vscode.l10n.t(
        "This file is larger than {0} MB, so its contents are not loaded for comparison (diffEditor.maxFileSize). Open the file directly to view it.",
        formatMegabytes(error.limitBytes)
      )
  );
  result.name = LARGE_FILE_PREVIEW_ERROR;
  return result;
}

/** largeFilePreviewError 로 만든 크기 초과 거부 오류인지 확인한다. */
export function isLargeFilePreviewError(error: unknown): boolean {
  return error instanceof Error && error.name === LARGE_FILE_PREVIEW_ERROR;
}

/**
 * 작업트리 파일이 diff 미리보기 한도를 넘으면 diff 대신 파일 열기를 안내한다.
 * - 크기는 stat 으로만 확인해 내용은 읽지 않는다. 파일이 없으면(삭제) 일반 diff 경로로 넘긴다.
 * @param repoRoot 저장소 루트
 * @param relPath 저장소 상대 경로
 * @returns 한도를 넘어 안내로 대신했으면 true(호출자는 diff 를 열지 않는다)
 */
export async function divertLargeWorkingFileDiff(
  repoRoot: string,
  relPath: string
): Promise<boolean> {
  const fileUri = vscode.Uri.file(path.join(repoRoot, relPath));
  const size = await Promise.resolve(vscode.workspace.fs.stat(fileUri)).then(
    (info) => info.size,
    () => undefined
  );
  const limit = currentDiffPreviewLimitBytes();
  if (size === undefined || size <= limit) {
    return false;
  }
  logInfo("large file diff skipped", { path: relPath, size, limit });
  const openFile = vscode.l10n.t("Open File");
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "'{0}' is too large to compare ({1} MB, limit {2} MB).",
      relPath,
      formatMegabytes(size),
      formatMegabytes(limit)
    ),
    openFile
  );
  if (choice === openFile) {
    await vscode.commands.executeCommand("vscode.open", fileUri);
  }
  return true;
}
