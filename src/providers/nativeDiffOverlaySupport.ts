// native diff overlay controller 의 순수 support 함수.
// - CDP 연결/이벤트 처리는 controller 에 두고, snapshot 직렬화와 workspace 힌트는 분리한다.
import * as path from "node:path";
import * as vscode from "vscode";
import type { HunkOverlaySnapshot } from "./hunkCheckboxController";

/** renderer patch 가 targeting 할 workspace 힌트를 만든다. */
export function workspaceHints(): { paths: string[]; names: string[] } {
  const paths = (vscode.workspace.workspaceFolders ?? []).map(
    (folder) => folder.uri.fsPath
  );
  return {
    paths,
    names: paths.map((item) => path.basename(item)).filter(Boolean),
  };
}

/**
 * 같은 overlay snapshot 을 중복 주입하지 않도록 비교 키를 만든다.
 * @param snapshot renderer 에 전달할 checkbox overlay 상태
 */
export function snapshotSignature(snapshots: HunkOverlaySnapshot[]): string {
  return JSON.stringify(
    snapshots.map((snapshot) => ({
      uri: snapshot.uri,
      originalUri: snapshot.originalUri,
      action: snapshot.action,
      revision: snapshot.revision,
      lines: snapshot.lines.map((line) => [
        line.side,
        line.line,
        line.checked,
        line.lineIds,
      ]),
    }))
  );
}
