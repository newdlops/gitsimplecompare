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
        line.column,
        line.checked,
        line.lineIds,
      ]),
    }))
  );
}

/**
 * snapshot 데이터는 같아도 VS Code diff DOM 배치가 바뀔 수 있는 이벤트를 판별한다.
 * @param reason overlay render 를 요청한 이벤트 이름
 * @returns 같은 snapshot 서명이라도 renderer 에 다시 주입해야 하면 true
 */
export function shouldRepaintSameSnapshot(reason: string): boolean {
  return [
    "activeEditor",
    "visibleEditors",
    "tabs",
    "tabGroups",
    "diffOpenFinished",
    "documentChanged",
  ].includes(reason);
}
