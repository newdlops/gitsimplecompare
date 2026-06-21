// 일반 git worktree 조회/생성/삭제/이동을 담당하는 서비스 모듈.
// - UI/명령 레이어는 이 모듈을 통해서만 worktree git 명령을 실행한다.
// - porcelain 출력 파싱을 함께 제공해 provider/command 에 git 출력 형식 지식을 흘리지 않는다.
import * as path from "node:path";
import { runGit } from "./gitExec";

/** `git worktree list --porcelain` 한 항목을 UI 에서 쓰기 좋게 정규화한 정보 */
export interface WorktreeInfo {
  /** worktree 루트 절대 경로 */
  path: string;
  /** HEAD 커밋 해시. 아직 커밋이 없는 저장소면 빈 문자열일 수 있다. */
  head: string;
  /** branch ref 를 사람이 읽는 이름으로 줄인 값. detached worktree 면 undefined 다. */
  branch?: string;
  /** porcelain 의 원본 branch ref(`refs/heads/main` 등). */
  branchRef?: string;
  /** detached HEAD worktree 여부 */
  detached: boolean;
  /** bare worktree 여부 */
  bare: boolean;
  /** locked worktree 면 잠금 사유. 사유가 없으면 빈 문자열이다. */
  locked?: string;
  /** prunable worktree 면 prune 사유. 사유가 없으면 빈 문자열이다. */
  prunable?: string;
  /** `git worktree list` 첫 항목인 main worktree 여부 */
  isMain: boolean;
}

/** worktree 생성에 필요한 git 인자 옵션 */
export interface CreateWorktreeOptions {
  /** 새 worktree 가 만들어질 경로 */
  worktreePath: string;
  /** checkout 기준 ref/branch/commit */
  startPoint: string;
  /** 새 로컬 브랜치를 만들 때 사용할 이름. 없으면 startPoint 를 직접 checkout 한다. */
  newBranch?: string;
}

/** worktree 관련 git 명령을 실행하는 서비스 */
export class WorktreeService {
  constructor(public readonly repoRoot: string) {}

  /**
   * 현재 저장소에 등록된 모든 worktree 를 반환한다.
   * - main worktree, linked worktree, detached/bare/locked/prunable 상태를 모두 보존한다.
   * @returns worktree 정보 배열. Git 출력 순서를 유지한다.
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const out = await runGit(["worktree", "list", "--porcelain"], this.repoRoot);
    return parseWorktreePorcelain(out);
  }

  /**
   * 새 worktree 를 생성한다.
   * - newBranch 가 있으면 `git worktree add -b <branch> <path> <startPoint>` 형태로 실행한다.
   * - newBranch 가 없으면 startPoint 를 직접 checkout 하므로 이미 다른 worktree 에서 사용 중인
   *   로컬 브랜치는 Git 이 거부한다.
   * @param options 생성 경로, 시작점, 선택적 새 브랜치 이름
   */
  async createWorktree(options: CreateWorktreeOptions): Promise<void> {
    const args = ["worktree", "add"];
    if (options.newBranch) {
      args.push("-b", options.newBranch);
    }
    args.push(options.worktreePath, options.startPoint);
    await runGit(args, this.repoRoot);
  }

  /**
   * linked worktree 를 제거한다.
   * - 기본은 Git 의 안전 검사를 따른다. 변경 사항이 남아 있으면 실패한다.
   * @param worktreePath 제거할 worktree 루트 경로
   * @param force `--force` 로 제거할지 여부
   */
  async removeWorktree(worktreePath: string, force = false): Promise<void> {
    const args = ["worktree", "remove"];
    if (force) {
      args.push("--force");
    }
    args.push(worktreePath);
    await runGit(args, this.repoRoot);
  }

  /**
   * linked worktree 경로를 이동해 표시 이름(폴더명)을 바꾼다.
   * - Git 은 main worktree 이동을 허용하지 않으므로 호출부에서 main 여부를 먼저 막는다.
   * @param oldPath 현재 worktree 루트 경로
   * @param newPath 새 worktree 루트 경로
   */
  async renameWorktree(oldPath: string, newPath: string): Promise<void> {
    await runGit(["worktree", "move", oldPath, newPath], this.repoRoot);
  }

  /**
   * 새 브랜치 이름이 Git 이 허용하는 short ref name 인지 검사한다.
   * @param name 검사할 브랜치 이름
   */
  async assertValidBranchName(name: string): Promise<void> {
    await runGit(["check-ref-format", "--branch", name], this.repoRoot);
  }
}

/**
 * `git worktree list --porcelain` 출력을 WorktreeInfo 배열로 파싱한다.
 * - 빈 줄 구분뿐 아니라 `worktree ` 라인 기준 분리도 허용해 Git 버전별 출력 차이에 견고하게 처리한다.
 * @param output git porcelain 출력
 * @returns 파싱된 worktree 목록
 */
export function parseWorktreePorcelain(output: string): WorktreeInfo[] {
  return output
    .replace(/\r\n/g, "\n")
    .split(/\n(?=worktree )/)
    .map((entry, index) => parseWorktreeEntry(entry, index))
    .filter((item): item is WorktreeInfo => Boolean(item));
}

/** porcelain 한 블록을 WorktreeInfo 로 바꾼다. */
function parseWorktreeEntry(
  entry: string,
  index: number
): WorktreeInfo | undefined {
  let worktreePath = "";
  let head = "";
  let branchRef: string | undefined;
  let detached = false;
  let bare = false;
  let locked: string | undefined;
  let prunable: string | undefined;

  for (const rawLine of entry.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }
    if (line === "detached") {
      detached = true;
      continue;
    }
    if (line === "bare") {
      bare = true;
      continue;
    }
    const keyEnd = line.indexOf(" ");
    const key = keyEnd >= 0 ? line.slice(0, keyEnd) : line;
    const value = keyEnd >= 0 ? line.slice(keyEnd + 1) : "";
    if (key === "worktree") {
      worktreePath = path.normalize(value);
    } else if (key === "HEAD") {
      head = value;
    } else if (key === "branch") {
      branchRef = value;
    } else if (key === "locked") {
      locked = value;
    } else if (key === "prunable") {
      prunable = value;
    }
  }

  if (!worktreePath) {
    return undefined;
  }
  return {
    path: worktreePath,
    head,
    branch: branchRef ? shortBranchName(branchRef) : undefined,
    branchRef,
    detached,
    bare,
    locked,
    prunable,
    isMain: index === 0,
  };
}

/** refs/heads/* 형태의 branch ref 를 UI 에 표시할 짧은 이름으로 줄인다. */
function shortBranchName(branchRef: string): string {
  return branchRef.startsWith("refs/heads/")
    ? branchRef.slice("refs/heads/".length)
    : branchRef;
}
