// Block Author의 실제 심볼이 확인되면 클릭 전에 편집기 참조를 준비한다. 표시/거터 폭은 건드리지 않는다.
import * as vscode from "vscode";
import type { NativeOverlayConnection } from "./nativeOverlayConnection";
import type { NativeOverlayWorkspaceHints } from "./nativeDiffOverlayMain";
import { blameOverlayPreparationExpression, blameOverlayPreparationCompletionExpression } from "./nativeBlameOverlayPatch";
import { logInfo, logWarn } from "../ui/outputLog";

interface PreparationTarget { document: vscode.TextDocument; version: number; uri: string }

/** 준비 요청을 활성 파일 하나로 합치고 이미 준비한 URI는 같은 연결에서 다시 탐색하지 않는다. */
export class NativeBlamePreparation {
  private pending?: PreparationTarget;
  private runningUri?: string;
  private readonly ready = new Set<string>();

  /** 공유 연결/창 식별/자원 소유권 기록을 주입해 실제 render와 같은 직렬 작업 안에서 준비한다. */
  constructor(private readonly connection: NativeOverlayConnection, private readonly hints: () => NativeOverlayWorkspaceHints,
    private readonly beforeEvaluate: () => void, private readonly captureWindow: (result: unknown) => void,
    private readonly refreshCodeVision: (document: vscode.TextDocument) => void = () => {}) {}

  /**
   * 심볼이 확인된 활성 저장 파일만 예약한다. 비활성 창·편집 중·숨긴 CodeLens는 준비하지 않는다.
   * @param document source block을 확인한 문서
   * @returns 새 직렬 render 작업이 필요하면 true
   */
  request(document: vscode.TextDocument): boolean {
    const target = { document, version: document.version, uri: document.uri.toString() };
    if (!this.current(target)) return false;
    if (!this.connection.isOpen()) this.ready.clear();
    if (this.ready.has(target.uri) || this.pending?.uri === target.uri || this.runningUri === target.uri) return false;
    this.pending = target;
    return true;
  }

  /** 실제 클릭/종료가 앞서면 선행 예약만 취소한다. 진행 중 준비는 표시를 만들지 않아 늦게 끝나도 안전하다. */
  clearPending(): void { this.pending = undefined; }

  /** 실제 표시가 이미 끝난 파일도 준비 완료로 기록해 후속 심볼 갱신의 중복 탐색을 막는다. */
  remember(uri: string): void {
    this.ready.delete(uri); this.ready.add(uri);
    while (this.ready.size > 32) this.ready.delete(this.ready.values().next().value!);
  }

  /**
   * native render drain에서 호출해 준비와 cleanup/표시가 같은 debugger를 동시에 변경하지 않게 한다.
   * @returns 준비 성공/실패를 OUTPUT에 남기며 실패는 실제 클릭의 정상 경로를 막지 않는다.
   */
  async runPending(): Promise<void> {
    const target = this.pending; this.pending = undefined;
    if (!target || !this.current(target) || (this.connection.isOpen() && this.ready.has(target.uri))) return;
    this.runningUri = target.uri;
    const startedAt = Date.now();
    try {
      await this.connection.ensureConnected();
      const connectMs = Date.now() - startedAt;
      if (!this.current(target)) return;
      this.beforeEvaluate();
      let result = await this.connection.evaluateMain(blameOverlayPreparationExpression(target.uri, this.hints()), 12_000);
      this.captureWindow(result);
      if (String(result).includes('blame-editor-observing')) {
        if (!this.current(target)) return;
        this.refreshCodeVision(target.document);
        const completion = await this.connection.evaluateMain(blameOverlayPreparationCompletionExpression(target.uri, this.hints()), 2000);
        if (!String(completion).includes('blame-editor-prepared')) throw new Error('The editor did not expose a live reference during Code Vision refresh.');
        result = String(result) + ',' + String(completion);
      }
      if (this.current(target)) this.remember(target.uri);
      logInfo("native blame editor prepared before click", { uri: target.uri, connectMs, durationMs: Date.now() - startedAt, result: String(result ?? "") });
    } catch (error) {
      if (this.current(target)) logWarn("native blame editor preparation skipped", {
        uri: target.uri, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error),
      });
    } finally { if (this.runningUri === target.uri) this.runningUri = undefined; }
  }

  /** 비동기 경계마다 문서/설정/포커스를 다시 확인해 다른 파일이나 닫힌 문서의 준비를 시작하지 않는다. */
  private current(target: PreparationTarget): boolean {
    const document = target.document;
    return vscode.window.state.focused && document.uri.scheme === "file" && !document.isDirty && !document.isClosed
      && document.version === target.version && vscode.window.activeTextEditor?.document.uri.toString() === target.uri
      && vscode.workspace.getConfiguration("gitSimpleCompare", document.uri).get<boolean>("blameBlock.show", true)
      && vscode.workspace.getConfiguration("editor", document.uri).get<boolean>("codeLens", true);
  }
}
