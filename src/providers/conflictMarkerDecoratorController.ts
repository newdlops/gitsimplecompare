// conflict marker 가 남아 있는 파일에 역할별 색상 decoration 을 적용하는 컨트롤러.
// - VS Code 내장 merge editor 흐름은 그대로 두고, 일반 text editor 로 노출되는 결과 파일의
//   <<<<<<< / ======= / >>>>>>> 블록을 Current, Base, Incoming 으로 구분해 표시한다.
import * as vscode from "vscode";
import {
  ConflictService,
  type ConflictSource,
  type ConflictSources,
} from "../git/conflictService";
import { GitServiceRegistry } from "../git/serviceRegistry";
import { logError, logInfo } from "../ui/outputLog";
import {
  scanConflictMarkers,
  type ConflictMarkerKind,
  type ConflictMarkerScan,
} from "../utils/conflictMarkerModel";
import type { ConflictEditorOverlayController } from "./conflictEditorOverlayController";

const REFRESH_DELAY_MS = 120;

interface ConflictDecorations {
  current: vscode.TextEditorDecorationType;
  base: vscode.TextEditorDecorationType;
  incoming: vscode.TextEditorDecorationType;
  marker: vscode.TextEditorDecorationType;
}

/** 에디터별로 마지막 적용 문서와 version을 보관해 다른 파일 편집의 재도색을 막는다. */
interface AppliedDocument {
  document: vscode.TextDocument;
  version: number;
}

/**
 * 보이는 text editor 의 conflict marker 블록을 색상으로 구분한다.
 * - Current/Ours 는 파란색, Incoming/Theirs 는 초록색, Base 는 회색으로 표시해
 *   VS Code 기본 노란 marker 강조만으로는 구분하기 어려운 상황을 보완한다.
 */
export class ConflictMarkerDecoratorController implements vscode.Disposable {
  private readonly decorations = createDecorationTypes();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly appliedDocuments = new WeakMap<vscode.TextEditor, AppliedDocument>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private requestSeq = 0;
  private disposed = false;

  constructor(
    private readonly registry: GitServiceRegistry,
    private readonly conflictOverlay?: ConflictEditorOverlayController
  ) {}

  /**
   * 활성/보이는 문서 변경 이벤트를 등록하고 현재 에디터에 decoration 을 적용한다.
   * @returns 확장 비활성화 시 함께 정리될 Disposable
   */
  register(): vscode.Disposable {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() =>
        this.scheduleRefresh("activeEditor")
      ),
      vscode.window.onDidChangeVisibleTextEditors(() =>
        this.scheduleRefresh("visibleEditors")
      ),
      vscode.workspace.onDidChangeTextDocument((event) => {
        // OUTPUT 로그도 문서 변경 이벤트를 발생시킨다. 예약 전에 제외해야
        // decoration 적용 로그 → OUTPUT 변경 → 재적용의 자기 갱신 순환을 끊는다.
        if (event.contentChanges.length > 0 && this.isVisibleTarget(event.document)) {
          this.scheduleRefresh("documentChanged");
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.isVisibleTarget(document)) {
          this.scheduleRefresh("documentSaved");
        }
      })
    );
    this.scheduleRefresh("register", 0);
    return this;
  }

  /**
   * 타이머, 이벤트 리스너, decoration type 을 모두 정리한다.
   * - VS Code 가 확장을 끌 때 남은 decoration 이 다음 세션에 재사용되지 않도록 비운다.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.requestSeq++;
    this.clearVisibleDecorations();
    for (const decoration of Object.values(this.decorations)) {
      decoration.dispose();
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  /**
   * 짧은 지연 뒤 보이는 모든 파일 에디터를 다시 검사한다.
   * - 빠른 편집/탭 이동 중에는 마지막 이벤트만 처리해 불필요한 git 조회를 줄인다.
   * @param reason 갱신을 예약한 이벤트 이름
   * @param delay  예약 지연 시간(ms)
   */
  private scheduleRefresh(reason: string, delay = REFRESH_DELAY_MS): void {
    if (this.disposed) {
      return;
    }
    const requestId = ++this.requestSeq;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshVisibleEditors(reason, requestId).catch((error) => {
        logError("conflict marker decorators refresh failed", error, { reason });
      });
    }, delay);
  }

  /**
   * 현재 보이는 file editor 들에 conflict marker decoration 을 적용한다.
   * - marker 가 없는 일반 파일에는 git 명령을 실행하지 않고 decoration 만 비운다.
   * @param reason    갱신 원인
   * @param requestId stale 비동기 결과를 버리기 위한 요청 번호
   */
  private async refreshVisibleEditors(
    reason: string,
    requestId: number
  ): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      if (requestId !== this.requestSeq || this.disposed) {
        return;
      }
      const document = editor.document;
      if (!this.isVisibleTarget(document)) {
        this.clearEditorDecorations(editor);
        continue;
      }
      const applied = this.appliedDocuments.get(editor);
      // 편집 이벤트는 실제로 바뀐 문서만 갱신한다. 저장/탭 이동에서는 같은
      // version이어도 출처 metadata를 다시 읽어 Git 작업 상태 변화에 대응한다.
      if (reason === "documentChanged" && applied?.document === document &&
          applied.version === document.version) {
        continue;
      }
      const snapshot = { document, version: document.version };
      const groups = scanConflictMarkers(document.getText());
      if (groups.blocks.length === 0) {
        this.clearEditorDecorations(editor);
        continue;
      }
      await this.applyEditorDecorations(editor, snapshot, groups, reason, requestId);
    }
  }

  /**
   * 한 에디터에 Current/Base/Incoming/Marker decoration 을 실제로 설정한다.
   * - 충돌 stage 메타데이터 조회가 실패해도 색상 구분은 계속 적용한다.
   * @param editor    적용 대상 에디터
   * @param snapshot  파싱 당시 문서와 version. 조회 중 편집/닫기가 발생하면 폐기한다.
   * @param groups    conflict marker 파싱 결과
   * @param reason    갱신 원인
   * @param requestId stale 비동기 결과를 버리기 위한 요청 번호
   */
  private async applyEditorDecorations(
    editor: vscode.TextEditor,
    snapshot: AppliedDocument,
    groups: ConflictMarkerScan,
    reason: string,
    requestId: number
  ): Promise<void> {
    const conflictSession = this.conflictOverlay?.sessionForUri(editor.document.uri);
    const service = conflictSession
      ? undefined
      : await this.registry.resolve(dirname(editor.document.uri.fsPath));
    if (!this.isCurrentEditor(editor, snapshot, requestId)) {
      return;
    }
    if (!service && !conflictSession) {
      this.clearEditorDecorations(editor);
      logInfo("conflict marker decorators skipped", {
        reason,
        target: "no-repo",
        path: editor.document.uri.fsPath,
      });
      return;
    }

    const repoRoot = conflictSession?.service.repoRoot ?? service!.repoRoot;
    const rel = conflictSession?.rel ?? service!.toRepoRelative(editor.document.uri.fsPath);
    let sources: ConflictSources | undefined;
    try {
      sources = await new ConflictService(repoRoot).getConflictSources();
    } catch (error) {
      logInfo("conflict marker metadata unavailable", {
        reason,
        path: rel,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (!this.isCurrentEditor(editor, snapshot, requestId)) {
      return;
    }

    // Git 조회가 끝날 때까지 기존 decoration을 유지하고, 각 역할의 최신 범위를
    // 빈 배열을 거치는 중간 프레임 없이 바로 교체해 큰 충돌 파일의 깜박임을 막는다.
    const hovers = createHovers(sources);
    editor.setDecorations(
      this.decorations.current,
      lineOptions(editor.document, groups.current, hovers.current)
    );
    editor.setDecorations(
      this.decorations.base,
      lineOptions(editor.document, groups.base, hovers.base)
    );
    editor.setDecorations(
      this.decorations.incoming,
      lineOptions(editor.document, groups.incoming, hovers.incoming)
    );
    editor.setDecorations(
      this.decorations.marker,
      markerOptions(editor.document, groups.markers, hovers)
    );
    this.appliedDocuments.set(editor, snapshot);
    logInfo("conflict marker decorators applied", {
      reason,
      path: rel,
      documentVersion: snapshot.version,
      blocks: groups.blocks.length,
      currentLines: groups.current.length,
      baseLines: groups.base.length,
      incomingLines: groups.incoming.length,
    });
  }

  /**
   * 이벤트 문서가 실제로 강조할 수 있는 보이는 문서인지 예약 전에 검사한다.
   * @param document file 또는 controller 소유 Result 문서 후보
   * @returns OUTPUT/다른 가상 문서/닫힌 문서는 false이며 로그도 남기지 않아 재귀 이벤트를 막는다.
   */
  private isVisibleTarget(document: vscode.TextDocument): boolean {
    return !document.isClosed &&
      (document.uri.scheme === "file" || !!this.conflictOverlay?.ownsUri(document.uri)) &&
      hasVisibleDocument(document);
  }

  /**
   * 비동기 조회 이후에도 같은 에디터/문서/version이 보이는 최신 요청인지 검증한다.
   * @param editor 적용할 에디터 인스턴스
   * @param snapshot conflict marker를 파싱한 문서와 version
   * @param requestId 최신 예약과 비교할 요청 번호
   * @returns 편집·탭 교체·닫기·dispose로 낡아진 결과이면 false
   */
  private isCurrentEditor(
    editor: vscode.TextEditor,
    snapshot: AppliedDocument,
    requestId: number
  ): boolean {
    return !this.disposed && requestId === this.requestSeq &&
      editor.document === snapshot.document && !snapshot.document.isClosed &&
      snapshot.document.version === snapshot.version &&
      vscode.window.visibleTextEditors.includes(editor);
  }

  /** 모든 보이는 에디터에서 이 컨트롤러가 만든 decoration 을 제거한다. */
  private clearVisibleDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.clearEditorDecorations(editor);
    }
  }

  /**
   * 한 에디터에서 Current/Base/Incoming/Marker decoration 을 제거한다.
   * @param editor decoration 을 비울 에디터
   */
  private clearEditorDecorations(editor: vscode.TextEditor): void {
    if (!this.appliedDocuments.delete(editor)) return;
    editor.setDecorations(this.decorations.current, []);
    editor.setDecorations(this.decorations.base, []);
    editor.setDecorations(this.decorations.incoming, []);
    editor.setDecorations(this.decorations.marker, []);
  }
}

/** 역할별 decoration type 을 만든다. */
function createDecorationTypes(): ConflictDecorations {
  return {
    current: createBlockDecoration("rgba(55, 148, 255, 0.16)", "#3794ff"),
    base: createBlockDecoration("rgba(128, 128, 128, 0.13)", "#808080"),
    incoming: createBlockDecoration("rgba(46, 160, 67, 0.18)", "#2ea043"),
    marker: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: "rgba(204, 167, 0, 0.12)",
      overviewRulerColor: "#cca700",
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    }),
  };
}

/**
 * conflict 본문 블록용 decoration type 을 만든다.
 * @param backgroundColor editor 배경색 위에 얹을 반투명 색
 * @param rulerColor      overview ruler 에 표시할 색
 */
function createBlockDecoration(
  backgroundColor: string,
  rulerColor: string
): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor,
    overviewRulerColor: rulerColor,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}

interface RoleHovers {
  current: vscode.MarkdownString;
  base: vscode.MarkdownString;
  incoming: vscode.MarkdownString;
  currentMarker: vscode.MarkdownString;
  baseMarker: vscode.MarkdownString;
  incomingMarker: vscode.MarkdownString;
  endMarker: vscode.MarkdownString;
}

/**
 * 역할별 hover 메시지를 만든다.
 * @param sources git 작업 상태와 Current/Incoming ref 메타데이터
 */
function createHovers(sources: ConflictSources | undefined): RoleHovers {
  const rebase = sources?.operation === "rebase";
  const replay = rebase && sources?.incoming.ref === "REBASE_HEAD";
  const currentRole = rebase
    ? vscode.l10n.t("Current / Ours · new base plus commits already replayed")
    : vscode.l10n.t("Current / Ours");
  const incomingRole = replay
    ? vscode.l10n.t("Incoming / Theirs · commit currently being replayed")
    : rebase
      ? vscode.l10n.t("Incoming / Theirs · active nested operation during rebase")
    : vscode.l10n.t("Incoming / Theirs");
  const currentText = sideHoverText(currentRole, sources?.current, "HEAD");
  const incomingText = sideHoverText(
    incomingRole,
    sources?.incoming,
    "theirs"
  );
  const baseText = replay
    ? vscode.l10n.t("Base section\nOriginal parent snapshot for the replayed patch.")
    : vscode.l10n.t("Base section\nCommon ancestor from diff3 conflict markers.");
  return {
    current: plainHover(currentText),
    base: plainHover(baseText),
    incoming: plainHover(incomingText),
    currentMarker: plainHover(vscode.l10n.t("Conflict block starts\n{0}", currentText)),
    baseMarker: plainHover(vscode.l10n.t("Base section starts\n{0}", baseText)),
    incomingMarker: plainHover(
      vscode.l10n.t("Incoming / Theirs section starts\n{0}", incomingText)
    ),
    endMarker: plainHover(vscode.l10n.t("Conflict block ends")),
  };
}

/**
 * Current/Incoming hover 설명에 들어갈 원문 문자열을 만든다.
 * @param role        사용자에게 보여줄 역할 이름
 * @param side        충돌 한쪽 버전의 ref/commit 정보
 * @param fallbackRef ref 를 읽지 못했을 때 표시할 기본 이름
 */
function sideHoverText(
  role: string,
  side: ConflictSource | undefined,
  fallbackRef: string
): string {
  const pieces = [role, side?.ref || fallbackRef];
  const hash = shortHash(side?.commit);
  if (hash) {
    pieces.push(hash);
  }
  if (side?.subject) {
    pieces.push(side.subject);
  }
  const identity = pieces.filter(Boolean).join(" · ");
  const fileHash = shortHash(side?.fileCommit);
  if (!fileHash || side?.fileCommit === side?.commit) return identity;
  return `${identity}\n${vscode.l10n.t(
    "This file was last changed by {0} {1}",
    fileHash,
    side?.fileSubject || ""
  )}`;
}

/**
 * 일반 문자열 hover 를 MarkdownString 으로 감싼다.
 * @param text hover 에 표시할 텍스트
 */
function plainHover(text: string): vscode.MarkdownString {
  const hover = new vscode.MarkdownString();
  hover.isTrusted = false;
  hover.supportHtml = false;
  hover.appendText(text);
  return hover;
}

/**
 * line number 배열을 VS Code DecorationOptions 로 변환한다.
 * @param document 적용 대상 문서
 * @param lines    zero-based line number 배열
 * @param hover    각 라인에 붙일 hover
 */
function lineOptions(
  document: vscode.TextDocument,
  lines: number[],
  hover: vscode.MarkdownString
): vscode.DecorationOptions[] {
  return lines.map((line) => ({
    range: document.lineAt(line).range,
    hoverMessage: hover,
  }));
}

/**
 * marker line 배열을 VS Code DecorationOptions 로 변환한다.
 * @param document 적용 대상 문서
 * @param markers  marker line 정보
 * @param hovers   marker 종류별 hover 묶음
 */
function markerOptions(
  document: vscode.TextDocument,
  markers: ConflictMarkerScan["markers"],
  hovers: RoleHovers
): vscode.DecorationOptions[] {
  return markers.map((marker) => ({
    range: document.lineAt(marker.line).range,
    hoverMessage: markerHover(marker.kind, hovers),
  }));
}

/**
 * marker 종류에 맞는 hover 를 고른다.
 * @param kind   marker 의 역할
 * @param hovers 역할별 hover 묶음
 */
function markerHover(
  kind: ConflictMarkerKind,
  hovers: RoleHovers
): vscode.MarkdownString {
  if (kind === "current-start") {
    return hovers.currentMarker;
  }
  if (kind === "base-start") {
    return hovers.baseMarker;
  }
  if (kind === "incoming-start") {
    return hovers.incomingMarker;
  }
  return hovers.endMarker;
}

/** 현재 보이는 에디터 중 같은 문서를 표시하는 항목이 있는지 확인한다. */
function hasVisibleDocument(document: vscode.TextDocument): boolean {
  return vscode.window.visibleTextEditors.some(
    (editor) => editor.document.uri.toString() === document.uri.toString()
  );
}

/** 파일 경로의 디렉터리 부분을 플랫폼 구분자와 무관하게 반환한다. */
function dirname(fsPath: string): string {
  const index = Math.max(fsPath.lastIndexOf("/"), fsPath.lastIndexOf("\\"));
  return index >= 0 ? fsPath.slice(0, index) : fsPath;
}

/** 커밋 해시를 hover 에 표시하기 좋은 짧은 형태로 줄인다. */
function shortHash(commit: string | undefined): string {
  return commit ? commit.slice(0, 12) : "";
}
