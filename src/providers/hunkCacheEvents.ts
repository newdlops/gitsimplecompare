// hunk 표시 좌표에 영향을 주는 문서 이벤트를 파일 단위 무효화로 연결한다.
import * as path from "node:path";
import * as vscode from "vscode";
import { visibleHunkTargets } from "./hunkCheckboxTargets";
import type { ActiveHunkDiffTarget } from "./hunkDiffContext";
import { logInfo } from "../ui/outputLog";

/**
 * 저장·편집·가상 기준 문서 갱신은 해당 파일만 다시 읽어 다른 editor의 Git 조회를 보존한다.
 * @param refresh 컨트롤러의 파일 단위 무효화 함수
 * @returns 문서 이벤트 리스너 수명을 함께 정리할 Disposable
 */
export function registerHunkCacheEvents(
  refresh: (target: Pick<ActiveHunkDiffTarget, "repoRoot" | "relPath">) => void
): vscode.Disposable {
  /** 양쪽 가상 URI와 실제 작업 파일 URI를 비교해 중복 표시 중인 파일도 한 번만 무효화한다. */
  const invalidateDocument = (uri: vscode.Uri): void => {
    const key = uri.toString(), seen = new Set<string>();
    for (const target of visibleHunkTargets()) {
      const file = path.resolve(target.repoRoot, target.relPath);
      if (target.original.toString() !== key && target.modified.toString() !== key &&
        (uri.scheme !== "file" || path.resolve(uri.fsPath) !== file)) continue;
      if (!seen.has(file)) { seen.add(file); refresh(target); }
    }
  };
  return vscode.Disposable.from(
    vscode.workspace.onDidSaveTextDocument(document => invalidateDocument(document.uri)),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.contentChanges.length) invalidateDocument(event.document.uri);
    })
  );
}

/** 파일 변경으로 중단된 이전 snapshot은 정상 스킵해 overlay 오류로 처리하지 않는다. */
export async function skipInvalidatedHunkSnapshot<T>(path: string, read: () => Promise<T>): Promise<T | undefined> {
  try { return await read(); }
  catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
    logInfo("hunk checkbox snapshot skipped", { reason: "invalidated", path });
    return undefined;
  }
}
