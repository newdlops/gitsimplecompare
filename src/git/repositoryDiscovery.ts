// 임의 경로에서 Git 저장소 root와 branch identity를 탐지한다.
// - 서비스 인스턴스 생성 전 실행되는 저수준 조회를 GitService의 파일 내용/상태 책임과 분리한다.
import { GitError, runGit } from "./gitExec";

/** 저장소 탐색 한 프로세스에서 함께 얻은 root와 현재 브랜치 identity. */
export interface DetectedRepositoryIdentity {
  root: string;
  branch: string;
}

/**
 * 주어진 경로가 속한 Git 저장소의 root만 조회한다.
 * @param cwd 탐색을 시작할 파일의 디렉터리 또는 workspace folder
 * @returns 저장소 root 절대 경로, 저장소가 아니면 undefined
 */
export async function detectRepoRoot(cwd: string): Promise<string | undefined> {
  try {
    const out = await runGit(["rev-parse", "--show-toplevel"], cwd);
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 주어진 경로의 저장소 root와 현재 브랜치를 한 번의 rev-parse 프로세스로 조회한다.
 * - Changes 최초 탐색이 root 확인 뒤 branch 확인을 직렬 실행하지 않게 하는 빠른 경로다.
 * @param cwd 탐색을 시작할 파일의 디렉터리 또는 workspace folder
 * @returns 저장소가 아니면 undefined, 맞으면 root/branch identity
 */
export async function detectRepositoryIdentity(
  cwd: string
): Promise<DetectedRepositoryIdentity | undefined> {
  try {
    const out = await runGit(
      ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"],
      cwd
    );
    return parseIdentityOutput(out, false);
  } catch (error) {
    // unborn HEAD는 종료 코드는 실패지만 성공한 --show-toplevel/--abbrev-ref 출력(root, HEAD)은 stdout에 남긴다.
    // 그 출력을 재사용해 root와 branch를 다시 묻는 두 프로세스를 만들지 않고, 일반 비저장소 실패는 즉시 끝낸다.
    return error instanceof GitError ? parseIdentityOutput(error.stdout, true) : undefined;
  }
}

/**
 * 브랜치에는 개행이 없으므로 마지막 행만 분리해 개행을 포함한 실제 root도 그대로 보존한다.
 * @param output root와 branch를 순서대로 출력한 rev-parse stdout
 * @param unborn HEAD 부재 오류에서 받은 부분 출력인지 여부
 * @returns 실제 root와 브랜치 identity. 부분 출력의 HEAD는 아직 커밋이 없는 상태로 구분한다.
 */
function parseIdentityOutput(output: string, unborn: boolean): DetectedRepositoryIdentity | undefined {
  const text = output.replace(/\r?\n$/, "");
  const separator = text.lastIndexOf("\n");
  const root = separator < 0 ? text : text.slice(0, separator).replace(/\r$/, "");
  const branch = separator < 0 ? "" : text.slice(separator + 1).trim();
  return root ? { root, branch: unborn ? (branch && branch !== "HEAD" ? branch : "") : branch || "HEAD" } : undefined;
}
