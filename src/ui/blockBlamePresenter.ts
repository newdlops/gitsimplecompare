// 블록 작성자 Code Vision을 클릭했을 때 선택 범위의 line-by-line blame을 편집기에 표시한다.
// - Git 조회는 GitBlameService에 맡기고, 이 모듈은 범위 검증과 decoration 생애주기만 담당한다.
// - Quick Pick 같은 별도 팝업을 열지 않아 소스와 각 라인의 작업자를 한 화면에서 비교할 수 있다.
import * as vscode from "vscode";
import {
  isUncommittedBlameCommit,
  normalizeBlockBlameRequest,
  type BlockBlameRequest,
} from "../git/blockBlameModel";
import { GitBlameService, type GitBlameLine } from "../git/blameService";
import type { GitServiceRegistry } from "../git/serviceRegistry";
import { logError, logInfo } from "./outputLog";

const MAX_INLINE_AUTHOR_LENGTH = 18;
const MAX_HOVER_SUMMARY_LENGTH = 180;
const BLOCK_BLAME_SHOW_CONFIG = "gitSimpleCompare.blameBlock.show";

/** GitServiceRegistry가 파일 경로에서 찾은 저장소 서비스 타입. */
type ResolvedGitService = NonNullable<
  Awaited<ReturnType<GitServiceRegistry["resolve"]>>
>;

/** 검증된 문서, 에디터, 저장소와 실제 표시할 inclusive 범위. */
interface BlockBlameTarget {
  /** blame 대상 저장 문서 */
  document: vscode.TextDocument;
  /** 라인별 decoration을 적용할 텍스트 에디터 */
  editor: vscode.TextEditor;
  /** Git blame 실행과 상대 경로 로그에 사용할 저장소 서비스 */
  service: ResolvedGitService;
  /** 문서 안으로 보정된 1-based 시작 라인 */
  startLine: number;
  /** 문서 안으로 보정된 1-based 끝 라인 */
  endLine: number;
}

/** 현재 편집기에 펼쳐진 블록 blame의 식별 정보. */
interface ActiveBlockBlame {
  /** 같은 Code Vision 재클릭 여부를 판별할 원본 요청 */
  request: BlockBlameRequest;
  /** OUTPUT 상태 로그에 남길 실제 decoration 개수 */
  decorationCount: number;
}

/**
 * Code Vision 클릭으로 열리는 블록 범위의 라인별 작성자 decoration을 관리한다.
 * - 새 블록을 클릭하면 기존 범위를 교체하고 같은 블록을 다시 클릭하면 접는다.
 * - 탭 이동, 문서 편집, 문서 닫기 때 오래된 라벨을 즉시 제거한다.
 */
export class BlockBlamePresenter implements vscode.Disposable {
  private decoration?: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private active?: ActiveBlockBlame;
  private pending?: BlockBlameRequest;
  private requestSeq = 0;
  private registered = false;
  private disposed = false;

  /**
   * 저장소 탐색에 사용할 공유 레지스트리를 주입한다.
   * @param registry 경로를 저장소별 GitService로 해석하는 레지스트리
   */
  constructor(private readonly registry: GitServiceRegistry) {}

  /**
   * decoration 타입과 오래된 블록 표시를 정리할 VS Code 이벤트를 등록한다.
   * @returns 확장 비활성화 때 함께 정리할 presenter 자신
   */
  register(): vscode.Disposable {
    if (this.registered) {
      return this;
    }
    this.registered = true;
    this.decoration = createBlockBlameDecorationType();
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (
          this.active &&
          editor?.document.uri.toString() !== this.active.request.uri
        ) {
          this.clear("activeEditorChanged");
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (
          this.active?.request.uri === event.document.uri.toString() &&
          event.contentChanges.length > 0
        ) {
          this.clear("documentChanged");
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this.active?.request.uri === document.uri.toString()) {
          this.clear("documentClosed");
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(BLOCK_BLAME_SHOW_CONFIG) &&
          !vscode.workspace
            .getConfiguration("gitSimpleCompare")
            .get<boolean>("blameBlock.show", true)
        ) {
          this.clear("codeVisionDisabled");
        }
      })
    );
    logInfo("block blame inline presenter registered");
    return this;
  }

  /**
   * command 인자를 검증하고 선택 블록의 각 라인 끝에 작성자 decoration을 펼친다.
   * - 같은 블록을 다시 클릭하면 Git을 재조회하지 않고 현재 decoration을 접는다.
   * @param rawRequest Code Vision command 또는 외부 executeCommand가 전달한 알 수 없는 값
   */
  async show(rawRequest: unknown): Promise<void> {
    const request = normalizeBlockBlameRequest(rawRequest);
    if (!request) {
      logInfo("block blame inline skipped", { reason: "invalid-request" });
      void vscode.window.showWarningMessage(
        vscode.l10n.t("The block blame request is no longer valid.")
      );
      return;
    }
    if (
      (this.active && sameBlockRequest(this.active.request, request)) ||
      (this.pending && sameBlockRequest(this.pending, request))
    ) {
      this.clear("sameCodeVisionClicked");
      return;
    }

    this.clear("replacementRequested");
    const requestId = ++this.requestSeq;
    this.pending = request;
    try {
      const target = await this.resolveTarget(request);
      if (!target || requestId !== this.requestSeq) {
        return;
      }
      const blame = await new GitBlameService(
        target.service.repoRoot
      ).getFileBlame(target.document.uri.fsPath, {
        startLine: target.startLine,
        endLine: target.endLine,
      });
      if (!this.canApplyResult(target, request, requestId)) {
        return;
      }
      if (blame.length === 0) {
        logInfo("block blame inline skipped", {
          reason: "empty-blame",
          path: target.service.toRepoRelative(target.document.uri.fsPath),
          startLine: target.startLine,
          endLine: target.endLine,
        });
        void vscode.window.showInformationMessage(
          vscode.l10n.t("No Git blame information is available for this block.")
        );
        return;
      }

      const decorations = blockBlameDecorations(target.document, blame);
      if (!this.decoration || decorations.length === 0) {
        return;
      }
      target.editor.setDecorations(this.decoration, decorations);
      this.active = { request, decorationCount: decorations.length };
      logInfo("block blame inline applied", {
        path: target.service.toRepoRelative(target.document.uri.fsPath),
        symbol: request.symbolName,
        kind: request.kind,
        startLine: target.startLine,
        endLine: target.endLine,
        lines: decorations.length,
      });
    } catch (error) {
      if (requestId !== this.requestSeq) {
        return;
      }
      logError("block blame inline failed", error, {
        uri: request.uri,
        symbol: request.symbolName,
      });
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Could not load block blame: {0}", errorMessage(error))
      );
    } finally {
      if (requestId === this.requestSeq) {
        this.pending = undefined;
      }
    }
  }

  /**
   * HEAD/index 같은 저장소 이력이 바뀌면 펼쳐진 라인 blame을 접어 stale 표시를 막는다.
   * @param reason OUTPUT에서 저장소 갱신 원인을 추적할 문자열
   */
  refresh(reason: string): void {
    if (!this.active && !this.pending) {
      return;
    }
    this.clear(`repositoryRefresh:${reason}`);
  }

  /**
   * presenter가 만든 decoration, 이벤트 listener, 진행 중 요청을 모두 정리한다.
   * @returns 반환값 없음
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clear("dispose");
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.decoration?.dispose();
    this.decoration = undefined;
  }

  /**
   * 요청 URI/문서 버전/라인 범위/저장소를 검증하고 표시할 에디터를 확보한다.
   * @param request 검증된 직렬화 command payload
   * @returns 조회와 decoration에 필요한 대상, 사용자에게 이유를 알렸으면 undefined
   */
  private async resolveTarget(
    request: BlockBlameRequest
  ): Promise<BlockBlameTarget | undefined> {
    const uri = parseFileUri(request.uri);
    if (!uri) {
      logInfo("block blame inline skipped", { reason: "non-file-uri" });
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Block blame is available only for files in a Git repository.")
      );
      return undefined;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty) {
      logInfo("block blame inline skipped", {
        reason: "dirty-document",
        path: uri.fsPath,
      });
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Save the file before viewing block blame.")
      );
      return undefined;
    }
    if (
      request.documentVersion !== undefined &&
      request.documentVersion !== document.version
    ) {
      logInfo("block blame inline skipped", {
        reason: "stale-document-version",
        expected: request.documentVersion,
        actual: document.version,
        path: uri.fsPath,
      });
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          "The file changed after this Code Vision was created. Use the refreshed block blame Code Vision."
        )
      );
      return undefined;
    }
    if (request.startLine > document.lineCount) {
      logInfo("block blame inline skipped", {
        reason: "range-outside-document",
        path: uri.fsPath,
        startLine: request.startLine,
        lineCount: document.lineCount,
      });
      void vscode.window.showInformationMessage(
        vscode.l10n.t("The selected source block no longer exists.")
      );
      return undefined;
    }
    const service = await this.registry.resolve(dirname(uri.fsPath));
    if (!service) {
      logInfo("block blame inline skipped", {
        reason: "no-repository",
        path: uri.fsPath,
      });
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Block blame is available only for files in a Git repository.")
      );
      return undefined;
    }
    const editor = await findOrShowEditor(document);
    return {
      document,
      editor,
      service,
      startLine: Math.max(1, request.startLine),
      endLine: Math.min(document.lineCount, request.endLine),
    };
  }

  /**
   * 비동기 Git 결과가 현재 요청과 활성 에디터에 여전히 맞는지 확인한다.
   * @param target 조회를 시작할 때 확정한 문서와 에디터
   * @param request Code Vision 생성 시점의 문서 버전을 포함한 요청
   * @param requestId 최신 요청만 적용하기 위한 순번
   * @returns 안전하게 decoration을 적용해도 되면 true
   */
  private canApplyResult(
    target: BlockBlameTarget,
    request: BlockBlameRequest,
    requestId: number
  ): boolean {
    const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
    return (
      requestId === this.requestSeq &&
      !target.document.isDirty &&
      activeUri === request.uri &&
      (request.documentVersion === undefined ||
        target.document.version === request.documentVersion)
    );
  }

  /**
   * 현재 펼쳐진 블록 라벨과 진행 중 요청을 취소한다.
   * @param reason OUTPUT 채널에서 접힌 원인을 확인할 상태 이름
   */
  private clear(reason: string): void {
    this.requestSeq++;
    this.pending = undefined;
    if (this.decoration) {
      for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(this.decoration, []);
      }
    }
    if (this.active) {
      logInfo("block blame inline cleared", {
        reason,
        uri: this.active.request.uri,
        symbol: this.active.request.symbolName,
        lines: this.active.decorationCount,
      });
      this.active = undefined;
    }
  }
}

/**
 * 라인 끝에 흐린 CodeLens 색상으로 작성자를 표시할 decoration 타입을 만든다.
 * @returns 블록 단위 라인 작성자 표시에만 사용하는 decoration 타입
 */
function createBlockBlameDecorationType(): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    after: {
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      margin: "0 0 0 3ch",
      textDecoration: "none; opacity: 0.82; font-style: normal",
    },
  });
}

/**
 * 범위 blame을 실제 문서 라인 끝 decoration 목록으로 변환한다.
 * @param document decoration을 적용할 문서
 * @param blame 선택 블록의 Git blame 라인
 * @returns 유효한 문서 라인에 붙일 작성자 라벨과 hover
 */
function blockBlameDecorations(
  document: vscode.TextDocument,
  blame: readonly GitBlameLine[]
): vscode.DecorationOptions[] {
  return blame
    .filter((line) => line.line >= 1 && line.line <= document.lineCount)
    .map((line) => ({
      range: document.lineAt(line.line - 1).range,
      hoverMessage: blockBlameHover(line),
      renderOptions: {
        after: { contentText: blockBlameLabel(line) },
      },
    }));
}

/**
 * 라인 끝에 표시할 `작성자 · 날짜` 요약을 만든다.
 * @param line Git blame 라인
 * @returns 편집기 폭을 과도하게 차지하지 않는 한 줄 라벨
 */
function blockBlameLabel(line: GitBlameLine): string {
  if (isUncommittedBlameCommit(line.commit)) {
    return vscode.l10n.t("Not committed yet");
  }
  const author = truncate(
    displayAuthor(line.authorName),
    MAX_INLINE_AUTHOR_LENGTH
  );
  const revision = line.authorTime
    ? shortDate(line.authorTime)
    : shortHash(line.commit);
  return `${author} · ${revision}`;
}

/**
 * 라인 라벨 hover에 전체 작성자, 메일, 커밋, 날짜, 요약을 plain text로 쌓는다.
 * @param line Git blame 라인
 * @returns 명령 링크 없이 안전하게 표시할 MarkdownString
 */
function blockBlameHover(line: GitBlameLine): vscode.MarkdownString {
  const author = displayAuthor(line.authorName);
  const identity = line.authorMail.trim()
    ? `${author} <${line.authorMail.trim()}>`
    : author;
  const revision = isUncommittedBlameCommit(line.commit)
    ? vscode.l10n.t("Working tree")
    : shortHash(line.commit);
  const date = line.authorTime
    ? shortDate(line.authorTime)
    : vscode.l10n.t("Unknown date");
  const values = [
    vscode.l10n.t("Line {0}", line.line),
    identity,
    `${revision} · ${date}`,
    truncate(line.summary.trim(), MAX_HOVER_SUMMARY_LENGTH),
  ].filter(Boolean);
  const hover = new vscode.MarkdownString();
  values.forEach((value, index) => {
    if (index > 0) {
      hover.appendMarkdown("  \n");
    }
    hover.appendText(value);
  });
  return hover;
}

/**
 * 두 요청이 같은 문서와 inclusive 범위를 가리키는지 확인한다.
 * @param left 현재 표시 중이거나 조회 중인 요청
 * @param right 새로 클릭한 Code Vision 요청
 * @returns 같은 블록이면 true
 */
function sameBlockRequest(
  left: BlockBlameRequest,
  right: BlockBlameRequest
): boolean {
  return (
    left.uri === right.uri &&
    left.startLine === right.startLine &&
    left.endLine === right.endLine
  );
}

/**
 * 이미 보이는 대상 에디터를 재사용하고 없으면 일반 편집기로 문서를 연다.
 * @param document 클릭한 Code Vision의 문서
 * @returns decoration을 적용할 활성 TextEditor
 */
async function findOrShowEditor(
  document: vscode.TextDocument
): Promise<vscode.TextEditor> {
  const uri = document.uri.toString();
  const active = vscode.window.activeTextEditor;
  if (active?.document.uri.toString() === uri) {
    return active;
  }
  const visible = vscode.window.visibleTextEditors.find(
    (editor) => editor.document.uri.toString() === uri
  );
  if (visible) {
    return vscode.window.showTextDocument(visible.document, {
      viewColumn: visible.viewColumn,
      preview: false,
      preserveFocus: false,
    });
  }
  return vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false,
  });
}

/**
 * URI 문자열을 엄격히 파싱하고 실제 file scheme만 허용한다.
 * @param value command payload의 URI 문자열
 * @returns 유효한 file URI, 파싱 실패나 다른 scheme이면 undefined
 */
function parseFileUri(value: string): vscode.Uri | undefined {
  try {
    const uri = vscode.Uri.parse(value, true);
    return uri.scheme === "file" ? uri : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 비어 있는 Git 작성자 이름을 지역화된 대체값으로 보정한다.
 * @param value git blame의 authorName
 * @returns 라인 라벨과 hover에 표시할 작성자 이름
 */
function displayAuthor(value: string): string {
  const author = value.trim();
  return author && author !== "Unknown"
    ? author
    : vscode.l10n.t("Unknown author");
}

/**
 * 커밋 해시를 라인 hover에 충분한 8자로 줄인다.
 * @param commit 전체 Git commit hash
 * @returns 앞 8자리 hash
 */
function shortHash(commit: string): string {
  return commit.slice(0, 8);
}

/**
 * Unix epoch seconds를 시간대에 흔들리지 않는 YYYY-MM-DD로 표시한다.
 * @param seconds git blame author-time
 * @returns UTC 기준 짧은 날짜 문자열
 */
function shortDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * 문자열이 지정 폭을 넘으면 끝을 말줄임표로 바꾼다.
 * @param value 원본 표시 문자열
 * @param max 허용할 최대 UTF-16 길이
 * @returns 원문 또는 폭에 맞춘 말줄임 문자열
 */
function truncate(value: string, max: number): string {
  return value.length <= max
    ? value
    : `${value.slice(0, Math.max(1, max - 3))}...`;
}

/**
 * 파일 경로의 디렉터리 부분을 플랫폼 구분자와 무관하게 반환한다.
 * @param fsPath 저장소를 탐색할 파일 경로
 * @returns 마지막 경로 구분자 앞부분
 */
function dirname(fsPath: string): string {
  const index = Math.max(fsPath.lastIndexOf("/"), fsPath.lastIndexOf("\\"));
  return index >= 0 ? fsPath.slice(0, index) : fsPath;
}

/**
 * 알 수 없는 예외를 사용자 오류 메시지에 쓸 한 줄 문자열로 바꾼다.
 * @param error Error 또는 기타 throw 값
 * @returns 표시 가능한 오류 문자열
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
