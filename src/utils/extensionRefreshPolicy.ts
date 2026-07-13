// 확장 전역 refresh watcher의 경로 판정과 원인 병합을 담당하는 순수 정책 모듈.
// - VS Code API와 실제 refresh 실행을 몰라 테스트/확장이 쉽고, extension 진입점은 조립에 집중한다.

/** 파일 watcher 이벤트를 실제 refresh로 보낼지와 진단 사유를 함께 나타낸다. */
export interface RefreshDecision {
  refresh: boolean;
  reason: string;
}

/**
 * `.git` 파일 시스템 이벤트가 refresh로 이어져야 하는지 판정한다.
 * - ref/HEAD/merge 상태와 ignore/hook처럼 화면 데이터에 영향을 주는 경로만 통과시킨다.
 * @param fsPath 변경된 `.git` 내부 파일의 절대 경로
 * @returns refresh 여부와 OUTPUT 진단용 사유
 */
export function shouldRefreshForGitPath(fsPath: string): RefreshDecision {
  const path = fsPath.replace(/\\/g, "/");
  if (/\/\.git\/hooks\//.test(path)) {
    return { refresh: true, reason: "commit-hooks" };
  }
  if (isGitExcludePath(path)) {
    return { refresh: true, reason: "ignore-rules" };
  }
  return isStableGitStatePath(path)
    ? { refresh: true, reason: "stable-git-state" }
    : { refresh: false, reason: "volatile-git-state" };
}

/**
 * 무시한 watcher 이벤트 중 OUTPUT에 남길 가치가 있는 것만 고른다.
 * - `.git`/fsmonitor cookie 같은 정상 고빈도 이벤트는 로그까지 생략한다.
 * @param reason shouldRefreshForGitPath가 반환한 무시 사유
 * @returns 개별 무시 로그를 남겨야 하면 true
 */
export function shouldLogIgnoredRefresh(reason: string): boolean {
  return reason !== "volatile-git-state";
}

/**
 * Explorer 비교 스냅샷 자체를 다시 읽어야 하는 전역 refresh인지 판정한다.
 * - 작업파일과 VS Code Git status는 더 가벼운 전용 경로가 처리하므로 제외한다.
 * @param reason 쉼표로 합쳐질 수 있는 전역 refresh 원인
 * @returns 숨겨진 Changes 뷰 대신 비교 controller를 갱신해야 하면 true
 */
export function shouldRefreshExplorerComparison(reason: string): boolean {
  return reason.split(",").some((part) => {
    const value = part.trim();
    return value.includes("stable-git-state") || value === "workspaceFolders";
  });
}

/**
 * 쉼표로 합쳐진 refresh 원인을 중복 없는 Set에 추가한다.
 * - 이벤트가 몰릴 때 같은 문자열을 계속 연결하지 않고 원인 종류만 보존한다.
 * @param target 원인을 모을 Set
 * @param reason 단일 또는 쉼표로 합쳐진 refresh 원인
 */
export function addRefreshReasons(target: Set<string>, reason: string): void {
  for (const part of reason.split(",")) {
    const normalized = part.trim();
    if (normalized) {
      target.add(normalized);
    }
  }
}

/**
 * `.git` 내부 파일 절대 경로에서 저장소 루트를 꺼낸다.
 * @param fsPath `.git/HEAD` 또는 `.git/refs/**` 아래 절대 경로
 * @returns 저장소 루트, `.git` 내부 경로가 아니면 undefined
 */
export function repoRootFromGitPath(fsPath: string): string | undefined {
  const normalized = fsPath.replace(/\\/g, "/");
  const index = normalized.indexOf("/.git/");
  return index >= 0 ? fsPath.slice(0, index) : undefined;
}

/**
 * `.git` 내부 이벤트 중 ref/작업 상태를 바꾸는 안정적인 경로인지 확인한다.
 * @param path 슬래시(`/`)로 정규화된 절대 경로
 * @returns 비교/그래프/충돌 상태에 영향을 줄 수 있으면 true
 */
function isStableGitStatePath(path: string): boolean {
  // Git은 실제 ref/index를 교체하기 전에 lock과 log를 여러 번 쓴다. 최종 HEAD/ref 파일 이벤트가
  // 별도로 오므로 중간 파일은 버려도 비교 결과는 유지되며 worktree 수에 따른 이벤트 폭주만 줄어든다.
  if (/\/\.git\/(?:.*\.lock|.*\/logs\/.*|worktrees\/[^/]+\/index)$/.test(path)) {
    return false;
  }
  return /\/\.git\/(HEAD|packed-refs|refs\/|MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|rebase-merge\/|rebase-apply\/|worktrees\/)/.test(
    path
  );
}

/**
 * `.git/info/exclude` 변경인지 확인한다.
 * @param path 슬래시(`/`)로 정규화된 절대 경로
 * @returns 저장소 전용 ignore 파일이면 true
 */
function isGitExcludePath(path: string): boolean {
  return /\/\.git\/info\/exclude$/.test(path);
}
