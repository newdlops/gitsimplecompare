// 명령 레이어가 공유하는 보조 함수 모음.
// - 저장소 컨텍스트 탐지와 설정 읽기처럼 여러 명령에서 반복되는 일을 모은다.
// - 명령 본문(compareBranches/compareFile)은 이 헬퍼에 위임해 짧고 명확하게 유지한다.
import * as vscode from "vscode";
import { DiffBase, FileChange } from "../git/gitTypes";
import { GitService } from "../git/gitService";
import { GitServiceRegistry } from "../git/serviceRegistry";
import { ChangesTreeProvider } from "../providers/changesTreeProvider";

/** 명령들이 의존하는 공유 객체 묶음(DI 컨테이너 역할) */
export interface CommandDeps {
  registry: GitServiceRegistry;
  /** 브랜치 비교 결과를 보관·표시하는 트리 프로바이더 */
  treeProvider: ChangesTreeProvider;
  /** 트리뷰 노출/리빌에 사용하는 VS Code 트리뷰 핸들 */
  treeView: vscode.TreeView<FileChange>;
}

/** 사용자 설정에서 읽어온 확장 동작 옵션 */
export interface CompareConfig {
  diffBase: DiffBase;
  includeRemoteBranches: boolean;
}

/**
 * 확장 설정(gitSimpleCompare.*)을 읽어 정규화된 객체로 반환한다.
 * - 설정 키가 한곳에 모여 있어 추후 옵션 추가 시 이 함수만 손대면 된다.
 */
export function readConfig(): CompareConfig {
  const cfg = vscode.workspace.getConfiguration("gitSimpleCompare");
  const diffBase = cfg.get<DiffBase>("diffBase", "twoDot");
  const includeRemoteBranches = cfg.get<boolean>("includeRemoteBranches", true);
  return { diffBase, includeRemoteBranches };
}

/**
 * 특정 파일 URI가 속한 저장소의 GitService 를 찾는다.
 * - 파일의 디렉터리를 기준으로 저장소 루트를 탐지한다.
 * - 저장소가 아니면 사용자에게 알리고 undefined 를 반환한다.
 * @param registry GitService 레지스트리
 * @param fileUri  대상 파일 URI(file 스킴이어야 함)
 */
export async function resolveServiceForFile(
  registry: GitServiceRegistry,
  fileUri: vscode.Uri
): Promise<GitService | undefined> {
  if (fileUri.scheme !== "file") {
    vscode.window.showWarningMessage(
      "로컬 파일에서만 브랜치 비교를 사용할 수 있습니다."
    );
    return undefined;
  }
  const dir = dirNameOf(fileUri.fsPath);
  const service = await registry.resolve(dir);
  if (!service) {
    vscode.window.showWarningMessage("이 파일은 git 저장소 안에 있지 않습니다.");
  }
  return service;
}

/**
 * 파일 컨텍스트가 없을 때(브랜치끼리 비교) 사용할 "작업 저장소"를 찾는다.
 * - 활성 에디터의 파일 → 워크스페이스 폴더들 순으로 탐지한다.
 * - 워크스페이스 폴더가 여러 저장소면 사용자에게 폴더를 고르게 한다(확장 지점).
 * @param registry GitService 레지스트리
 */
export async function resolveWorkspaceService(
  registry: GitServiceRegistry
): Promise<GitService | undefined> {
  // 1) 활성 에디터의 파일이 저장소 안이면 그것을 우선한다.
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === "file") {
    const fromActive = await registry.resolve(dirNameOf(active.fsPath));
    if (fromActive) {
      return fromActive;
    }
  }

  // 2) 워크스페이스 폴더들에서 저장소를 모은다.
  const folders = vscode.workspace.workspaceFolders ?? [];
  const services: GitService[] = [];
  for (const folder of folders) {
    const svc = await registry.resolve(folder.uri.fsPath);
    if (svc && !services.some((s) => s.repoRoot === svc.repoRoot)) {
      services.push(svc);
    }
  }

  if (services.length === 0) {
    vscode.window.showWarningMessage(
      "열린 워크스페이스에서 git 저장소를 찾지 못했습니다."
    );
    return undefined;
  }
  if (services.length === 1) {
    return services[0];
  }

  // 3) 저장소가 여러 개면 사용자에게 선택을 받는다.
  const picked = await vscode.window.showQuickPick(
    services.map((s) => ({ label: s.repoRoot, service: s })),
    { placeHolder: "비교할 저장소를 선택하세요" }
  );
  return picked?.service;
}

/**
 * 경로에서 디렉터리 부분만 떼어낸다(플랫폼 구분자 모두 고려).
 * @param fsPath 파일 경로
 */
function dirNameOf(fsPath: string): string {
  const idx = Math.max(fsPath.lastIndexOf("/"), fsPath.lastIndexOf("\\"));
  return idx >= 0 ? fsPath.slice(0, idx) : fsPath;
}
