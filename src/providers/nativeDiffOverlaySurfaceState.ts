// native renderer DOM이 extension host 재시작 뒤 남을 가능성을 workspace 단위로 기록한다.
// - 매 activation CDP cleanup을 피하면서 비정상 종료 때만 다음 activation이 복구하도록 한다.
import type * as vscode from "vscode";
import { logWarn } from "../ui/outputLog";

const SURFACE_PERSISTENCE_KEY = "gitSimpleCompare.nativeOverlaySurfacesMayExist";
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 같은 VS Code main process에서만 복구하도록 저장하는 renderer session 표식. */
interface PersistedSurfaceState {
  mainPid: number;
  recordedAt: number;
}

/** native overlay surface의 보수적인 잔존 가능성을 memento에 직렬로 저장한다. */
export class NativeDiffOverlaySurfaceState {
  private dirty: boolean;
  private persistence: Promise<void> = Promise.resolve();

  /**
   * @param state 현재 workspace에 귀속된 VS Code memento
   */
  constructor(private readonly state: vscode.Memento) {
    const saved = state.get<PersistedSurfaceState>(SURFACE_PERSISTENCE_KEY);
    const currentMainPid = Number(process.env.VSCODE_PID || "");
    this.dirty = Boolean(
      saved &&
      currentMainPid > 0 &&
      saved.mainPid === currentMainPid &&
      Date.now() - saved.recordedAt < MAX_SESSION_AGE_MS
    );
    if (saved && !this.dirty) {
      this.persistence = Promise.resolve(
        state.update(SURFACE_PERSISTENCE_KEY, undefined)
      ).catch((error) => {
        logWarn("stale native overlay persistence cleanup failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  /** 이전 activation이 완전한 renderer cleanup을 확인하지 못했는지 반환한다. */
  needsRecovery(): boolean {
    return this.dirty;
  }

  /**
   * 주입 시작 또는 완전한 cleanup 결과를 순서대로 기록한다.
   * @param dirty renderer DOM이 남을 가능성이 있으면 true
   * @returns 앞선 memento 갱신까지 포함한 완료 Promise
   */
  persist(dirty: boolean): Promise<void> {
    if (this.dirty === dirty) return this.persistence;
    this.dirty = dirty;
    this.persistence = this.persistence
      .then(() => this.state.update(
        SURFACE_PERSISTENCE_KEY,
        dirty
          ? {
              mainPid: Number(process.env.VSCODE_PID || ""),
              recordedAt: Date.now(),
            }
          : undefined
      ))
      .then(undefined, (error) => {
        logWarn("native overlay persistence update failed", {
          dirty,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return this.persistence;
  }
}
