// VS Code 내장 Git 확장이 이미 계산한 저장소/작업트리 상태를 읽는 어댑터.
// - Changes 뷰가 작업트리 목록을 보여줄 때 별도의 `git status` 스캔을 다시 돌리지 않기 위해 사용한다.
// - 내장 Git API 가 없거나 비활성 환경이면 undefined 를 반환해 기존 GitService CLI 경로로 폴백한다.
import * as path from "node:path";
import * as vscode from "vscode";
import type { StatusGroups } from "../git/gitService";
import type { FileChange, FileChangeStatus } from "../git/gitTypes";
import { logInfo, logWarn } from "../ui/outputLog";

/** Changes 뷰 저장소 목록에 필요한 최소 정보. */
export interface VscodeGitRepoInfo {
  root: string;
  branch: string;
}

/** 내장 Git 확장의 공개 API 중 이 확장이 사용하는 최소 표면. */
interface VscodeGitExtension {
  enabled?: boolean;
  onDidChangeEnablement?: vscode.Event<boolean>;
  getAPI(version: 1): VscodeGitApi;
}

/** VS Code Git API v1 의 저장소 컬렉션 이벤트. */
interface VscodeGitApi {
  readonly repositories: VscodeGitRepository[];
  readonly onDidOpenRepository: vscode.Event<VscodeGitRepository>;
  readonly onDidCloseRepository: vscode.Event<VscodeGitRepository>;
}

/** VS Code Git 저장소 객체 중 상태 표시용 필드. */
interface VscodeGitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: VscodeGitRepositoryState;
}

/** VS Code Git 이 유지하는 저장소 상태 캐시. */
interface VscodeGitRepositoryState {
  readonly HEAD?: { name?: string; commit?: string };
  readonly indexChanges: VscodeGitChange[];
  readonly workingTreeChanges: VscodeGitChange[];
  readonly untrackedChanges: VscodeGitChange[];
  readonly mergeChanges: VscodeGitChange[];
  readonly onDidChange: vscode.Event<void>;
}

/** VS Code Git 상태 항목. renameUri 는 이름변경의 원본 경로다. */
interface VscodeGitChange {
  readonly uri: vscode.Uri;
  readonly renameUri?: vscode.Uri;
  readonly status: number;
}

const enum VscodeGitStatus {
  IndexModified = 0,
  IndexAdded = 1,
  IndexDeleted = 2,
  IndexRenamed = 3,
  IndexCopied = 4,
  Modified = 5,
  Deleted = 6,
  Untracked = 7,
  Ignored = 8,
  IntentToAdd = 9,
  BothDeleted = 10,
  AddedByUs = 11,
  DeletedByThem = 12,
  AddedByThem = 13,
  DeletedByUs = 14,
  BothAdded = 15,
  BothModified = 16,
}

/**
 * VS Code 내장 Git 상태 캐시를 읽고 변경 이벤트를 전달한다.
 * - 조회 시 이미 활성화된 내장 Git만 연결하고, 비활성이면 건드리지 않은 채 CLI 경로로 폴백한다.
 * - 상태 변경 이벤트가 오면 콜백만 호출하고, 실제 refresh 여부는 호출자가 뷰 가시성에 따라 결정한다.
 */
export class VscodeGitStatusProvider implements vscode.Disposable {
  private api: VscodeGitApi | undefined;
  private activation: Promise<void> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repositoryDisposables = new Map<
    VscodeGitRepository,
    vscode.Disposable[]
  >();
  private readonly repositoryIdentities = new Map<VscodeGitRepository, string>();

  constructor(private readonly onDidChange: (reason: string) => void) {}

  /**
   * VS Code Git API 를 사용할 수 있게 준비한다.
   * @returns API 사용 가능 여부. false 면 호출자는 기존 CLI 기반 조회로 폴백해야 한다.
   */
  async ensureReady(): Promise<boolean> {
    if (this.api) {
      return true;
    }
    this.startGitApiActivation();
    await this.activation;
    return !!this.api;
  }

  /**
   * 내장 Git 이 이미 알고 있는 저장소 목록과 현재 브랜치를 즉시 반환한다.
   * - 아직 API/저장소 스캔이 준비되지 않았으면 내장 Git을 강제 활성화하지 않고 즉시 폴백한다.
   * @returns 즉시 재사용할 저장소가 없으면 undefined, 있으면 저장소 목록
   */
  async getRepositories(): Promise<VscodeGitRepoInfo[] | undefined> {
    if (!this.api) {
      this.attachActiveGitApi();
    }
    if (!this.api) {
      return undefined;
    }
    const repositories = this.api.repositories.map((repo) => ({
      root: repo.rootUri.fsPath,
      branch: repo.state.HEAD?.name || "HEAD",
    }));
    // Git 확장이 활성화됐어도 최초 workspace scan 전의 []는 확정 결과가 아니므로 CLI 탐색을 허용한다.
    return repositories.length ? repositories : undefined;
  }

  /**
   * 내장 Git 이 이미 계산한 작업트리 상태를 기다림 없이 이 확장의 StatusGroups 로 변환한다.
   * - API가 아직 준비되지 않았으면 내장 Git을 활성화하지 않고 undefined를 반환해 같은 refresh가 CLI를 사용하게 한다.
   * @param repoRoot 저장소 루트 절대 경로
   * @returns 해당 저장소 상태. 내장 Git API 에 저장소가 없으면 undefined
   */
  async getStatusGroups(repoRoot: string): Promise<StatusGroups | undefined> {
    if (!this.api) {
      this.attachActiveGitApi();
    }
    if (!this.api) {
      return undefined;
    }
    const repo = this.findRepository(repoRoot);
    if (!repo) {
      return undefined;
    }
    const staged = uniqueChanges(
      repo.state.indexChanges
        .map((change) => this.toFileChange(repo, change, "index"))
        .filter((change): change is FileChange => !!change)
    );
    const unstaged = uniqueChanges([
      ...repo.state.mergeChanges
        .map((change) => this.toFileChange(repo, change, "working"))
        .filter((change): change is FileChange => !!change),
      ...repo.state.workingTreeChanges
        .map((change) => this.toFileChange(repo, change, "working"))
        .filter((change): change is FileChange => !!change),
      ...repo.state.untrackedChanges
        .map((change) => this.toFileChange(repo, change, "working"))
        .filter((change): change is FileChange => !!change),
    ]);
    return { staged, unstaged };
  }

  /**
   * 내장 Git API 활성화를 한 번만 시작하되 현재 Changes refresh는 그 완료를 기다리지 않게 한다.
   * @returns 반환값 없이 공유 activation Promise만 준비한다.
   */
  private startGitApiActivation(): void {
    if (this.api || this.activation) {
      return;
    }
    logInfo("vscode git api activation scheduled");
    this.activation = this.activateGitApi();
  }

  /**
   * VS Code가 다른 이유로 이미 활성화한 Git 확장에만 동기적으로 연결한다.
   * - Changes 콜드스타트가 `vscode.git.activate()`와 workspace scan을 새로 유발하지 않게 한다.
   * @returns 반환값 없이 즉시 사용할 수 있는 경우에만 API와 이벤트 구독을 준비한다.
   */
  private attachActiveGitApi(): void {
    if (this.api || this.activation) {
      return;
    }
    const extension =
      vscode.extensions.getExtension<VscodeGitExtension>("vscode.git");
    if (!extension?.isActive) {
      return;
    }
    logInfo("active vscode git api attach scheduled");
    this.activation = this.activateGitApi();
  }

  /** 등록한 VS Code 이벤트 리스너를 모두 해제한다. */
  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    for (const disposables of this.repositoryDisposables.values()) {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    }
    this.repositoryDisposables.clear();
    this.repositoryIdentities.clear();
  }

  /** 내장 Git 확장을 활성화하고 저장소 상태 이벤트를 연결한다. */
  private async activateGitApi(): Promise<void> {
    const extension =
      vscode.extensions.getExtension<VscodeGitExtension>("vscode.git");
    if (!extension) {
      logWarn("vscode git api unavailable", { reason: "extensionMissing" });
      return;
    }
    try {
      const gitExtension = extension.isActive
        ? extension.exports
        : await extension.activate();
      this.api = gitExtension.getAPI(1);
      this.disposables.push(
        this.api.onDidOpenRepository((repo) => {
          this.watchRepository(repo);
          this.onDidChange("vscodeGit:repositoryOpened");
        }),
        this.api.onDidCloseRepository((repo) => {
          this.unwatchRepository(repo);
          this.onDidChange("vscodeGit:repositoryClosed");
        }),
        gitExtension.onDidChangeEnablement?.((enabled) => {
          logInfo("vscode git enablement changed", { enabled });
          this.onDidChange("vscodeGit:enablement");
        }) ?? new vscode.Disposable(() => undefined)
      );
      for (const repo of this.api.repositories) {
        this.watchRepository(repo);
      }
      logInfo("vscode git api ready", {
        repositories: this.api.repositories.length,
      });
    } catch (error) {
      this.activation = undefined;
      logWarn("vscode git api unavailable", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 저장소 상태 변경 이벤트를 구독한다.
   * @param repo VS Code Git 저장소 객체
   */
  private watchRepository(repo: VscodeGitRepository): void {
    if (this.repositoryDisposables.has(repo)) {
      return;
    }
    this.repositoryIdentities.set(repo, repositoryIdentity(repo));
    const disposable = repo.state.onDidChange(() => {
      const previous = this.repositoryIdentities.get(repo);
      const current = repositoryIdentity(repo);
      this.repositoryIdentities.set(repo, current);
      // 파일/index 변화는 가벼운 Changes 갱신만, HEAD/branch 이동은 비교 identity 갱신까지 요청한다.
      this.onDidChange(
        previous !== current ? "vscodeGit:identity" : "vscodeGit:state"
      );
    });
    this.repositoryDisposables.set(repo, [disposable]);
  }

  /**
   * 닫힌 저장소의 이벤트 구독을 해제한다.
   * @param repo VS Code Git 저장소 객체
   */
  private unwatchRepository(repo: VscodeGitRepository): void {
    const disposables = this.repositoryDisposables.get(repo);
    if (!disposables) {
      return;
    }
    for (const disposable of disposables) {
      disposable.dispose();
    }
    this.repositoryDisposables.delete(repo);
    this.repositoryIdentities.delete(repo);
  }

  /**
   * 루트 경로가 일치하는 VS Code Git 저장소를 찾는다.
   * @param repoRoot 찾을 저장소 루트 절대 경로
   */
  private findRepository(repoRoot: string): VscodeGitRepository | undefined {
    const normalized = normalizePath(repoRoot);
    return this.api?.repositories.find(
      (repo) => normalizePath(repo.rootUri.fsPath) === normalized
    );
  }

  /**
   * VS Code Git 변경 항목을 이 확장의 파일 변경 타입으로 변환한다.
   * @param repo 변경이 속한 저장소
   * @param change VS Code Git 상태 항목
   * @param bucket staged(index) 또는 unstaged(working) 구분
   */
  private toFileChange(
    repo: VscodeGitRepository,
    change: VscodeGitChange,
    bucket: "index" | "working"
  ): FileChange | undefined {
    const status =
      bucket === "index"
        ? mapIndexStatus(change.status)
        : mapWorkingStatus(change.status);
    if (!status) {
      return undefined;
    }
    const filePath = repoRelativePath(repo, change.uri);
    if (!filePath) {
      return undefined;
    }
    const oldPath = change.renameUri
      ? repoRelativePath(repo, change.renameUri)
      : undefined;
    return oldPath ? { status, path: filePath, oldPath } : { status, path: filePath };
  }
}

/**
 * 인덱스 변경 상태를 FileChangeStatus 로 변환한다.
 * @param status VS Code Git Status enum 숫자값
 */
function mapIndexStatus(status: number): FileChangeStatus | undefined {
  switch (status) {
    case VscodeGitStatus.IndexModified:
      return "M";
    case VscodeGitStatus.IndexAdded:
      return "A";
    case VscodeGitStatus.IndexDeleted:
      return "D";
    case VscodeGitStatus.IndexRenamed:
      return "R";
    case VscodeGitStatus.IndexCopied:
      return "C";
    default:
      return isConflictStatus(status) ? "U" : undefined;
  }
}

/**
 * 작업트리 변경 상태를 FileChangeStatus 로 변환한다.
 * @param status VS Code Git Status enum 숫자값
 */
function mapWorkingStatus(status: number): FileChangeStatus | undefined {
  switch (status) {
    case VscodeGitStatus.Modified:
      return "M";
    case VscodeGitStatus.Deleted:
      return "D";
    case VscodeGitStatus.Untracked:
    case VscodeGitStatus.IntentToAdd:
      return "A";
    case VscodeGitStatus.Ignored:
      return undefined;
    default:
      return isConflictStatus(status) ? "U" : undefined;
  }
}

/**
 * merge/rebase 충돌 상태인지 확인한다.
 * @param status VS Code Git Status enum 숫자값
 */
function isConflictStatus(status: number): boolean {
  return (
    status >= VscodeGitStatus.BothDeleted &&
    status <= VscodeGitStatus.BothModified
  );
}

/**
 * 중복 상태 항목을 제거한다.
 * @param changes 병합 전 변경 목록
 */
function uniqueChanges(changes: FileChange[]): FileChange[] {
  const seen = new Set<string>();
  const out: FileChange[] = [];
  for (const change of changes) {
    const key = `${change.status}\0${change.path}\0${change.oldPath ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(change);
  }
  return out;
}

/**
 * 저장소의 branch/HEAD 이동만 작업트리 상태 이벤트와 구분할 수 있는 signature를 만든다.
 * - commit hash가 제공되는 VS Code Git API에서는 같은 branch의 새 commit도 identity 변화로 잡는다.
 * @param repo VS Code Git API 저장소 객체
 * @returns branch 이름과 HEAD commit을 결합한 비교 문자열
 */
function repositoryIdentity(repo: VscodeGitRepository): string {
  return `${repo.state.HEAD?.name ?? ""}\0${repo.state.HEAD?.commit ?? ""}`;
}

/**
 * 저장소 루트 기준 상대 경로를 POSIX 구분자로 만든다.
 * @param repo VS Code Git 저장소
 * @param uri 변경 파일 URI
 */
function repoRelativePath(
  repo: VscodeGitRepository,
  uri: vscode.Uri
): string | undefined {
  const rel = path.relative(repo.rootUri.fsPath, uri.fsPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel.replace(/\\/g, "/");
}

/**
 * 플랫폼별 경로 차이를 줄이기 위해 비교용 경로를 정규화한다.
 * @param value 절대 경로
 */
function normalizePath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/");
}
