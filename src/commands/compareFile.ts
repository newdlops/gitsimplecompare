// 기능 2·3: 파일 ↔ 브랜치 비교.
// - 기능 2: 탐색기에서 고른 파일을 특정 브랜치 버전과 비교.
// - 기능 3: 현재 열린 파일을 특정 브랜치 버전과 비교.
// - 두 기능 모두 같은 핵심 로직(compareFileWithBranch)을 공유한다.
// - 오른쪽은 작업트리의 실제 파일이므로 비교하면서 바로 편집할 수 있다(기능 4).
import * as vscode from "vscode";
import { pickBranch } from "../ui/quickPick";
import { openRefVsWorkingDiff } from "../ui/diffPresenter";
import { CommandDeps, readConfig, resolveServiceForFile } from "./shared";

/**
 * 핵심 로직: 주어진 파일을 사용자가 고른 브랜치 버전과 비교한다.
 * - 저장소 탐지 → 브랜치 선택 → ref↔작업파일 diff 열기.
 * @param deps    공유 의존성
 * @param fileUri 비교할 작업트리 파일 URI(file 스킴)
 */
export async function compareFileWithBranch(
  deps: CommandDeps,
  fileUri: vscode.Uri
): Promise<void> {
  const service = await resolveServiceForFile(deps.registry, fileUri);
  if (!service) {
    return;
  }

  const config = readConfig();
  const branches = await service.listBranches(config.includeRemoteBranches);
  if (branches.length === 0) {
    vscode.window.showWarningMessage("비교할 브랜치가 없습니다.");
    return;
  }

  const relPath = service.toRepoRelative(fileUri.fsPath);
  const current = branches.find((b) => b.isCurrent)?.name;
  const branch = await pickBranch(
    branches,
    `'${relPath}' 와(과) 비교할 브랜치를 선택하세요`,
    current
  );
  if (!branch) {
    return;
  }

  // 왼쪽=브랜치(읽기 전용), 오른쪽=작업파일(편집 가능)으로 diff 를 연다.
  await openRefVsWorkingDiff(service.repoRoot, branch.name, fileUri, relPath);
}

/**
 * 기능 2 진입점: 탐색기 컨텍스트 메뉴에서 호출된다.
 * - VS Code 가 클릭된 리소스 URI 를 첫 인자로 넘겨준다.
 * @param deps    공유 의존성
 * @param fileUri 컨텍스트 메뉴로 선택된 파일(없으면 활성 에디터로 폴백)
 */
export async function compareExplorerFileWithBranch(
  deps: CommandDeps,
  fileUri?: vscode.Uri
): Promise<void> {
  const target = fileUri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) {
    vscode.window.showWarningMessage("비교할 파일을 찾을 수 없습니다.");
    return;
  }
  await compareFileWithBranch(deps, target);
}

/**
 * 기능 3 진입점: 현재 활성 에디터의 파일을 브랜치와 비교한다.
 * - 활성 에디터가 없거나 로컬 파일이 아니면 안내 후 종료한다.
 * @param deps 공유 의존성
 */
export async function compareActiveFileWithBranch(
  deps: CommandDeps
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("열려 있는 파일이 없습니다.");
    return;
  }
  await compareFileWithBranch(deps, editor.document.uri);
}
