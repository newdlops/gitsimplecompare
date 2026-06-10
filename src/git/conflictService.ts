// 머지/리베이스 충돌 해결에 필요한 git 작업을 모은 서비스 모듈.
// - 충돌 파일 조회, ours/theirs 수용, 해결 표시, 진행 중 작업(merge/rebase 등)의
//   상태 확인과 continue/abort 를 제공한다. git 접근은 runGit 만 사용한다(경계 분리).
import * as fs from "node:fs";
import * as path from "node:path";
import { runGit } from "./gitExec";

/** 진행 중인 git 작업 종류(충돌이 발생할 수 있는 작업들) */
export type MergeOperation = "none" | "merge" | "rebase" | "cherry-pick" | "revert";

/**
 * 진행 중인 git 작업 종류를 git 디렉터리의 마커 파일로 판별한다(공유 함수).
 * - ConflictService 와 RebaseService 가 함께 사용한다.
 * @param repoRoot 저장소 루트
 */
export async function detectOperation(
  repoRoot: string
): Promise<MergeOperation> {
  const gitDirRaw = (await runGit(["rev-parse", "--git-dir"], repoRoot)).trim();
  const gitDir = path.resolve(repoRoot, gitDirRaw);
  const has = (name: string): boolean => fs.existsSync(path.join(gitDir, name));

  if (has("rebase-merge") || has("rebase-apply")) {
    return "rebase";
  }
  if (has("MERGE_HEAD")) {
    return "merge";
  }
  if (has("CHERRY_PICK_HEAD")) {
    return "cherry-pick";
  }
  if (has("REVERT_HEAD")) {
    return "revert";
  }
  return "none";
}

/**
 * 한 저장소의 충돌 상태를 다루는 서비스(저장소 루트 1개에 대응).
 */
export class ConflictService {
  constructor(public readonly repoRoot: string) {}

  /**
   * 현재 충돌(unmerged) 상태인 파일들의 저장소 상대 경로 목록을 반환한다.
   * - `--diff-filter=U` 로 unmerged 항목만, `-z` 로 경로를 안전하게 파싱한다.
   */
  async listConflicts(): Promise<string[]> {
    const out = await runGit(
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      this.repoRoot
    );
    return out.split("\0").filter((p) => p.length > 0);
  }

  /**
   * 한 파일을 "우리쪽(--ours)" 버전으로 확정하고 스테이징한다.
   * - merge 에서는 현재 브랜치(HEAD), rebase 에서는 베이스 쪽을 뜻함에 주의.
   * @param rel 저장소 상대 경로
   */
  async takeOurs(rel: string): Promise<void> {
    await runGit(["checkout", "--ours", "--", rel], this.repoRoot);
    await runGit(["add", "--", rel], this.repoRoot);
  }

  /**
   * 한 파일을 "상대쪽(--theirs)" 버전으로 확정하고 스테이징한다.
   * - merge 에서는 병합 대상, rebase 에서는 재적용되는 커밋 쪽을 뜻함에 주의.
   * @param rel 저장소 상대 경로
   */
  async takeTheirs(rel: string): Promise<void> {
    await runGit(["checkout", "--theirs", "--", rel], this.repoRoot);
    await runGit(["add", "--", rel], this.repoRoot);
  }

  /**
   * 수동 편집으로 해결한 파일을 스테이징해 "해결됨"으로 표시한다.
   * @param rel 저장소 상대 경로
   */
  async markResolved(rel: string): Promise<void> {
    await runGit(["add", "--", rel], this.repoRoot);
  }

  /**
   * 진행 중인 git 작업 종류를 판별한다(공유 함수 detectOperation 에 위임).
   */
  getOperation(): Promise<MergeOperation> {
    return detectOperation(this.repoRoot);
  }

  /**
   * 진행 중인 작업을 이어서 진행한다(`git <op> --continue`).
   * - 커밋 메시지 편집기를 띄우지 않도록 GIT_EDITOR=true 로 우회한다.
   * @param op 진행 중인 작업 종류
   */
  async continueOperation(op: MergeOperation): Promise<void> {
    if (op === "none") {
      return;
    }
    await runGit([op, "--continue"], this.repoRoot, { GIT_EDITOR: "true" });
  }

  /**
   * 진행 중인 작업을 취소한다(`git <op> --abort`).
   * @param op 진행 중인 작업 종류
   */
  async abortOperation(op: MergeOperation): Promise<void> {
    if (op === "none") {
      return;
    }
    await runGit([op, "--abort"], this.repoRoot);
  }

  /**
   * 저장소 상대 경로를 절대 경로로 변환한다(파일 URI 생성용).
   * @param rel 저장소 상대 경로
   */
  absPath(rel: string): string {
    return path.join(this.repoRoot, rel);
  }
}
