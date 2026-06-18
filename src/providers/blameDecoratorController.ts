// 활성 에디터 왼쪽에 git blame 라벨을 decoration 으로 표시하는 컨트롤러.
// - VS Code Git 확장의 blame editor decoration/hover 는 built-in 설정을 그대로 토글한다.
// - 이 모듈은 별도 왼쪽 라인 라벨 표시와 view/title 메뉴 context 만 담당한다.
import * as vscode from "vscode";
import { GitBlameService } from "../git/blameService";
import type { GitBlameLine } from "../git/blameService";
import { GitServiceRegistry } from "../git/serviceRegistry";
import { logInfo } from "../ui/outputLog";

const EXT_CONFIG_SECTION = "gitSimpleCompare";
const GIT_CONFIG_SECTION = "git";
const GIT_BLAME_DECORATION_KEY = "blame.editorDecoration.enabled";
const LINE_SHOW_KEY = "blameLine.show";
const FULL_GIT_BLAME_DECORATION_KEY =
  `${GIT_CONFIG_SECTION}.${GIT_BLAME_DECORATION_KEY}`;
const FULL_LINE_SHOW_KEY = `${EXT_CONFIG_SECTION}.${LINE_SHOW_KEY}`;
const DECORATOR_CONTEXT = "gitSimpleCompare.blame.decorator.enabled";
const LINE_CONTEXT = "gitSimpleCompare.blame.line.visible";
const REFRESH_DELAY_MS = 120;

/** view/title 메뉴와 라인 표시 컨트롤러가 공유하는 blame 표시 상태. */
export interface BlameDecoratorState {
  /** VS Code Git 확장의 built-in blame editor decoration 설정값 */
  enabled: boolean;
  /** Git Simple Compare 가 라인 시작 앞에 blame 텍스트를 보일지 여부 */
  lineVisible: boolean;
}

/**
 * 활성 텍스트 에디터의 왼쪽 blame 라벨 decoration 을 관리한다.
 * - built-in decorator 토글은 `git.blame.editorDecoration.enabled` 를 변경해 VS Code Git 확장에 맡긴다.
 * - line visible on 일 때만 별도 before 영역에 작성자/날짜 요약을 표시한다.
 */
export class BlameDecoratorController implements vscode.Disposable {
  private decoration?: vscode.TextEditorDecorationType;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private state = readBlameConfig();
  private requestSeq = 0;
  private disposed = false;

  constructor(private readonly registry: GitServiceRegistry) {
    this.decoration = createDecorationType(this.state.lineVisible);
  }

  /**
   * VS Code 이벤트 리스너를 등록하고 현재 활성 에디터에 즉시 상태를 반영한다.
   * @returns 확장 비활성화 시 정리할 Disposable
   */
  register(): vscode.Disposable {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() =>
        this.scheduleRefresh("activeEditor")
      ),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (isActiveDocument(document)) {
          this.scheduleRefresh("documentSaved");
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isActiveDocument(event.document) && event.document.isDirty) {
          this.requestSeq++;
          this.clearVisibleDecorations();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(FULL_GIT_BLAME_DECORATION_KEY) ||
          event.affectsConfiguration(FULL_LINE_SHOW_KEY)
        ) {
          this.applyConfigState("configuration");
        }
      })
    );
    this.applyConfigState("register");
    return this;
  }

  /**
   * 현재 저장된 blame 표시 상태를 반환한다.
   * - enabled 는 VS Code Git 확장 설정, lineVisible 은 이 확장의 왼쪽 라벨 설정이다.
   */
  getState(): BlameDecoratorState {
    return {
      enabled: this.state.enabled,
      lineVisible: this.state.lineVisible,
    };
  }

  /**
   * VS Code Git 확장의 blame editor decoration 을 켜거나 끈다.
   * - hover 내용과 after-line decoration 은 Source Control 구현이 그대로 제공한다.
   */
  async toggleDecorator(): Promise<void> {
    const next = !this.state.enabled;
    await vscode.workspace
      .getConfiguration(GIT_CONFIG_SECTION)
      .update(
        GIT_BLAME_DECORATION_KEY,
        next,
        vscode.ConfigurationTarget.Global
      );
    logInfo("vscode git blame decorator toggled", { enabled: next });
    this.applyConfigState("toggleDecorator");
  }

  /**
   * 라인 앞 blame 텍스트 표시를 켜거나 끈다.
   * - hover 는 만들지 않는다. hover 는 VS Code Git 확장의 blame decorator 가 담당한다.
   */
  async toggleLineVisible(): Promise<void> {
    const nextLineVisible = !this.state.lineVisible;
    const config = vscode.workspace.getConfiguration(EXT_CONFIG_SECTION);
    await config.update(
      LINE_SHOW_KEY,
      nextLineVisible,
      vscode.ConfigurationTarget.Global
    );
    logInfo("blame line visibility toggled", {
      lineVisible: nextLineVisible,
    });
    this.applyConfigState("toggleLineVisible");
  }

  /**
   * 컨트롤러가 만든 timer, decoration, event listener 를 모두 정리한다.
   * - VS Code 가 확장을 비활성화할 때 context.subscriptions 를 통해 호출된다.
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
    this.decoration?.dispose();
    this.decoration = undefined;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  /**
   * 설정에서 최신 상태를 읽어 decoration 타입과 에디터 표시를 갱신한다.
   * @param reason 상태 변경을 일으킨 이벤트 이름(OUTPUT 추적용)
   */
  private applyConfigState(reason: string): void {
    const previous = this.getState();
    this.state = readBlameConfig();
    this.recreateDecorationIfNeeded(previous.lineVisible);
    const next = this.getState();
    void syncBlameContexts(next);
    const changed =
      previous.enabled !== next.enabled ||
      previous.lineVisible !== next.lineVisible;
    if (!changed && reason === "configuration") {
      return;
    }
    if (!next.lineVisible) {
      this.requestSeq++;
      this.clearVisibleDecorations();
      logInfo("blame line decoration disabled", {
        reason,
        decoratorEnabled: next.enabled,
      });
      return;
    }
    logInfo("blame line decoration enabled", {
      reason,
      decoratorEnabled: next.enabled,
    });
    this.scheduleRefresh(reason);
  }

  /**
   * 라인 표시 여부가 바뀌면 decoration type 을 다시 만들어 before 영역 스타일을 갱신한다.
   * @param previousLineVisible 직전 effective lineVisible 값
   */
  private recreateDecorationIfNeeded(previousLineVisible: boolean): void {
    const nextLineVisible = this.state.lineVisible;
    if (previousLineVisible === nextLineVisible && this.decoration) {
      return;
    }
    this.clearVisibleDecorations();
    this.decoration?.dispose();
    this.decoration = createDecorationType(nextLineVisible);
  }

  /**
   * 짧은 지연 후 활성 에디터의 blame 을 다시 읽는다.
   * - 빠른 탭 이동/저장 이벤트를 한 번으로 합쳐 불필요한 git blame 실행을 줄인다.
   * @param reason refresh 를 예약한 이벤트 이름
   */
  private scheduleRefresh(reason: string): void {
    if (!this.state.lineVisible || this.disposed) {
      return;
    }
    const requestId = ++this.requestSeq;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshActiveEditor(reason, requestId);
    }, REFRESH_DELAY_MS);
  }

  /**
   * 현재 활성 에디터에 blame decoration 을 적용한다.
   * - file 문서가 아니거나 저장소 밖이면 표시를 비우고 조용히 종료한다.
   * @param reason refresh 를 유발한 이벤트 이름
   */
  private async refreshActiveEditor(
    reason: string,
    requestId: number
  ): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    this.clearVisibleDecorations();
    if (!this.state.lineVisible || !editor || !this.decoration) {
      return;
    }
    if (editor.document.uri.scheme !== "file") {
      logInfo("blame decorator skipped", { reason, target: "non-file" });
      return;
    }
    if (editor.document.isDirty) {
      logInfo("blame decorator skipped", { reason, target: "dirty-document" });
      return;
    }

    const service = await this.registry.resolve(dirname(editor.document.uri.fsPath));
    if (requestId !== this.requestSeq || !this.state.lineVisible) {
      return;
    }
    if (!service) {
      logInfo("blame decorator skipped", { reason, target: "no-repo" });
      return;
    }

    try {
      const blame = await new GitBlameService(service.repoRoot).getFileBlame(
        editor.document.uri.fsPath
      );
      if (requestId !== this.requestSeq || !this.state.lineVisible) {
        return;
      }
      editor.setDecorations(
        this.decoration,
        blameToDecorations(editor.document, blame)
      );
      logInfo("blame decorator applied", {
        reason,
        path: service.toRepoRelative(editor.document.uri.fsPath),
        lines: blame.length,
        lineVisible: this.state.lineVisible,
      });
    } catch (error) {
      logInfo("blame decorator failed", {
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 모든 보이는 에디터에서 현재 blame decoration 을 제거한다. */
  private clearVisibleDecorations(): void {
    if (!this.decoration) {
      return;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.decoration, []);
    }
  }
}

/**
 * 설정에서 blame 표시 상태를 읽는다.
 * @returns built-in Git blame decoration 과 Git Simple Compare 라인 표시 설정값
 */
function readBlameConfig(): BlameDecoratorState {
  const gitConfig = vscode.workspace.getConfiguration(GIT_CONFIG_SECTION);
  const extensionConfig = vscode.workspace.getConfiguration(EXT_CONFIG_SECTION);
  return {
    enabled: gitConfig.get<boolean>(GIT_BLAME_DECORATION_KEY, false),
    lineVisible: extensionConfig.get<boolean>(LINE_SHOW_KEY, false),
  };
}

/**
 * view/title 메뉴의 checked/unchecked 항목을 고르기 위한 context key 를 갱신한다.
 * @param state 현재 blame 표시 상태
 */
async function syncBlameContexts(state: BlameDecoratorState): Promise<void> {
  await vscode.commands.executeCommand(
    "setContext",
    DECORATOR_CONTEXT,
    state.enabled
  );
  await vscode.commands.executeCommand(
    "setContext",
    LINE_CONTEXT,
    state.lineVisible
  );
}

/**
 * lineVisible 상태에 맞는 VS Code decoration type 을 만든다.
 * @param lineVisible 라인 앞 blame 텍스트 영역을 표시할지 여부
 */
function createDecorationType(lineVisible: boolean): vscode.TextEditorDecorationType {
  if (!lineVisible) {
    return vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
  }
  return vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    before: {
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      margin: "0 1.2ch 0 0",
      width: "24ch",
      textDecoration:
        "none; display: inline-block; text-align: right; opacity: 0.78; font-style: normal",
    },
  });
}

/**
 * blame 라인 배열을 VS Code DecorationOptions 로 변환한다.
 * @param document    decoration 을 적용할 문서
 * @param blame       git blame 결과
 * @param lineVisible 라인 앞 요약 텍스트 표시 여부
 */
function blameToDecorations(
  document: vscode.TextDocument,
  blame: GitBlameLine[]
): vscode.DecorationOptions[] {
  return blame
    .filter((line) => line.line >= 1 && line.line <= document.lineCount)
    .map((line) => {
      const zeroBased = line.line - 1;
      const range = document.lineAt(zeroBased).range;
      return {
        range,
        renderOptions: {
          before: { contentText: blameLabel(line) },
        },
      };
    });
}

/**
 * 라인 앞 영역에 표시할 짧은 blame 라벨을 만든다.
 * - 작성자와 날짜를 고정 폭 영역에 맞게 줄여, 코드 컬럼이 크게 흔들리지 않게 한다.
 * @param line blame 라인 정보
 */
function blameLabel(line: GitBlameLine): string {
  if (isUncommitted(line.commit)) {
    return vscode.l10n.t("Not committed yet");
  }
  const author = truncate(line.authorName || "Unknown", 12);
  const date = line.authorTime ? shortDate(line.authorTime) : shortHash(line.commit);
  return `${author} ${date}`;
}

/** 현재 활성 에디터 문서와 같은 문서인지 확인한다. */
function isActiveDocument(document: vscode.TextDocument): boolean {
  return vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString();
}

/** 파일 경로의 디렉터리 부분을 플랫폼 구분자와 무관하게 반환한다. */
function dirname(fsPath: string): string {
  const index = Math.max(fsPath.lastIndexOf("/"), fsPath.lastIndexOf("\\"));
  return index >= 0 ? fsPath.slice(0, index) : fsPath;
}

/** 커밋 해시가 git blame 의 미커밋 라인 표식인지 확인한다. */
function isUncommitted(commit: string): boolean {
  return /^0+$/.test(commit);
}

/** 커밋 해시를 짧게 줄인다. */
function shortHash(commit: string): string {
  return commit ? commit.slice(0, 8) : "";
}

/** 라인 라벨 폭을 넘기지 않도록 문자열을 줄인다. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

/** Unix epoch seconds 를 YYYY-MM-DD 로 표시한다. */
function shortDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}
