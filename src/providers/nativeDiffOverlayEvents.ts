// native diff overlay renderer 에서 올라오는 binding payload 를 처리한다.
// - CDP 연결 관리는 controller 에 남기고, checkbox/context row 이벤트 해석만 분리한다.
import { HunkCheckboxController } from "./hunkCheckboxController";
import { rememberHunkContextLine } from "./hunkContextLineStore";
import { logInfo, logWarn } from "../ui/outputLog";
import type {
  ConflictOverlayAction,
  ConflictOverlayActionHandler,
  ConflictOverlayActionPayload,
} from "./conflictOverlayProtocol";

interface OverlayEventPayload {
  type?: string;
  uri?: string;
  lineIds?: string[];
  side?: "original" | "modified";
  line?: number;
  column?: number;
  marker?: string;
  text?: string;
  checked?: boolean;
  action?: string;
  sessionId?: string;
  revision?: number;
  editorVersion?: number;
}

/** renderer checkbox/contextmenu 이벤트를 hunk checkbox controller 호출로 변환한다. */
export class NativeDiffOverlayEvents {
  private lastToggleKey = "";
  private lastToggleAt = 0;

  constructor(
    private readonly hunkCheckboxes: HunkCheckboxController,
    private readonly conflictActions?: ConflictOverlayActionHandler
  ) {}

  /**
   * renderer binding payload 를 처리한다.
   * @param payload JSON 직렬화된 renderer 이벤트
   */
  handle(payload: string): void {
    try {
      const parsed = JSON.parse(payload) as OverlayEventPayload;
      if (parsed.type === "conflictAction") {
        this.handleConflictAction(parsed);
        return;
      }
      const visibleSide =
        parsed.side === "original" || parsed.side === "modified"
          ? parsed.side
          : undefined;
      const visibleLine =
        typeof parsed.line === "number" && Number.isFinite(parsed.line)
          ? parsed.line
          : undefined;
      const visibleColumn =
        typeof parsed.column === "number" && Number.isFinite(parsed.column)
          ? parsed.column
          : undefined;
      const visibleText = typeof parsed.text === "string" ? parsed.text : undefined;
      if (parsed.type === "contextLine") {
        this.rememberContextLine(parsed, visibleSide, visibleLine, visibleColumn, visibleText);
        return;
      }
      this.handleToggle(parsed, visibleSide, visibleLine, visibleColumn, visibleText);
    } catch (error) {
      logWarn("native diff overlay payload ignored", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** renderer의 conflict button payload를 좁혀 versioned host action handler로 전달한다. */
  private handleConflictAction(parsed: OverlayEventPayload): void {
    if (
      !this.conflictActions || !parsed.uri || !parsed.sessionId ||
      !isConflictAction(parsed.action) ||
      typeof parsed.revision !== "number" || !Number.isInteger(parsed.revision) ||
      typeof parsed.editorVersion !== "number" || !Number.isInteger(parsed.editorVersion)
    ) {
      logWarn("native conflict overlay payload ignored", {
        uri: parsed.uri,
        action: parsed.action,
        sessionId: parsed.sessionId,
      });
      return;
    }
    const payload: ConflictOverlayActionPayload = {
      type: "conflictAction",
      action: parsed.action,
      uri: parsed.uri,
      sessionId: parsed.sessionId,
      revision: parsed.revision,
      editorVersion: parsed.editorVersion,
    };
    this.conflictActions.handleRendererAction(payload);
  }

  /** context menu 가 열린 visible row 를 저장한다. */
  private rememberContextLine(
    parsed: OverlayEventPayload,
    side: "original" | "modified" | undefined,
    line: number | undefined,
    column: number | undefined,
    text: string | undefined
  ): void {
    if (!parsed.uri || !side || !line) {
      return;
    }
    rememberHunkContextLine({
      uri: parsed.uri,
      side,
      line,
      column,
      marker: parsed.marker,
      text,
      lineIds: Array.isArray(parsed.lineIds) ? parsed.lineIds : [],
    });
  }

  /** checkbox toggle payload 를 hunk checkbox controller 로 전달한다. */
  private handleToggle(
    parsed: OverlayEventPayload,
    side: "original" | "modified" | undefined,
    line: number | undefined,
    column: number | undefined,
    text: string | undefined
  ): void {
    if (!parsed.uri || !Array.isArray(parsed.lineIds)) {
      return;
    }
    const key = [
      parsed.uri,
      parsed.checked ? "1" : "0",
      parsed.lineIds.join("\0"),
      side ?? "",
      line ?? "",
      column ?? "",
      parsed.marker ?? "",
    ].join("\0");
    const now = Date.now();
    if (key === this.lastToggleKey && now - this.lastToggleAt < 250) {
      logInfo("native diff overlay duplicate toggle ignored", {
        uri: parsed.uri,
        lineIds: parsed.lineIds.length,
        side,
        line,
        column,
      });
      return;
    }
    this.lastToggleKey = key;
    this.lastToggleAt = now;
    logInfo("native diff overlay toggle received", {
      uri: parsed.uri,
      lineIds: parsed.lineIds.length,
      side,
      line,
      column,
      marker: parsed.marker,
      checked: parsed.checked,
    });
    if (side && line) {
      void this.hunkCheckboxes.toggleVisible(
        parsed.uri,
        { side, line, column, marker: parsed.marker, text },
        parsed.checked,
        parsed.lineIds
      );
    } else {
      this.hunkCheckboxes.toggle(parsed.uri, parsed.lineIds, parsed.checked, side);
    }
  }
}

/** wire 문자열이 허용된 conflict action인지 확인한다. */
function isConflictAction(value: string | undefined): value is ConflictOverlayAction {
  return [
    "acceptCurrent",
    "acceptIncoming",
    "acceptBoth",
    "markResolved",
    "openMergeEditor",
    "reload",
    "showDetails",
  ].includes(value ?? "");
}
