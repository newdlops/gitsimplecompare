// 확장 활성화 진입점.
// - 여기서는 각 모듈을 조립(생성·등록)하고 정리(dispose)만 책임진다.
//   실제 기능 로직은 git/providers/ui/commands 모듈에 위임한다(경계 분리).
import * as vscode from "vscode";
import { GitServiceRegistry } from "./git/serviceRegistry";
import { BranchContentProvider } from "./providers/branchContentProvider";
import { ChangesViewProvider } from "./webview/changesViewProvider";
import { registerActiveDiffTracker } from "./providers/activeDiffTracker";
import { ConflictsTreeProvider } from "./providers/conflictsTreeProvider";
import { ConflictsController } from "./providers/conflictsController";
import { COMPARE_SCHEME } from "./utils/uri";
import { registerCommands } from "./commands";
import { CommandDeps, discoverRepositories } from "./commands/shared";
import { syncViewContext } from "./commands/viewState";

/**
 * 확장이 활성화될 때 호출된다.
 * - 공유 인스턴스를 만들고, 가상 문서 프로바이더/트리뷰/명령/추적기를 등록한 뒤
 *   모든 Disposable 을 context.subscriptions 에 모아 자동 정리되게 한다.
 * @param context VS Code 확장 컨텍스트
 */
export function activate(context: vscode.ExtensionContext): void {
  // 1) 저장소별 GitService 를 공유하는 레지스트리
  const registry = new GitServiceRegistry();

  // 2) 특정 ref 의 파일 내용을 읽기 전용 가상 문서로 제공
  const contentProvider = new BranchContentProvider(registry);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      COMPARE_SCHEME,
      contentProvider
    )
  );

  // 3) 브랜치 비교 결과를 보여줄 CHANGES 웹뷰(보기 모드/정렬은 globalState 에 보존)
  const changesView = new ChangesViewProvider(
    context.extensionUri,
    context.globalState
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChangesViewProvider.viewId,
      changesView
    )
  );

  // 4) 충돌 해결 뷰 + 컨트롤러
  const conflictsProvider = new ConflictsTreeProvider();
  context.subscriptions.push(
    vscode.window.createTreeView("gitSimpleCompare.conflicts", {
      treeDataProvider: conflictsProvider,
    })
  );
  const conflicts = new ConflictsController(registry, conflictsProvider);

  // 5) 명령 등록(핸들러는 commands 모듈에 위임)
  const deps: CommandDeps = {
    registry,
    changesView,
    extensionUri: context.extensionUri,
    conflicts,
  };
  for (const disposable of registerCommands(deps)) {
    context.subscriptions.push(disposable);
  }

  // 6) "좌→우 반영" 버튼 노출용 컨텍스트 키 추적기 등록
  context.subscriptions.push(registerActiveDiffTracker());

  // 7) view/title 토글 버튼이 현재 보기 모드를 반영하도록 컨텍스트 키 초기화
  syncViewContext(deps);

  // 8) 충돌/작업변경을 초기화하고, 편집기 전환·파일 저장 시 자동 갱신한다.
  const refreshWorking = (): void => {
    void vscode.commands.executeCommand(
      "gitSimpleCompare.refreshWorkingChanges"
    );
    void vscode.commands.executeCommand("gitSimpleCompare.refreshStashes");
  };
  void conflicts.refresh();
  refreshWorking();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      void conflicts.refresh();
      refreshWorking();
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      void conflicts.refresh();
      refreshWorking();
    })
  );

  // 9) Repositories 섹션 채우기: 활성화 시 + 워크스페이스 폴더 변경 시 재탐지.
  const refreshRepos = async (): Promise<void> => {
    changesView.setRepositories(await discoverRepositories(registry));
    refreshWorking();
  };
  void refreshRepos();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshRepos())
  );

  // 10) 파일 아이콘/색상 테마가 바뀌면 Changes 웹뷰의 파일 아이콘도 다시 그린다.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("workbench.iconTheme")) {
        changesView.refresh();
      }
    }),
    vscode.window.onDidChangeActiveColorTheme(() => changesView.refresh())
  );
}

/**
 * 확장이 비활성화될 때 호출된다.
 * - 모든 리소스는 context.subscriptions 로 정리되므로 별도 처리는 없다.
 */
export function deactivate(): void {
  // 정리할 추가 리소스 없음.
}
