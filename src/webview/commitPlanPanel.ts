// AI가 제안한 커밋 분할 계획을 검토/편집/실행하는 웹뷰 패널.
// - 패널 생애주기와 메시지 라우팅, 사용자 최종 승인만 담당한다.
// - Git 컨텍스트 수집, AI 호출, 실제 커밋 실행은 주입된 actions 콜백으로 위임한다.
import * as vscode from "vscode";
import type {
  CommitPlanContext,
  CommitPlanResult,
} from "../ai/commitPlanModel";
import { buildCommitPlanHtml } from "./commitPlanHtml";
import { presentCommitPlanExecutionProgress } from "./commitPlanExecutionPresentation";
import {
  commitPlanContextPaths,
  commitPlanErrorText,
  type CommitPlanExecutionFailure,
  type CommitPlanFromWebview,
  type CommitPlanLaunchOptions,
  type CommitPlanOperation,
  type CommitPlanPanelActions,
  type CommitPlanToWebview,
  normalizeCommitPlanLaunchOptions,
  normalizeCommitPlanResult,
  parseCommitPlanFromWebview,
  validateCommitPlanForExecution,
} from "./commitPlanProtocol";

/** 패널 진행 상태를 중복 요청 차단에 사용하는 내부 작업 타입. */
type ActiveOperation = "refresh" | "generate" | "execute";

/**
 * AI 커밋 플랜 패널. 저장소가 바뀌어도 하나의 패널을 재사용해 탭이 계속 늘지 않게 한다.
 */
export class CommitPlanPanel {
  private static current: CommitPlanPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private generationCancellation?: vscode.CancellationTokenSource;
  private result?: CommitPlanResult;
  private activeOperation?: ActiveOperation;
  private prompt = "";
  private intent?: string;
  private pendingAutoGenerate = false;
  private webviewReady = false;
  private disposed = false;
  private sessionRevision = 0;

  /**
   * 새 AI 커밋 플랜 패널을 열거나 기존 패널을 앞으로 가져와 세션을 교체한다.
   * @param extensionUri 확장 루트 URI. 정적 미디어 리소스 URI 계산에 사용한다.
   * @param context 계획 생성 대상 Git 변경 컨텍스트
   * @param actions AI 생성/새로고침/실행을 실제 계층에 위임할 콜백 묶음
   * @param options 자동 생성, 추가 프롬프트, 호출 의도를 담은 선택 옵션
   * @returns 생성 또는 재사용된 패널 인스턴스
   */
  static createOrShow(
    extensionUri: vscode.Uri,
    context: CommitPlanContext,
    actions: CommitPlanPanelActions,
    options?: CommitPlanLaunchOptions
  ): CommitPlanPanel {
    const normalized = normalizeCommitPlanLaunchOptions(options);
    if (CommitPlanPanel.current) {
      if (CommitPlanPanel.current.activeOperation === "execute") {
        CommitPlanPanel.current.panel.reveal(vscode.ViewColumn.Active);
        return CommitPlanPanel.current;
      }
      CommitPlanPanel.current.replaceSession(context, actions, normalized);
      CommitPlanPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return CommitPlanPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      "gitSimpleCompare.commitPlan",
      vscode.l10n.t("AI Commit Plan"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    CommitPlanPanel.current = new CommitPlanPanel(
      panel,
      extensionUri,
      context,
      actions,
      normalized.prompt,
      normalized.intent,
      normalized.autoGenerate
    );
    return CommitPlanPanel.current;
  }

  /**
   * 패널의 HTML/메시지 수신/폐기 리스너를 설치한다.
   * @param panel VS Code 웹뷰 패널
   * @param extensionUri 확장 루트 URI
   * @param context 최초 Git 변경 컨텍스트
   * @param actions 최초 액션 콜백 묶음
   * @param prompt 최초 추가 프롬프트
   * @param intent 최초 생성 범위 또는 의도
   * @param autoGenerate 웹뷰 준비 직후 자동 생성할지 여부
   */
  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private context: CommitPlanContext,
    private actions: CommitPlanPanelActions,
    prompt: string,
    intent: string | undefined,
    autoGenerate: boolean
  ) {
    this.prompt = prompt;
    this.intent = intent;
    this.pendingAutoGenerate = autoGenerate;
    this.panel.webview.html = buildCommitPlanHtml(extensionUri, panel.webview);
    this.panel.webview.onDidReceiveMessage(
      (value: unknown) => void this.receiveMessage(value),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /**
   * 기존 패널을 다른 컨텍스트/액션으로 재사용하고 편집 중이던 이전 계획을 폐기한다.
   * @param context 새 계획 대상 컨텍스트
   * @param actions 새 저장소에 결합된 액션 콜백
   * @param options 정규화된 시작 옵션
   */
  private replaceSession(
    context: CommitPlanContext,
    actions: CommitPlanPanelActions,
    options: ReturnType<typeof normalizeCommitPlanLaunchOptions>
  ): void {
    this.sessionRevision++;
    this.cancelGeneration();
    this.context = context;
    this.actions = actions;
    this.prompt = options.prompt;
    this.intent = options.intent;
    this.pendingAutoGenerate = options.autoGenerate;
    this.result = undefined;
    this.activeOperation = undefined;
    if (!this.webviewReady) {
      return;
    }
    this.sendContext();
    this.startPendingAutoGeneration();
  }

  /**
   * raw postMessage 값을 안전한 protocol 메시지로 바꾼 뒤 해당 작업으로 라우팅한다.
   * @param value 웹뷰에서 수신한 신뢰하지 않는 값
   */
  private async receiveMessage(value: unknown): Promise<void> {
    const message = parseCommitPlanFromWebview(value);
    if (!message) {
      return;
    }
    try {
      await this.handleMessage(message);
    } catch (error) {
      const operation = operationForMessage(message);
      await this.fail(operation, error);
      if (
        operation === "refresh" ||
        operation === "generate" ||
        operation === "execute"
      ) {
        this.finishOperation(operation);
      }
    }
  }

  /**
   * 타입이 보장된 웹뷰 요청을 준비/생성/새로고침/실행/보조 액션으로 분배한다.
   * @param message 정규화가 끝난 웹뷰 요청
   */
  private async handleMessage(message: CommitPlanFromWebview): Promise<void> {
    switch (message.type) {
      case "ready":
        this.webviewReady = true;
        this.sendContext();
        this.startPendingAutoGeneration();
        return;
      case "generate":
        this.prompt = message.prompt;
        this.intent = message.intent ?? this.intent;
        await this.generate();
        return;
      case "refreshContext":
        this.prompt = message.prompt;
        await this.refreshContext();
        return;
      case "execute":
        await this.execute(message.result);
        return;
      case "openFile":
        await this.openFile(message.path);
        return;
      case "configure":
        await this.configure();
        return;
    }
  }

  /** 웹뷰 준비가 끝났을 때 한 번만 예약된 자동 생성을 시작한다. */
  private startPendingAutoGeneration(): void {
    if (!this.pendingAutoGenerate || !this.webviewReady) {
      return;
    }
    this.pendingAutoGenerate = false;
    void this.generate();
  }

  /**
   * 현재 Git 컨텍스트를 AI 액션에 전달하고 결과를 정규화해 웹뷰에 표시한다.
   */
  private async generate(): Promise<void> {
    if (!this.beginOperation("generate", vscode.l10n.t("Generating AI commit plan..."))) {
      return;
    }
    this.cancelGeneration();
    const cancellation = new vscode.CancellationTokenSource();
    this.generationCancellation = cancellation;
    const revision = this.sessionRevision;
    try {
      // 패널에서 파일을 열어 편집했을 수 있으므로 매 생성마다 최신 diff/snapshot을 다시 읽는다.
      const refreshed = await this.actions.refreshContext(this.intent);
      if (
        cancellation.token.isCancellationRequested ||
        this.disposed ||
        revision !== this.sessionRevision
      ) {
        return;
      }
      const generated = await this.actions.generate(
        refreshed,
        this.prompt,
        this.intent,
        cancellation.token
      );
      if (
        cancellation.token.isCancellationRequested ||
        this.disposed ||
        revision !== this.sessionRevision
      ) {
        return;
      }
      // AI 결과까지 성공한 시점에 context/result를 함께 교체해 이전 플랜과 snapshot이 섞이지 않게 한다.
      this.context = refreshed;
      this.result = normalizeCommitPlanResult(generated);
      this.post({ type: "plan", result: this.result, context: this.context });
    } catch (error) {
      if (!cancellation.token.isCancellationRequested) {
        await this.fail("generate", error);
      }
    } finally {
      const currentRequest = this.generationCancellation === cancellation;
      if (currentRequest) {
        this.generationCancellation = undefined;
      }
      cancellation.dispose();
      if (currentRequest) {
        this.finishOperation("generate");
      }
    }
  }

  /**
   * actions를 통해 작업트리 컨텍스트를 다시 읽고 기존 계획을 무효화한다.
   */
  private async refreshContext(): Promise<void> {
    if (!this.beginOperation("refresh", vscode.l10n.t("Refreshing commit plan context..."))) {
      return;
    }
    const revision = this.sessionRevision;
    try {
      const context = await this.actions.refreshContext(this.intent);
      if (revision !== this.sessionRevision || this.disposed) {
        return;
      }
      this.context = context;
      this.result = undefined;
      this.sendContext();
    } catch (error) {
      if (revision === this.sessionRevision && !this.disposed) {
        await this.fail("refresh", error);
      }
    } finally {
      if (revision === this.sessionRevision) {
        this.finishOperation("refresh");
      }
    }
  }

  /**
   * 편집된 계획을 검증하고 VS Code host modal 승인을 받은 뒤 실행 콜백에 위임한다.
   * @param candidate 웹뷰에서 편집해 보낸 계획
   */
  private async execute(candidate: CommitPlanResult): Promise<void> {
    if (this.activeOperation) {
      return;
    }
    const result = normalizeCommitPlanResult(candidate);
    const validation = validateCommitPlanForExecution(result, this.context);
    if (!validation.valid) {
      this.post({
        type: "error",
        operation: "execute",
        message: validation.pathTransition
          ? vscode.l10n.t(
              "File/directory transition paths must stay in one commit. Move {0} and {1} into the same group.",
              validation.pathTransition.ancestorPath,
              validation.pathTransition.descendantPath
            )
          : vscode.l10n.t(
              "The commit plan is incomplete or no longer matches the current changes. Review every commit message and file assignment."
            ),
      });
      return;
    }

    if (
      !this.beginOperation(
        "execute",
        vscode.l10n.t("Waiting for commit plan confirmation...")
      )
    ) {
      return;
    }
    const approved = await this.confirmExecution(result, validation.plannedPaths);
    if (!approved) {
      this.finishOperation("execute");
      return;
    }
    this.post({
      type: "progress",
      operation: "execute",
      message: vscode.l10n.t("Executing AI commit plan..."),
    });
    this.post({ type: "executionStarted", total: result.groups.length });
    try {
      const completion = await this.actions.execute(
        this.context,
        result,
        (progress) =>
          this.post({
            type: "executionProgress",
            progress: presentCommitPlanExecutionProgress(progress),
          })
      );
      this.result = result;
      if (completion?.context) {
        this.context = completion.context;
      }
      this.post({
        type: "completed",
        message:
          completion?.message ?? vscode.l10n.t("AI commit plan completed."),
      });
    } catch (error) {
      await this.fail("execute", error);
    } finally {
      this.finishOperation("execute", false);
    }
  }

  /**
   * 실행될 커밋/파일 개수를 host modal로 명확히 보여주고 최종 승인을 받는다.
   * @param result 실행 직전의 정규화된 계획
   * @param fileCount 계획에 배정된 고유 파일 수
   */
  private async confirmExecution(
    result: CommitPlanResult,
    fileCount: number
  ): Promise<boolean> {
    const approve = vscode.l10n.t("Create Planned Commits");
    const warningText = result.warnings.length
      ? vscode.l10n.t(
          "Review the AI warnings before continuing: {0}",
          result.warnings.join("; ")
        )
      : "";
    const detail = [
      vscode.l10n.t(
        "Git will create {0} commit(s) containing {1} changed file(s) in the displayed order.",
        result.groups.length,
        fileCount
      ),
      this.context.scope === "staged"
        ? vscode.l10n.t(
            "Only the staged changes captured by this plan will be committed. Unstaged changes will remain in the working tree."
          )
        : vscode.l10n.t(
            "All staged, unstaged, and untracked changes captured by this plan will be committed."
          ),
      vscode.l10n.t(
        "Commit hooks run for each prepared commit before the branch is updated. External hook side effects cannot be rolled back if the plan later stops."
      ),
      warningText,
    ]
      .filter(Boolean)
      .join("\n\n");
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Execute this AI commit plan?"),
      { modal: true, detail },
      approve
    );
    return choice === approve;
  }

  /**
   * 계획 파일이 현재 컨텍스트에 속하는지 확인한 뒤 주입된 파일 열기 액션을 실행한다.
   * @param path 저장소 상대 파일 경로
   */
  private async openFile(path: string): Promise<void> {
    const paths = commitPlanContextPaths(this.context);
    if (paths.length > 0 && !paths.includes(path)) {
      await this.fail("openFile", new Error(`Unknown commit plan path: ${path}`));
      return;
    }
    try {
      await this.actions.openFile(path, this.context);
    } catch (error) {
      await this.fail("openFile", error);
    }
  }

  /** AI CLI 설정 액션을 호출하고 설정 UI 실패를 패널 오류로 보고한다. */
  private async configure(): Promise<void> {
    try {
      await this.actions.configure();
    } catch (error) {
      await this.fail("configure", error);
    }
  }

  /**
   * 중복 장시간 작업을 막고 웹뷰에 즉시 진행 상태를 보낸다.
   * @param operation 시작할 host 작업
   * @param message 진행 배너에 표시할 문구
   */
  private beginOperation(operation: ActiveOperation, message: string): boolean {
    if (this.activeOperation || this.disposed) {
      return false;
    }
    this.activeOperation = operation;
    this.post({ type: "progress", operation, message });
    return true;
  }

  /**
   * 현재 작업과 일치할 때 busy 상태를 해제한다.
   * @param operation 종료할 작업
   * @param postIdle completed처럼 별도 최종 상태가 없을 때 idle 메시지를 보낼지 여부
   */
  private finishOperation(operation: ActiveOperation, postIdle = true): void {
    if (this.activeOperation !== operation) {
      return;
    }
    this.activeOperation = undefined;
    if (postIdle && !this.disposed) {
      this.post({ type: "idle" });
    }
  }

  /**
   * 오류를 공용 관찰성 콜백에 보고한 뒤 웹뷰에 사용자용 오류 상태를 전달한다.
   * @param operation 실패한 작업 종류
   * @param error 원본 오류
   */
  private async fail(
    operation: CommitPlanOperation,
    error: unknown
  ): Promise<void> {
    let failure: CommitPlanExecutionFailure | undefined;
    if (operation === "execute") {
      try {
        failure = await this.actions.formatExecutionFailure(error);
      } catch {
        // 진단 파싱 실패 시에도 원래 실행 오류와 안전한 한 줄 메시지는 반드시 표시한다.
      }
    }
    try {
      await this.actions.reportError(error, operation);
    } catch {
      // 오류 보고 콜백 자체의 실패가 원래 오류 표시를 막아서는 안 된다.
    }
    this.post({
      type: "error",
      operation,
      message:
        this.actions.formatError(error) || commitPlanErrorText(error),
      failure,
    });
  }

  /** 현재 컨텍스트와 입력 기본값을 웹뷰에 보내 전체 편집 상태를 초기화한다. */
  private sendContext(): void {
    this.post({
      type: "context",
      context: this.context,
      prompt: this.prompt,
      intent: this.intent,
      autoGenerate: this.pendingAutoGenerate,
    });
  }

  /** 타입이 보장된 host 메시지를 현재 웹뷰에 비동기로 전송한다. */
  private post(message: CommitPlanToWebview): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  /** 진행 중 AI 요청을 취소하고 CancellationTokenSource를 정리한다. */
  private cancelGeneration(): void {
    this.generationCancellation?.cancel();
    this.generationCancellation?.dispose();
    this.generationCancellation = undefined;
  }

  /** 패널 리스너와 취소 토큰을 한 번만 정리한다. */
  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelGeneration();
    if (CommitPlanPanel.current === this) {
      CommitPlanPanel.current = undefined;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

}

/** 웹뷰 메시지 종류를 오류 관찰성에 사용할 작업 이름으로 변환한다. */
function operationForMessage(message: CommitPlanFromWebview): CommitPlanOperation {
  switch (message.type) {
    case "refreshContext":
      return "refresh";
    case "generate":
      return "generate";
    case "execute":
      return "execute";
    case "openFile":
      return "openFile";
    case "configure":
    case "ready":
      return "configure";
  }
}
