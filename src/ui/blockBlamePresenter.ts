// 블록 작성자 Code Vision을 클릭했을 때 현재 파일 전체의 line-by-line blame을 거터 옆 열에 표시한다.
// - Git 조회는 GitBlameService에 맡기고, 이 모듈은 범위 검증과 decoration 생애주기만 담당한다.
// - 배지 대신 고정폭 `작업자 · 날짜` 열을 사용해 기존 인레이와 시각적으로 분리한다.
import * as vscode from "vscode";
import {
  normalizeBlockBlameRequest,
  type BlockBlameRequest,
} from "../git/blockBlameModel";
import { GitBlameService } from "../git/blameService";
import type { GitServiceRegistry } from "../git/serviceRegistry";
import { BlockBlameGutter } from "./blockBlameGutter";
import { logError, logInfo } from "./outputLog";

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
}

/** 현재 편집기에 펼쳐진 블록 blame의 식별 정보. */
interface ActiveBlockBlame {
  /** 같은 파일의 Code Vision 재클릭 여부를 판별할 원본 요청 */
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
  private readonly gutter = new BlockBlameGutter();
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
   * 오래된 gutter 표시를 정리할 VS Code 이벤트를 등록한다.
   * @returns 확장 비활성화 때 함께 정리할 presenter 자신
   */
  register(): vscode.Disposable {
    if (this.registered) {
      return this;
    }
    this.registered = true;
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
    logInfo("block blame gutter presenter registered");
    return this;
  }

  /**
   * command 인자를 검증하고 현재 파일 모든 라인 앞 고정폭 열에 작업자·날짜를 펼친다.
   * - 같은 파일의 어느 Code Vision이든 다시 클릭하면 Git을 재조회하지 않고 현재 열을 접는다.
   * @param rawRequest Code Vision command 또는 외부 executeCommand가 전달한 알 수 없는 값
   */
  async show(rawRequest: unknown): Promise<void> {
    const request = normalizeBlockBlameRequest(rawRequest);
    if (!request) {
      logInfo("block blame gutter skipped", { reason: "invalid-request" });
      void vscode.window.showWarningMessage(
        vscode.l10n.t("The block blame request is no longer valid.")
      );
      return;
    }
    if (
      (this.active && sameDocumentRequest(this.active.request, request)) ||
      (this.pending && sameDocumentRequest(this.pending, request))
    ) {
      this.clear("sameFileCodeVisionClicked");
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
      ).getFileBlame(target.document.uri.fsPath);
      if (!this.canApplyResult(target, request, requestId)) {
        return;
      }
      if (blame.length === 0) {
        logInfo("block blame gutter skipped", {
          reason: "empty-blame",
          path: target.service.toRepoRelative(target.document.uri.fsPath),
          fileLines: target.document.lineCount,
        });
        void vscode.window.showInformationMessage(
          vscode.l10n.t("No Git blame information is available for this file.")
        );
        return;
      }

      const gutterResult = this.gutter.apply(
        target.editor,
        target.document,
        blame
      );
      if (gutterResult.lineCount === 0) {
        return;
      }
      this.active = {
        request,
        decorationCount: gutterResult.lineCount,
      };
      logInfo("block blame gutter applied", {
        path: target.service.toRepoRelative(target.document.uri.fsPath),
        symbol: request.symbolName,
        kind: request.kind,
        triggerStartLine: request.startLine,
        triggerEndLine: request.endLine,
        fileLines: target.document.lineCount,
        lines: gutterResult.lineCount,
        columnLines: gutterResult.columnLineCount,
        authors: gutterResult.authorCount,
      });
    } catch (error) {
      if (requestId !== this.requestSeq) {
        return;
      }
      logError("block blame gutter failed", error, {
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
    this.gutter.dispose();
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
      logInfo("block blame gutter skipped", { reason: "non-file-uri" });
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Block blame is available only for files in a Git repository.")
      );
      return undefined;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty) {
      logInfo("block blame gutter skipped", {
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
      logInfo("block blame gutter skipped", {
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
      logInfo("block blame gutter skipped", {
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
      logInfo("block blame gutter skipped", {
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
    this.gutter.clear();
    if (this.active) {
      logInfo("block blame gutter cleared", {
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
 * 두 요청이 같은 문서를 가리키는지 확인한다.
 * @param left 현재 표시 중이거나 조회 중인 요청
 * @param right 새로 클릭한 Code Vision 요청
 * @returns 같은 파일이면 true
 */
function sameDocumentRequest(
  left: BlockBlameRequest,
  right: BlockBlameRequest
): boolean {
  return left.uri === right.uri;
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
