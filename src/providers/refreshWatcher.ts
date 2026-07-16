// 공용 FileSystemWatcher의 create/change/delete 이벤트 배선을 담당한다.
// - extension activation은 watcher 종류와 정책만 선언하고 반복적인 VS Code 구독 코드는 이 모듈에 위임한다.
import * as vscode from "vscode";

/** 파일 시스템 watcher가 전달하는 이벤트 종류와 resource URI를 받는 handler. */
export type RefreshWatcherHandler = (
  event: "create" | "change" | "delete",
  uri: vscode.Uri
) => void;

/**
 * watcher의 세 이벤트를 같은 handler에 연결하고 activation disposable 목록에 등록한다.
 * @param watcher 이미 생성한 VS Code FileSystemWatcher
 * @param handler create/change/delete와 URI를 함께 받을 refresh 정책 함수
 * @param subscriptions 이벤트 Disposable을 수명 주기에 묶을 activation 목록
 */
export function connectRefreshWatcher(
  watcher: vscode.FileSystemWatcher,
  handler: RefreshWatcherHandler,
  subscriptions: vscode.Disposable[]
): void {
  watcher.onDidCreate(
    (uri) => handler("create", uri),
    undefined,
    subscriptions
  );
  watcher.onDidChange(
    (uri) => handler("change", uri),
    undefined,
    subscriptions
  );
  watcher.onDidDelete(
    (uri) => handler("delete", uri),
    undefined,
    subscriptions
  );
}
