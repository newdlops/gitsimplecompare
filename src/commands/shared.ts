// 명령 레이어가 공유하는 보조 함수 모음.
// - 저장소 컨텍스트 탐지와 설정 읽기처럼 여러 명령에서 반복되는 일을 모은다.
// - 명령 본문(compareBranches/compareFile)은 이 헬퍼에 위임해 짧고 명확하게 유지한다.
import * as path from "node:path";
import * as vscode from "vscode";
import { DiffBase } from "../git/gitTypes";
import { GitService } from "../git/gitService";
import { GitServiceRegistry } from "../git/serviceRegistry";
import { ChangesViewProvider } from "../webview/changesViewProvider";
import { ConflictsController } from "../providers/conflictsController";
import { HunkCheckboxController } from "../providers/hunkCheckboxController";
import type { BlameDecoratorController } from "../providers/blameDecoratorController";
import type { BlockBlameCodeLensController } from "../providers/blockBlameCodeLensController";
import type { BlockBlamePresenter } from "../ui/blockBlamePresenter";
import type { VscodeGitStatusProvider } from "../providers/vscodeGitStatusProvider";
import { ComparisonService } from "../git/comparisonService";
import type { ComparisonController } from "../providers/comparisonController";
import type { ConflictEditorOverlayController } from "../providers/conflictEditorOverlayController";

/** 명령들이 의존하는 공유 객체 묶음(DI 컨테이너 역할) */
export interface CommandDeps {
  registry: GitServiceRegistry;
  /** 브랜치 비교 결과를 보관·표시하는 CHANGES 웹뷰 프로바이더 */
  changesView: ChangesViewProvider;
  /** 확장 루트 URI(웹뷰 미디어 리소스 경로 계산용) */
  extensionUri: vscode.Uri;
  /** 민감한 사용자 토큰/쿠키를 저장하는 VS Code SecretStorage */
  secrets: vscode.SecretStorage;
  /** 충돌 해결 UI 상태 컨트롤러 */
  conflicts: ConflictsController;
  /** native conflict Result 문서와 안전한 overlay session 컨트롤러 */
  conflictOverlay: ConflictEditorOverlayController;
  /** editable diff 라인별 stage 체크박스 컨트롤러 */
  hunkCheckboxes: HunkCheckboxController;
  /** 활성 에디터 git blame decoration 컨트롤러 */
  blameDecorations: BlameDecoratorController;
  /** 소스 블록 위 주요 작업자 Code Vision 컨트롤러 */
  blockBlameCodeLens: BlockBlameCodeLensController;
  /** Code Vision 클릭 시 선택 블록의 라인별 작업자를 거터에 표시하는 presenter */
  blockBlamePresenter: BlockBlamePresenter;
  /** VS Code 내장 Git 확장이 이미 계산한 상태를 재사용하는 어댑터 */
  vscodeGitStatus: VscodeGitStatusProvider;
  /** PR comment 캐시를 비우고 활성 에디터 표시를 다시 읽는 hook */
  refreshPullRequestComments: (reason: string) => void;
  /** Explorer/탭/전용 트리가 공유하는 비교 스냅샷과 표시 토글 컨트롤러 */
  comparison: ComparisonController;
}

/** 사용자 설정에서 읽어온 확장 동작 옵션 */
export interface CompareConfig {
  diffBase: DiffBase;
  includeRemoteBranches: boolean;
}

/** 저장소 쓰기 작업 하나가 보유하는 process-local 배타 lease. */
export interface RepoMutationLease {
  /** 로그와 충돌 안내에 사용할 현재 작업 이름. */
  operation: string;
  /** 같은 lease가 아직 현재 소유자일 때만 잠금을 해제한다. 여러 번 호출해도 안전하다. */
  release(): void;
}

/**
 * VS Code extension host 안에서 같은 저장소의 index/HEAD 쓰기를 직렬화하는 상태표다.
 * Git 자체의 외부 프로세스 경쟁은 서비스 계층의 snapshot fence가 담당하고, 이 표는
 * Changes 버튼과 AI 플랜처럼 확장 내부에서 쉽게 생기는 경합을 사용자 동작 전에 막는다.
 */
const activeRepoMutations = new Map<
  string,
  { operation: string; owner: symbol }
>();

/**
 * 저장소 쓰기 lease를 즉시 얻는다. 이미 다른 작업이 실행 중이면 기다리지 않고 반환한다.
 * @param repoRoot GitService가 정규화한 저장소 절대 경로
 * @param operation 로그와 사용자 안내에 쓸 짧은 작업 이름
 * @returns 획득한 lease, 또는 동일 저장소가 사용 중이면 undefined
 */
export function tryAcquireRepoMutation(
  repoRoot: string,
  operation: string
): RepoMutationLease | undefined {
  if (activeRepoMutations.has(repoRoot)) {
    return undefined;
  }
  const owner = Symbol(operation);
  activeRepoMutations.set(repoRoot, { operation, owner });
  let released = false;
  return {
    operation,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      if (activeRepoMutations.get(repoRoot)?.owner === owner) {
        activeRepoMutations.delete(repoRoot);
      }
    },
  };
}

/**
 * 저장소를 현재 점유한 확장 내부 쓰기 작업 이름을 조회한다.
 * @param repoRoot 확인할 저장소 절대 경로
 * @returns 점유 작업 이름, 비어 있으면 undefined
 */
export function activeRepoMutation(repoRoot: string): string | undefined {
  return activeRepoMutations.get(repoRoot)?.operation;
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
      vscode.l10n.t("Branch comparison is only available for local files.")
    );
    return undefined;
  }
  const dir = dirNameOf(fileUri.fsPath);
  const service = await registry.resolve(dir);
  if (!service) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("This file is not inside a git repository.")
    );
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
      vscode.l10n.t("No git repository found in the open workspace.")
    );
    return undefined;
  }
  if (services.length === 1) {
    return services[0];
  }

  // 3) 저장소가 여러 개면 사용자에게 선택을 받는다.
  const picked = await vscode.window.showQuickPick(
    services.map((s) => ({ label: s.repoRoot, service: s })),
    { placeHolder: vscode.l10n.t("Select a repository to compare") }
  );
  return picked?.service;
}

/** Repositories 섹션에 표시할 저장소 정보(루트 + 현재 브랜치) */
export interface RepoInfo {
  root: string;
  branch: string;
}

/**
 * 워크스페이스(활성 에디터 + 폴더들)에서 git 저장소를 조용히 수집한다.
 * - 각 저장소의 현재 브랜치까지 읽어 VS Code SCM 처럼 표시한다. 경고는 띄우지 않는다.
 * @param registry GitService 레지스트리
 * @returns 활성 파일과 workspace folder에서 찾은 중복 없는 저장소/브랜치 목록
 */
export async function discoverRepositories(
  registry: GitServiceRegistry
): Promise<RepoInfo[]> {
  const searchPaths: string[] = [];
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "file") {
    searchPaths.push(dirNameOf(active.fsPath));
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    searchPaths.push(folder.uri.fsPath);
  }
  // multi-root workspace의 rev-parse와 브랜치 조회는 서로 독립이므로 병렬 실행해 합산 지연을 피한다.
  const identities = await Promise.all(
    [...new Set(searchPaths)].map((searchPath) =>
      registry.resolveWithBranch(searchPath)
    )
  );
  const repositories = new Map<string, RepoInfo>();
  for (const identity of identities) {
    if (!identity) continue;
    const root = identity.service.repoRoot;
    repositories.set(repositoryPathKey(root), {
      root,
      branch: identity.branch,
    });
  }
  return [...repositories.values()];
}

/**
 * Repositories 섹션이 처음 열릴 때 우선 선택할 저장소 루트를 찾는다.
 * - 활성 에디터 파일이 속한 repo 를 먼저 보고, 없으면 현재 워크스페이스 폴더가 포함된 repo 를 사용한다.
 * - 이미 조회한 후보 루트와 경로 포함 관계만 계산해 초기 선택 때문에 `git rev-parse`를 다시 실행하지 않는다.
 * @param repositories 화면에 표시할 저장소 후보 목록
 * @returns 후보 목록 안에서 현재 작업 컨텍스트에 가장 가까운 저장소 루트
 */
export function resolvePreferredRepositoryRoot(
  repositories: RepoInfo[]
): string | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "file") {
    const root = containingRepositoryRoot(active.fsPath, repositories);
    if (root) {
      return root;
    }
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = containingRepositoryRoot(folder.uri.fsPath, repositories);
    if (root) {
      return root;
    }
  }
  return undefined;
}

/**
 * 대상 경로를 포함하는 저장소 후보 중 가장 깊은 루트를 선택한다.
 * @param targetPath 활성 파일 또는 workspace folder의 절대 경로
 * @param repositories 이미 화면에 표시하기로 확정한 저장소 후보
 * @returns 대상과 가장 가까운 저장소 루트, 포함 후보가 없으면 undefined
 */
function containingRepositoryRoot(
  targetPath: string,
  repositories: RepoInfo[]
): string | undefined {
  const target = repositoryPathKey(targetPath);
  return repositories
    .map((repository) => repository.root)
    .filter((root) => {
      const relative = path.relative(repositoryPathKey(root), target);
      return (
        relative === "" ||
        (relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative))
      );
    })
    .sort((left, right) => right.length - left.length)[0];
}

/**
 * 파일 시스템 경로를 플랫폼의 대소문자 규칙까지 반영한 비교용 절대 경로로 바꾼다.
 * @param value 활성 파일, workspace folder 또는 저장소 루트 경로
 * @returns path.resolve와 Windows 소문자 정규화를 적용한 경로
 */
export function repositoryPathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 비교에 사용할 저장소를 정한다.
 * - CHANGES 뷰에서 선택된 활성 저장소를 우선하고, 없으면 워크스페이스에서 탐지한다.
 * @param deps 공유 의존성(활성 저장소는 changesView 가 보유)
 */
export async function resolveCompareService(
  deps: CommandDeps
): Promise<GitService | undefined> {
  const active = deps.changesView.getActiveRepo();
  if (active) {
    return deps.registry.get(active);
  }
  return resolveWorkspaceService(deps.registry);
}

/**
 * 명령이 선택한 저장소에 대한 ComparisonService 를 만든다.
 * - 레지스트리의 GitService 를 주입해 기존 상태 캐시와 git 실행 규칙을
 *   그대로 공유한다. PR/원격 서비스는 도메인 레이어 내부에서 조립된다.
 * @param deps 저장소별 GitService 레지스트리를 포함한 명령 의존성
 * @param repoRoot 비교할 git 저장소의 절대 경로
 * @returns 같은 저장소에 바인딩된 비교 도메인 서비스
 */
export function createComparisonService(
  deps: CommandDeps,
  repoRoot: string
): ComparisonService {
  return new ComparisonService(repoRoot, {
    git: deps.registry.get(repoRoot),
  });
}

/**
 * 현재 UI 문맥에서 저장소를 고른 뒤 ComparisonService 로 변환한다.
 * - Changes 뷰의 활성 저장소, 활성 파일, 워크스페이스 순의 기존 탐지
 *   규칙을 재사용해 브랜치/PR/원격 비교가 항상 같은 저장소를 보게 한다.
 * @param deps 명령 공유 의존성
 * @returns 선택된 저장소의 비교 서비스, 저장소가 없으면 undefined
 */
export async function resolveComparisonService(
  deps: CommandDeps
): Promise<ComparisonService | undefined> {
  const git = await resolveCompareService(deps);
  return git ? createComparisonService(deps, git.repoRoot) : undefined;
}

/**
 * 경로에서 디렉터리 부분만 떼어낸다(플랫폼 구분자 모두 고려).
 * @param fsPath 파일 경로
 */
function dirNameOf(fsPath: string): string {
  const idx = Math.max(fsPath.lastIndexOf("/"), fsPath.lastIndexOf("\\"));
  return idx >= 0 ? fsPath.slice(0, idx) : fsPath;
}
