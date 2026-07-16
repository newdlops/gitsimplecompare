// 확장 전역 refresh watcher의 경로 판정과 원인 병합을 담당하는 순수 정책 모듈.
// - VS Code API와 실제 refresh 실행을 몰라 테스트/확장이 쉽고, extension 진입점은 조립에 집중한다.

/** 파일 watcher 이벤트를 실제 refresh로 보낼지와 진단 사유를 함께 나타낸다. */
export interface RefreshDecision {
  refresh: boolean;
  reason: string;
}

/** Changes 웹뷰 전체 새로고침에서 독립적으로 조회할 수 있는 데이터 영역. */
export type ChangesRefreshSection =
  | "repositories"
  | "workingChanges"
  | "fileHistory"
  | "stashes"
  | "worktrees"
  | "commitHooks"
  | "comparison";

/** 새로고침 pass 하나에 포함된 요청을 실제 실행 함수로 넘기는 계약. */
export type RefreshPassRunner = (reason: string) => Promise<void>;

/** 진행 중인 pass와 함께 기다릴 개별 새로고침 요청. */
interface RefreshWaiter {
  sequence: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const ALL_CHANGES_SECTIONS: readonly ChangesRefreshSection[] = [
  "repositories",
  "workingChanges",
  "fileHistory",
  "stashes",
  "worktrees",
  "commitHooks",
  "comparison",
];

/**
 * 겹쳐 들어온 새로고침 요청을 pass 단위로 합치고 queue가 안정될 때 호출자를 완료한다.
 * - 실행 중 새 요청이 오면 다음 pass 원인에 합치고, 후속 보정 pass까지 모두 끝난 뒤 Promise를 완료한다.
 * - 커밋 명령처럼 refresh 완료를 기다리는 호출자가 단순히 queue 등록 직후 반환되는 문제를 막는다.
 * - pass 실패는 그 pass에 포함된 요청에만 전달하고, 실행 도중 추가된 요청은 다음 pass에서 계속 처리한다.
 */
export class RefreshDrain {
  private readonly pendingReasons = new Set<string>();
  private readonly waiters: RefreshWaiter[] = [];
  private requestedSequence = 0;
  private draining = false;

  /** @param run 합쳐진 원인 문자열로 실제 새로고침 한 pass를 수행할 함수 */
  constructor(private readonly run: RefreshPassRunner) {}

  /** 현재 pass가 실행 중이거나 다음 pass가 예약되어 있는지 확인한다. */
  isRunning(): boolean {
    return this.draining;
  }

  /**
   * 새 원인을 queue에 넣고 이 요청이 실제 반영될 때까지 기다리는 Promise를 반환한다.
   * @param reason 단일 또는 쉼표로 합쳐진 새로고침 원인
   * @returns 해당 pass 중 추가된 보정 pass까지 처리해 queue가 비면 끝나는 Promise
   */
  request(reason: string): Promise<void> {
    addRefreshReasons(this.pendingReasons, reason || "scheduled");
    const sequence = ++this.requestedSequence;
    const completion = new Promise<void>((resolve, reject) => {
      this.waiters.push({ sequence, resolve, reject });
    });
    if (!this.draining) {
      void this.drain();
    }
    return completion;
  }

  /**
   * 현재까지 들어온 원인을 소비해 pass를 실행하고, 실행 중 추가된 원인은 다음 pass로 넘긴다.
   * - passSequence는 시작 순간의 마지막 요청 번호이므로 뒤늦게 온 요청의 waiter를 먼저 완료하지 않는다.
   */
  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.pendingReasons.size > 0) {
        const reason = [...this.pendingReasons].join(",");
        this.pendingReasons.clear();
        const passSequence = this.requestedSequence;
        try {
          await this.run(reason || "scheduled");
          // 실행 중 새 상태 이벤트가 현재 결과를 무효화했다면 queued 보정 pass까지 기다린다.
          if (this.pendingReasons.size === 0) {
            this.settleWaiters(passSequence);
          }
        } catch (error) {
          this.settleWaiters(passSequence, error);
        }
      }
    } finally {
      this.draining = false;
      // 마지막 await와 finally 사이에 새 요청이 들어온 극단적인 경우도 잃지 않는다.
      if (this.pendingReasons.size > 0) {
        void this.drain();
      }
    }
  }

  /**
   * 완료된 pass에 포함된 waiter만 성공 또는 실패로 정리한다.
   * @param passSequence 방금 실행한 pass 시작 시점의 마지막 요청 번호
   * @param error pass가 실패했다면 호출자에게 전달할 오류
   */
  private settleWaiters(passSequence: number, error?: unknown): void {
    for (let index = this.waiters.length - 1; index >= 0; index--) {
      const waiter = this.waiters[index];
      if (waiter.sequence > passSequence) {
        continue;
      }
      this.waiters.splice(index, 1);
      if (error === undefined) {
        waiter.resolve();
      } else {
        waiter.reject(error);
      }
    }
  }
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
 * 전역 Git 이벤트가 활성 브랜치의 PR 코멘트 캐시/표시에 영향을 줄 수 있는지 판정한다.
 * - 일반 파일 저장과 index 상태 변경은 PR 번호/코멘트를 바꾸지 않으므로 원격 loader 예약을 생략한다.
 * @param reason 쉼표로 합쳐질 수 있는 전역 refresh 원인
 * @returns ref/저장소 identity가 바뀔 수 있어 PR 코멘트를 다시 적용해야 하면 true
 */
export function shouldRefreshPullRequestComments(reason: string): boolean {
  return splitRefreshReasons(reason).some(
    (item) =>
      item.includes("stable-git-state") ||
      item === "workspaceFolders" ||
      item === "vscodeGit:repositoryOpened" ||
      item === "vscodeGit:repositoryClosed" ||
      item === "vscodeGit:enablement" ||
      item === "vscodeGit:identity" ||
      item.startsWith("identity:")
  );
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
 * 합쳐진 원인에 필요한 Changes 데이터 영역의 합집합을 계산한다.
 * - 작업 파일 이벤트는 작업 상태만, hook 파일 이벤트는 hook 상태만 읽어 고비용 History/비교 조회를 피한다.
 * - 커밋과 ref 이동은 HEAD에 의존하는 History/비교만 추가하고 stash/worktree/hook 재조사는 생략한다.
 * - 알 수 없는 사용자 명령은 안전하게 전체 영역을 갱신해 새 기능이 누락된 상태로 남지 않게 한다.
 * @param reason 단일 또는 쉼표로 합쳐진 새로고침 원인
 * @returns 고정된 UI 실행 순서로 정렬한 데이터 영역 목록
 */
export function changesRefreshSections(
  reason: string
): ChangesRefreshSection[] {
  const selected = new Set<ChangesRefreshSection>();
  const parts = splitRefreshReasons(reason);
  for (const part of parts.length ? parts : ["command"]) {
    for (const section of sectionsForRefreshReason(part)) {
      selected.add(section);
    }
  }
  return ALL_CHANGES_SECTIONS.filter((section) => selected.has(section));
}

/**
 * refresh 전에 GitService 작업 상태 캐시를 무효화해야 하는지 판정한다.
 * - 이 확장이 index를 직접 바꾸는 명령은 watcher 도착을 기다리지 않고 다음 CLI 조회가 새 상태를 읽게 한다.
 * @param reason 단일 또는 합쳐진 새로고침 원인
 * @returns 상태 캐시를 먼저 무효화해야 하면 true
 */
export function shouldInvalidateChangesStatus(reason: string): boolean {
  return splitRefreshReasons(reason).some(
    (item) =>
      item === "command" ||
      item === "commit" ||
      item === "commitResult" ||
      item === "commitAttempt" ||
      item === "checkoutBranch" ||
      item.startsWith("checkout:") ||
      item.startsWith("branchOperation") ||
      item.includes("conflict") ||
      item.includes("ignore-rules") ||
      item.startsWith("hunkCheckbox:") ||
      item.startsWith("editorHunks:")
  );
}

/**
 * VS Code Git 상태 스냅샷 대신 실제 Git CLI 상태를 우선 읽어야 하는 원인인지 판정한다.
 * - 커밋/ref 이동 직후에는 내장 Git 확장의 indexChanges가 이전 HEAD 기준으로 남을 수 있어 CLI가 SoT다.
 * - 수동 새로고침과 자체 mutation 직후에는 stale provider 대신 실제 상태를 확인한다.
 * @param reason 단일 또는 합쳐진 새로고침 원인
 * @returns Git CLI의 porcelain 상태를 강제 조회해야 하면 true
 */
export function shouldForceChangesGitStatus(reason: string): boolean {
  return splitRefreshReasons(reason).some(
    (item) =>
      item === "command" ||
      item === "commit" ||
      item === "commitResult" ||
      item === "commitAttempt" ||
      item === "vscodeGit:identity" ||
      item === "checkoutBranch" ||
      item.startsWith("checkout:") ||
      item.startsWith("branchOperation") ||
      item.includes("ignore-rules") ||
      item.includes("conflict") ||
      item.startsWith("hunkCheckbox:") ||
      item.startsWith("editorHunks:") ||
      item.includes("stable-git-state")
  );
}

/**
 * Changes 뷰 전체에 진행 표시를 띄울 명시적 refresh인지 판정한다.
 * - 자동 Git/포커스/저장 이벤트는 데이터를 조용히 맞춰 잦은 loading 깜빡임을 만들지 않는다.
 * @param reason 단일 또는 합쳐진 새로고침 원인
 * @returns 사용자가 요청한 수동 전체 refresh가 포함되면 true
 */
export function shouldShowChangesRefreshProgress(reason: string): boolean {
  return splitRefreshReasons(reason).some(
    (item) => item === "command"
  );
}

/**
 * 한 원인에 필요한 최소 Changes 데이터 영역을 반환한다.
 * @param reason 쉼표가 제거된 단일 원인
 * @returns 해당 원인을 화면에 반영하는 데 필요한 영역
 */
function sectionsForRefreshReason(
  reason: string
): readonly ChangesRefreshSection[] {
  if (reason.includes("commit-hooks")) {
    return ["commitHooks"];
  }
  if (reason === "viewReady") {
    // stash는 메타데이터만 읽고 상세 파일/worktree/hook 검사는 제외해 첫 pass를 짧게 유지한다.
    return [
      "repositories",
      "workingChanges",
      "fileHistory",
      "stashes",
      "comparison",
    ];
  }
  if (reason === "viewReadyDeferred") {
    // file history/stash metadata/기존 비교만 늦게 채우고 worktree·hook 상세 검사는 사용자 요청까지 미룬다.
    return ["fileHistory", "stashes", "comparison"];
  }
  if (reason === "viewVisible") {
    // retainContextWhenHidden 재노출은 저장소 identity/working state만 맞추고 부가 Git 명령은 반복하지 않는다.
    return ["repositories", "workingChanges"];
  }
  if (isWorkingTreeRefreshReason(reason)) {
    return ["workingChanges"];
  }
  if (reason === "commitAttempt") {
    return ["workingChanges"];
  }
  if (
    reason === "commit" ||
    reason === "commitResult" ||
    reason.startsWith("commit:")
  ) {
    return ["workingChanges", "fileHistory", "comparison"];
  }
  if (
    reason.includes("stable-git-state") ||
    reason === "vscodeGit:identity" ||
    reason === "checkoutBranch" ||
    reason.startsWith("checkout:") ||
    reason.startsWith("branchOperation")
  ) {
    return [
      "repositories",
      "workingChanges",
      "fileHistory",
      "comparison",
    ];
  }
  if (
    reason === "vscodeGit:repositoryOpened" ||
    reason === "vscodeGit:repositoryClosed" ||
    reason === "vscodeGit:enablement"
  ) {
    return ["repositories", "workingChanges"];
  }
  // 과거 버전이 만든 synthetic focus 원인이 들어와도 전체 History/stash 재조사를 하지 않는다.
  if (reason === "windowFocused") {
    return ["workingChanges"];
  }
  return ALL_CHANGES_SECTIONS;
}

/**
 * 파일 저장/index 조작처럼 작업 상태 목록 외의 섹션에는 영향을 주지 않는 원인을 판정한다.
 * @param reason 쉼표가 제거된 단일 원인
 * @returns workingChanges만 조회하면 충분하면 true
 */
function isWorkingTreeRefreshReason(reason: string): boolean {
  return (
    reason.includes("working-tree-file") ||
    reason === "documentSaved" ||
    reason === "filesCreated" ||
    reason === "filesDeleted" ||
    reason === "filesRenamed" ||
    reason === "vscodeGit:state" ||
    reason.includes("ignore-rules") ||
    reason.includes("conflict") ||
    reason.startsWith("hunkCheckbox:") ||
    reason.startsWith("editorHunks:")
  );
}

/**
 * 원인 문자열을 공백과 빈 항목이 제거된 배열로 정규화한다.
 * @param reason 단일 또는 쉼표로 합쳐진 원인
 * @returns 순서를 유지한 유효 원인 배열
 */
function splitRefreshReasons(reason: string): string[] {
  return reason
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
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
