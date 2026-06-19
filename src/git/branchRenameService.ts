// 로컬 브랜치 이름 변경을 담당하는 git 서비스.
// - 그래프 UI 는 입력과 확인만 처리하고, 실제 git ref 변경은 이 모듈에서 실행한다.
import { runGit } from "./gitExec";

/** 로컬 브랜치 rename 서비스 */
export class BranchRenameService {
  constructor(private readonly repoRoot: string) {}

  /**
   * 로컬 브랜치 이름을 변경한다.
   * - 현재 checkout 된 브랜치와 checkout 되지 않은 로컬 브랜치 모두 같은 git 명령으로 처리한다.
   * - 원격 브랜치 rename 은 원격 push/delete 정책이 필요하므로 여기서는 지원하지 않는다.
   * @param oldName 기존 로컬 브랜치 이름
   * @param newName 새 로컬 브랜치 이름
   */
  async renameLocalBranch(oldName: string, newName: string): Promise<void> {
    await this.assertValidBranchName(newName);
    await runGit(["branch", "-m", oldName, newName], this.repoRoot);
  }

  /**
   * git 이 허용하는 branch short name 인지 확인한다.
   * @param name 검사할 브랜치 이름
   */
  async assertValidBranchName(name: string): Promise<void> {
    await runGit(["check-ref-format", "--branch", name], this.repoRoot);
  }
}
