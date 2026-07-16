// VS Code 문서/파일 이벤트를 Changes 로컬 상태 fast lane에 연결한다.
// - 내장 Git 확장이 비활성 또는 scan 중이어도 저장·생성·삭제·이름 변경을 즉시 목록에 반영한다.
import * as path from "node:path";
import * as vscode from "vscode";
import { logInfo } from "../ui/outputLog";

/** 로컬 파일 이벤트를 어느 Changes 뷰와 refresh 함수에 연결할지 정의한다. */
export interface LocalChangesWatchTarget {
  /** Changes 웹뷰가 현재 보일 때만 Git 조회를 만들기 위한 가시성 함수. */
  isVisible: () => boolean;
  /** 현재 선택한 저장소 밖의 파일 이벤트를 거르기 위한 활성 root 함수. */
  getActiveRepo: () => string | undefined;
  /** 필터를 통과한 이벤트를 local refresh lane으로 보내는 함수. */
  requestRefresh: (reason: string) => void;
}

/**
 * 저장·생성·삭제·이름 변경 이벤트를 활성 저장소 범위에서만 구독한다.
 * - FileSystemWatcher의 광범위 glob 대신 VS Code의 명시적 workspace 이벤트를 사용해 watcher 수를 늘리지 않는다.
 * - 반환 Disposable은 activation context가 관리하며, 콜백은 로컬 상태 이외의 History/stash 조회를 요청하지 않는다.
 * @param target 뷰 가시성, 활성 저장소, refresh callback 묶음
 * @returns extension context에 등록할 VS Code 이벤트 Disposable 목록
 */
export function registerLocalChangesWatcher(
  target: LocalChangesWatchTarget
): vscode.Disposable[] {
  const request = (reason: string, uris: readonly vscode.Uri[]): void => {
    if (!target.isVisible()) return;
    const root = target.getActiveRepo();
    if (!root || !uris.some((uri) => uriBelongsToRoot(uri, root))) return;
    logInfo("local changes fast refresh requested", {
      reason,
      root,
      resources: uris.length,
    });
    target.requestRefresh(reason);
  };
  return [
    vscode.workspace.onDidSaveTextDocument((document) =>
      request("documentSaved", [document.uri])
    ),
    vscode.workspace.onDidCreateFiles((event) =>
      request("filesCreated", event.files)
    ),
    vscode.workspace.onDidDeleteFiles((event) =>
      request("filesDeleted", event.files)
    ),
    vscode.workspace.onDidRenameFiles((event) =>
      request(
        "filesRenamed",
        event.files.flatMap((item) => [item.oldUri, item.newUri])
      )
    ),
  ];
}

/**
 * 파일 URI가 활성 저장소 root 자체이거나 그 하위에 있는지 플랫폼 경로 규칙으로 판정한다.
 * @param uri 저장·파일 작업 이벤트가 전달한 resource URI
 * @param root 현재 Changes 뷰가 선택한 저장소 절대 경로
 * @returns file URI가 root 범위 안이면 true
 */
function uriBelongsToRoot(uri: vscode.Uri, root: string): boolean {
  if (uri.scheme !== "file") return false;
  const relative = path.relative(path.resolve(root), path.resolve(uri.fsPath));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
