// PR preview Quick Edit가 저장한 한 파일만 Git index와 안전하게 동기화한다.
// - UI 계층은 Git 상태/명령을 직접 알지 않고, 이 서비스가 기존 unstaged 변경과 branch 전환을 방어한다.
import * as path from "node:path";
import { runGit } from "./gitExec";

/** Quick Edit를 시작한 branch와 검증된 저장소 상대 경로를 묶은 불변 세션이다. */
export interface PullRequestQuickEditSession {
  relativePath: string;
  sourceBranch: string;
}

/** 사용자가 복구 가능한 Quick Edit 준비/저장 실패 종류다. */
export type PullRequestQuickEditErrorCode =
  | "unsafePath"
  | "existingUnstagedChanges"
  | "sourceBranchChanged";

/** UI가 실패 원인별 복구 안내를 선택할 수 있게 code를 보존하는 오류다. */
export class PullRequestQuickEditError extends Error {
  constructor(
    public readonly code: PullRequestQuickEditErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PullRequestQuickEditError";
  }
}

/** 한 저장소의 Quick Edit 시작 조건 확인과 파일 단위 staging을 담당한다. */
export class PullRequestQuickEditService {
  constructor(private readonly repoRoot: string) {}

  /**
   * Quick Edit를 열기 전에 branch와 작업 파일 상태를 고정한다.
   * - 이미 unstaged/untracked 변경이 있는 파일은 `git add`가 기존 변경까지 포함하므로 거부한다.
   * @param filePath PR preview가 제공한 저장소 상대 경로
   * @param sourceBranch preview에서 선택한 source branch
   * @returns 이후 저장 시 재검증할 정규화 경로와 branch
   */
  async prepare(
    filePath: string,
    sourceBranch: string
  ): Promise<PullRequestQuickEditSession> {
    const relativePath = safeRepoRelativePath(this.repoRoot, filePath);
    if (!relativePath) {
      throw new PullRequestQuickEditError(
        "unsafePath",
        "Quick Edit path must stay inside the repository."
      );
    }
    await this.assertSourceBranch(sourceBranch);
    const [unstaged, untracked] = await Promise.all([
      runGit(["diff", "--name-only", "-z", "--", relativePath], this.repoRoot),
      runGit(
        ["ls-files", "--others", "--exclude-standard", "-z", "--", relativePath],
        this.repoRoot
      ),
    ]);
    if (unstaged || untracked) {
      throw new PullRequestQuickEditError(
        "existingUnstagedChanges",
        "Quick Edit cannot stage over existing unstaged changes."
      );
    }
    return { relativePath, sourceBranch };
  }

  /**
   * 저장된 Quick Edit 파일만 index에 올리고 실제 변경 여부를 반환한다.
   * - 세션을 연 뒤 branch가 바뀌면 다른 branch에 잘못 stage하지 않도록 즉시 거부한다.
   * @param session prepare가 반환한 검증 세션
   * @returns 작업 파일과 index가 달라 실제 `git add`를 실행했으면 true
   */
  async stageSavedFile(session: PullRequestQuickEditSession): Promise<boolean> {
    await this.assertSourceBranch(session.sourceBranch);
    const changed = await runGit(
      ["diff", "--name-only", "-z", "--", session.relativePath],
      this.repoRoot
    );
    if (!changed) {
      return false;
    }
    await runGit(["add", "--", session.relativePath], this.repoRoot);
    return true;
  }

  /**
   * 현재 checkout branch가 Quick Edit를 시작한 source와 같은지 확인한다.
   * @param expectedSourceBranch preview가 검증한 source branch
   */
  private async assertSourceBranch(expectedSourceBranch: string): Promise<void> {
    const currentBranch = (
      await runGit(["branch", "--show-current"], this.repoRoot)
    ).trim() || "HEAD";
    if (!expectedSourceBranch || currentBranch !== expectedSourceBranch) {
      throw new PullRequestQuickEditError(
        "sourceBranchChanged",
        `Quick Edit source branch changed from '${expectedSourceBranch}' to '${currentBranch}'.`
      );
    }
  }
}

/**
 * Git pathspec으로 넘길 값을 저장소 내부의 POSIX 상대 경로로 정규화한다.
 * @param repoRoot 대상 저장소 루트
 * @param value preview 파일 경로
 * @returns 안전한 상대 경로, 저장소 밖이면 undefined
 */
function safeRepoRelativePath(
  repoRoot: string,
  value: string
): string | undefined {
  const candidate = String(value || "");
  if (!candidate || path.isAbsolute(candidate)) {
    return undefined;
  }
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, candidate);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    return undefined;
  }
  return path.relative(root, resolved).split(path.sep).join("/");
}
