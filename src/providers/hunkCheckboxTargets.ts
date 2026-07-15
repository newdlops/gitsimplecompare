// hunk checkbox 가 동작할 diff target/파일 target 해석 유틸.
// - controller 본체는 checkbox 상태 관리에 집중하고, VS Code tab/URI 해석은 여기서 처리한다.
import * as path from "node:path";
import * as vscode from "vscode";
import type { DiffStage } from "../git/diffHunkService";
import type { GitServiceRegistry } from "../git/serviceRegistry";
import {
  activeHunkDiffTarget,
  hunkDiffTargetFromTab,
  type ActiveHunkDiffTarget,
} from "./hunkDiffContext";

export interface HunkFileTarget {
  repoRoot: string;
  relPath: string;
  stage?: DiffStage;
  virtualUnstaged?: boolean;
}

/**
 * 실제 file URI 에서 저장소 루트와 상대 경로를 찾는다.
 * @param registry git service registry
 * @param uri 실제 작업트리 파일 URI
 */
export async function resolveFileTarget(
  registry: GitServiceRegistry,
  uri: vscode.Uri
): Promise<HunkFileTarget | undefined> {
  if (uri.scheme !== "file") {
    return undefined;
  }
  const gitService = await registry.resolve(path.dirname(uri.fsPath));
  if (!gitService) {
    return undefined;
  }
  const relPath = relativeRepoPath(gitService.repoRoot, uri.fsPath);
  return relPath ? { repoRoot: gitService.repoRoot, relPath } : undefined;
}

/** 화면에 보이는 editor group 의 active hunk diff 대상들을 모은다. */
export function visibleHunkTargets(): ActiveHunkDiffTarget[] {
  const seen = new Set<string>();
  const out: ActiveHunkDiffTarget[] = [];
  for (const group of vscode.window.tabGroups.all) {
    const target = hunkDiffTargetFromTab(group.activeTab);
    if (!target) {
      continue;
    }
    const key = target.modified.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ ...target, viewColumn: group.viewColumn });
  }
  return out.sort(
    (a, b) =>
      (a.viewColumn ?? Number.MAX_SAFE_INTEGER) -
        (b.viewColumn ?? Number.MAX_SAFE_INTEGER) ||
      a.relPath.localeCompare(b.relPath)
  );
}

/**
 * 저장된 문서가 현재 보이는 editable diff 중 modified 문서인지 확인한다.
 * @param uri 저장 이벤트가 전달한 문서 URI
 * @returns 이 문서의 hunk Git 좌표 캐시를 무효화해야 하면 true
 */
export function isVisibleHunkModifiedUri(uri: vscode.Uri): boolean {
  const key = uri.toString();
  return visibleHunkTargets().some((target) => target.modified.toString() === key);
}

/** active diff target 을 파일 조회용 target 으로 변환한다. */
export function targetToFileTarget(
  target: ActiveHunkDiffTarget
): HunkFileTarget {
  return {
    repoRoot: target.repoRoot,
    relPath: target.relPath,
    stage: target.stage,
    virtualUnstaged: target.virtualUnstaged,
  };
}

/** 현재 active diff 가 주어진 modified URI 에 대응하면 파일 target 으로 변환한다. */
export function activeTargetForModifiedUri(
  uri: vscode.Uri
): HunkFileTarget | undefined {
  const activeTarget = activeHunkDiffTarget();
  return activeTarget && activeTarget.modified.toString() === uri.toString()
    ? targetToFileTarget(activeTarget)
    : undefined;
}

/**
 * 저장소 상대 경로를 만든다.
 * @param repoRoot 저장소 루트
 * @param fsPath 파일 절대 경로
 */
function relativeRepoPath(repoRoot: string, fsPath: string): string | undefined {
  const rel = path.relative(repoRoot, fsPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel.split(path.sep).join("/");
}
