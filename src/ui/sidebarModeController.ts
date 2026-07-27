// Changes/Reviews 사이드바 전환을 단일 host state로 조정한다.
// - view ID를 바꾸지 않고 context key만 전환해 기존 command, view state와 workspace를 보존한다.
import type * as vscode from "vscode";
import {
  createSidebarModeState,
  readSidebarModeState,
  SIDEBAR_MODE_STATE_KEY,
  type SidebarMode,
} from "./sidebarModeState";

/** sidebar mode 전환에 필요한 VS Code 명령의 작은 의존성 계약. */
export type SidebarModeCommandExecutor = Pick<typeof vscode.commands, "executeCommand">;

/** controller 상태 전환을 Output channel에 남기는 최소 logging 계약. */
export type SidebarModeLogger = (
  message: string,
  detail: Record<string, unknown>
) => void;

/** Changes/Reviews 중 하나만 보이는 sidebar container를 제어한다. */
export class SidebarModeController {
  private mode: SidebarMode = "changes";
  /** 빠른 연속 클릭에도 persist → context → focus 순서를 보존하는 직렬 작업열. */
  private pending: Promise<void> = Promise.resolve();

  /**
   * controller를 만든다.
   * @param workspaceState workspace별 마지막 선택 surface 저장소
   * @param commands context key 설정과 view focus를 실행할 VS Code 명령 API
   * @param logInfo 상태 전환을 기록할 Output logger
   */
  public constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly commands: SidebarModeCommandExecutor,
    private readonly logInfo: SidebarModeLogger = () => undefined
  ) {}

  /** 현재 확장 process가 적용한 sidebar mode를 반환한다. */
  public get currentMode(): SidebarMode {
    return this.mode;
  }

  /**
   * workspaceState에서 마지막 mode를 복원하고 view contribution context를 초기화한다.
   * - 초기화에서는 사용자가 작업 중인 editor focus를 빼앗지 않는다.
   * @returns context key 적용이 끝나는 Promise
   */
  public initialize(): Promise<void> {
    return this.enqueue(async () => {
      const stored = readSidebarModeState(
        this.workspaceState.get<unknown>(SIDEBAR_MODE_STATE_KEY)
      );
      this.mode = stored.mode;
      if (stored.needsMigration) {
        await this.workspaceState.update(
          SIDEBAR_MODE_STATE_KEY,
          createSidebarModeState(stored.mode)
        );
      }
      await this.applyContext(stored.mode);
      this.logInfo("sidebar mode initialized", {
        mode: stored.mode,
        migrated: stored.needsMigration,
      });
    });
  }

  /**
   * 사용자가 선택한 surface를 영속화하고 해당 contributed view로 포커스를 옮긴다.
   * @param mode 보여 줄 최상위 sidebar surface
   * @returns persist → context → focus 순서가 끝나는 Promise
   */
  public select(mode: SidebarMode): Promise<void> {
    return this.enqueue(async () => {
      await this.workspaceState.update(
        SIDEBAR_MODE_STATE_KEY,
        createSidebarModeState(mode)
      );
      this.mode = mode;
      await this.applyContext(mode);
      await this.commands.executeCommand(`gitSimpleCompare.${mode}.focus`);
      this.logInfo("sidebar mode selected", { mode });
    });
  }

  /**
   * contribution의 when 절이 읽는 mode context key를 갱신한다.
   * @param mode Changes 또는 Reviews 표시 여부를 결정할 값
   */
  private async applyContext(mode: SidebarMode): Promise<void> {
    await this.commands.executeCommand(
      "setContext",
      SIDEBAR_MODE_STATE_KEY,
      mode
    );
  }

  /**
   * 비동기 전환을 직렬화해 늦은 setContext/focus가 최신 선택을 덮지 않게 한다.
   * @param operation 하나의 mode 전환 작업
   * @returns 호출자가 오류를 관찰할 수 있는 작업 Promise
   */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => undefined);
    return next;
  }
}
