// diff 에디터를 여는 표현(presentation) 모듈.
// - vscode.diff 호출을 한곳에 모아, "어느 쪽이 편집 가능한가"를 명확히 통제한다.
//   · ref ↔ ref  : 양쪽 모두 가상 문서(읽기 전용) → 과거 상태 리뷰용
//   · ref ↔ 작업파일 : 왼쪽은 가상 문서(읽기 전용), 오른쪽은 실제 파일 → 편집 가능
import * as vscode from "vscode";
import { refreshBranchContent } from "../providers/branchContentProvider";
import { beginDiffOpen } from "../providers/diffOpenGate";
import { logInfo } from "./outputLog";
import { makeDiffTitle, makeRefUri } from "../utils/uri";

/** diff 를 열 때의 공통 옵션(미리보기 끄고 새 탭으로 연다) */
const DIFF_OPTIONS: vscode.TextDocumentShowOptions = {
  preview: false,
};

/**
 * 같은 파일의 서로 다른 두 ref 버전을 나란히 비교한다(양쪽 읽기 전용).
 * - 브랜치끼리 비교에서 변경 파일 하나를 열 때 사용한다.
 * @param repoRoot 저장소 루트
 * @param base     왼쪽 ref(기준)
 * @param target   오른쪽 ref(대상)
 * @param relPath  오른쪽(대상) 저장소 상대 경로
 * @param fileLabel 제목에 표시할 파일명(없으면 relPath 사용)
 * @param leftRelPath 왼쪽(기준) 경로가 다를 때 지정(이름변경 대응). 없으면 relPath 사용
 */
export async function openRefVsRefDiff(
  repoRoot: string,
  base: string,
  target: string,
  relPath: string,
  fileLabel?: string,
  leftRelPath?: string
): Promise<void> {
  const left = makeRefUri(base, leftRelPath ?? relPath, repoRoot);
  const right = makeRefUri(target, relPath, repoRoot);
  const title = makeDiffTitle(base, target, fileLabel ?? relPath);
  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    title,
    DIFF_OPTIONS
  );
}

/**
 * 작업트리의 실제 파일을 특정 ref 버전과 비교한다(오른쪽=실제 파일이라 편집 가능).
 * - "파일과 브랜치 비교", "현재 파일과 브랜치 비교"에서 사용한다.
 * - 왼쪽에 ref(브랜치) 버전을 두어, 오른쪽 작업본을 고치며 진행할 수 있다.
 * @param repoRoot 저장소 루트
 * @param ref      비교 대상 브랜치/커밋
 * @param fileUri  작업트리 실제 파일 URI(file 스킴)
 * @param relPath  저장소 상대 경로(ref 쪽 내용 조회에 사용)
 */
export async function openRefVsWorkingDiff(
  repoRoot: string,
  ref: string,
  fileUri: vscode.Uri,
  relPath: string
): Promise<void> {
  const left = makeRefUri(ref, relPath, repoRoot);
  const fileLabel = relPath.slice(relPath.lastIndexOf("/") + 1);
  const title = makeDiffTitle(ref, vscode.l10n.t("Working Tree"), fileLabel);
  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    fileUri,
    title,
    DIFF_OPTIONS
  );
}

/**
 * HEAD 와 "staged 변경을 제거한 작업트리" 가상 문서를 비교한다(양쪽 읽기 전용).
 * - 부분 stage 된 라인은 source/context 에서도 빠져, 남은 unstaged 변경만 보인다.
 * @param repoRoot 저장소 루트
 * @param relPath  저장소 상대 경로
 */
export async function openHeadVsRemainingUnstagedDiff(
  repoRoot: string,
  relPath: string
): Promise<void> {
  const started = Date.now();
  const left = makeRefUri("HEAD", relPath, repoRoot);
  const right = makeRefUri(":unstaged", relPath, repoRoot);
  const fileLabel = relPath.slice(relPath.lastIndexOf("/") + 1);
  const title = makeDiffTitle("HEAD", vscode.l10n.t("Unstaged"), fileLabel);
  const finishDiffOpen = beginDiffOpen(right);
  refreshBranchContent(right);
  logInfo("diff open started", {
    mode: "head-vs-remaining-unstaged",
    path: relPath,
  });
  try {
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      title,
      DIFF_OPTIONS
    );
  } finally {
    finishDiffOpen();
    logInfo("diff open finished", {
      mode: "head-vs-remaining-unstaged",
      path: relPath,
      elapsed: Date.now() - started,
    });
  }
}

/**
 * index 와 실제 작업트리 파일을 비교한다(오른쪽=실제 파일이라 편집 가능).
 * - 실제 파일을 diff 오른쪽에서 직접 편집해야 하는 보조 경로에서 사용한다.
 * - staged 변경은 index 쪽에도 있으므로 변경 마커에서는 빠지지만 문맥 줄로는 보일 수 있다.
 * @param repoRoot 저장소 루트
 * @param relPath  저장소 상대 경로
 */
export async function openHeadVsWorkingTreeDiff(
  repoRoot: string,
  relPath: string
): Promise<void> {
  const started = Date.now();
  const left = makeRefUri(":0", relPath, repoRoot);
  const right = vscode.Uri.file(`${repoRoot}/${relPath}`);
  const fileLabel = relPath.slice(relPath.lastIndexOf("/") + 1);
  const title = makeDiffTitle(
    vscode.l10n.t("Index"),
    vscode.l10n.t("Working Tree"),
    fileLabel
  );
  const finishDiffOpen = beginDiffOpen(right);
  refreshBranchContent(left);
  logInfo("diff open started", {
    mode: "index-vs-working",
    path: relPath,
  });
  try {
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      title,
      DIFF_OPTIONS
    );
  } finally {
    finishDiffOpen();
    logInfo("diff open finished", {
      mode: "index-vs-working",
      path: relPath,
      elapsed: Date.now() - started,
    });
  }
}

/**
 * index 에 올라간 파일 버전을 HEAD 와 비교한다(양쪽 읽기 전용).
 * - staged 목록에서 파일을 열 때 사용해, 부분 stage 된 변화만 정확히 보여준다.
 * @param repoRoot 저장소 루트
 * @param relPath  저장소 상대 경로
 */
export async function openHeadVsIndexDiff(
  repoRoot: string,
  relPath: string
): Promise<void> {
  const left = makeRefUri("HEAD", relPath, repoRoot);
  const right = makeRefUri(":0", relPath, repoRoot);
  const fileLabel = relPath.slice(relPath.lastIndexOf("/") + 1);
  const title = makeDiffTitle("HEAD", vscode.l10n.t("Index"), fileLabel);
  refreshBranchContent(right);
  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    title,
    DIFF_OPTIONS
  );
}
