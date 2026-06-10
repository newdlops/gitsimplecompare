// 확장 활성화 진입점.
// - 여기서는 각 모듈을 조립(생성·등록)하고 정리(dispose)만 책임진다.
//   실제 기능 로직은 git/providers/ui/commands 모듈에 위임한다(경계 분리).
import * as vscode from "vscode";
import { FileChange } from "./git/gitTypes";
import { GitServiceRegistry } from "./git/serviceRegistry";
import { BranchContentProvider } from "./providers/branchContentProvider";
import { ChangesTreeProvider } from "./providers/changesTreeProvider";
import { COMPARE_SCHEME } from "./utils/uri";
import { registerCommands } from "./commands";
import { CommandDeps } from "./commands/shared";

/**
 * 확장이 활성화될 때 호출된다.
 * - 공유 인스턴스를 만들고, 가상 문서 프로바이더/트리뷰/명령을 등록한 뒤
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

  // 3) 브랜치 비교 결과를 보여줄 트리뷰
  const treeProvider = new ChangesTreeProvider();
  const treeView = vscode.window.createTreeView<FileChange>(
    "gitSimpleCompare.changes",
    { treeDataProvider: treeProvider, showCollapseAll: false }
  );
  context.subscriptions.push(treeView);

  // 4) 명령 등록(핸들러는 commands 모듈에 위임)
  const deps: CommandDeps = { registry, treeProvider, treeView };
  for (const disposable of registerCommands(deps)) {
    context.subscriptions.push(disposable);
  }
}

/**
 * 확장이 비활성화될 때 호출된다.
 * - 모든 리소스는 context.subscriptions 로 정리되므로 별도 처리는 없다.
 */
export function deactivate(): void {
  // 정리할 추가 리소스 없음.
}
