// 충돌 해결 기능의 조정자(controller) 모듈.
// - 저장소 탐지 → 충돌/작업상태 조회 → 트리뷰·컨텍스트 키 갱신을 한곳에서 처리한다.
//   git 접근은 ConflictService, 표시는 ConflictsTreeProvider 에 위임한다(경계 분리).
import * as vscode from "vscode";
import { ConflictService, MergeOperation } from "../git/conflictService";
import { GitServiceRegistry } from "../git/serviceRegistry";
import { ConflictsTreeProvider } from "./conflictsTreeProvider";

/** 충돌 존재 여부를 when 절에서 쓰기 위한 컨텍스트 키(불리언) */
export const HAS_CONFLICTS_CONTEXT = "gitSimpleCompare.hasConflicts";
/** 진행 중 작업(merge/rebase 등)이 있는지를 when 절에서 쓰기 위한 컨텍스트 키(불리언) */
export const OPERATION_IN_PROGRESS_CONTEXT =
  "gitSimpleCompare.operationInProgress";

/**
 * 충돌 해결 UI 의 상태를 관리하는 컨트롤러.
 * - 명령 핸들러는 이 컨트롤러의 메서드/서비스를 통해 동작한다.
 */
export class ConflictsController {
  private service?: ConflictService;
  private operation: MergeOperation = "none";

  constructor(
    private readonly registry: GitServiceRegistry,
    private readonly provider: ConflictsTreeProvider
  ) {}

  /** 현재 대상 저장소의 ConflictService(없으면 undefined). */
  get current(): ConflictService | undefined {
    return this.service;
  }

  /** 현재 진행 중인 git 작업 종류. */
  get currentOperation(): MergeOperation {
    return this.operation;
  }

  /**
   * 저장소를 탐지해 충돌 목록과 작업 상태를 다시 읽고 UI/컨텍스트를 갱신한다.
   * - 조용히 동작한다(저장소가 없어도 경고를 띄우지 않음). 자주 호출되기 때문.
   */
  async refresh(): Promise<void> {
    const repoRoot = await this.resolveRepoRoot();
    if (!repoRoot) {
      this.service = undefined;
      this.operation = "none";
      this.provider.setState("", []);
      this.updateContext([], "none");
      return;
    }

    this.service = new ConflictService(repoRoot);
    const [conflicts, operation] = await Promise.all([
      this.service.listConflicts(),
      this.service.getOperation(),
    ]);
    this.operation = operation;
    this.provider.setState(repoRoot, conflicts);
    this.updateContext(conflicts, operation);
  }

  // ---- 내부 구현 ----

  /**
   * 충돌을 살펴볼 저장소 루트를 조용히 찾는다.
   * - 활성 에디터 파일 → 워크스페이스 폴더 순. 경고 메시지는 띄우지 않는다.
   */
  private async resolveRepoRoot(): Promise<string | undefined> {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === "file") {
      const fromActive = await this.registry.resolve(dirNameOf(active.fsPath));
      if (fromActive) {
        return fromActive.repoRoot;
      }
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const svc = await this.registry.resolve(folder.uri.fsPath);
      if (svc) {
        return svc.repoRoot;
      }
    }
    return undefined;
  }

  /**
   * 충돌/작업 상태를 컨텍스트 키에 반영한다(뷰 노출·버튼 토글에 사용).
   * @param conflicts 충돌 파일 목록
   * @param operation 진행 중 작업 종류
   */
  private updateContext(conflicts: string[], operation: MergeOperation): void {
    void vscode.commands.executeCommand(
      "setContext",
      HAS_CONFLICTS_CONTEXT,
      conflicts.length > 0
    );
    void vscode.commands.executeCommand(
      "setContext",
      OPERATION_IN_PROGRESS_CONTEXT,
      operation !== "none"
    );
  }
}

/**
 * 경로에서 디렉터리 부분만 떼어낸다(플랫폼 구분자 모두 고려).
 * @param fsPath 파일 경로
 */
function dirNameOf(fsPath: string): string {
  const idx = Math.max(fsPath.lastIndexOf("/"), fsPath.lastIndexOf("\\"));
  return idx >= 0 ? fsPath.slice(0, idx) : fsPath;
}
