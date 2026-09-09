// Git 메타데이터 watcher의 경로를 순수하게 분류해 refresh 정책과 분리한다.

/** `.git` 내부 절대 경로에서 저장소 루트를 반환하되 linked worktree admin 경로는 제외한다. */
export function repoRootFromGitPath(fsPath: string): string | undefined {
  const normalized = fsPath.replace(/\\/g, "/");
  if (/\/\.git\/worktrees\/[^/]+\//.test(normalized)) return undefined;
  const index = normalized.indexOf("/.git/");
  return index >= 0 ? fsPath.slice(0, index) : undefined;
}

/** ref/작업 상태의 최종 경로만 true로 반환하고 중간 lock/log/index 이벤트는 제외한다. */
export function isStableGitStatePath(path: string): boolean {
  if (/\/\.git\/(?:.*\.lock|.*\/logs\/.*|worktrees\/[^/]+\/index)$/.test(path)) return false;
  return /\/\.git\/(HEAD|packed-refs|refs\/|MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|rebase-(?:merge|apply)(?:\/|$)|worktrees\/)/.test(path);
}

/** 슬래시로 정규화한 경로가 저장소 전용 ignore 파일인지 반환한다. */
export function isGitExcludePath(path: string): boolean {
  return /\/\.git\/info\/exclude$/.test(path);
}
