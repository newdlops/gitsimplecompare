// graph 의 가상 커밋(working tree/index) diff 열기 동작.
// - GraphPanel 이 diff 의미를 직접 조합하지 않도록 UI 헬퍼로 분리한다.
import * as vscode from "vscode";
import { ONGOING_COMMIT_HASH, STAGED_COMMIT_HASH } from "../git/gitLogService";
import { openHeadVsIndexDiff, openRefVsWorkingDiff } from "../ui/diffPresenter";

/**
 * graph 가상 커밋의 파일 diff 를 실제 의미에 맞게 연다.
 * @param repoRoot 대상 git 저장소 루트
 * @param hash 선택한 graph row hash
 * @param path diff 를 열 저장소 상대 파일 경로
 * @returns 가상 커밋으로 처리했으면 true
 */
export async function openGraphVirtualFileDiff(
  repoRoot: string,
  hash: string,
  path: string
): Promise<boolean> {
  if (hash === ONGOING_COMMIT_HASH) {
    await openRefVsWorkingDiff(repoRoot, "HEAD", vscode.Uri.file(`${repoRoot}/${path}`), path);
    return true;
  }
  if (hash === STAGED_COMMIT_HASH) {
    await openHeadVsIndexDiff(repoRoot, path);
    return true;
  }
  return false;
}
