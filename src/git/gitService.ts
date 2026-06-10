// git CLI를 감싸는 서비스 모듈.
// - 이 확장에서 git에 접근하는 "유일한" 지점이다. UI/프로바이더/명령 레이어는
//   반드시 GitService 를 통해서만 git을 다룬다(경계 분리·재사용성).
// - vscode API에 의존하지 않으므로 단위 테스트나 다른 환경에서도 그대로 쓸 수 있다.
import * as path from "node:path";
import { BranchInfo, DiffBase, FileChange } from "./gitTypes";
import { GitError, runGit } from "./gitExec";
import { parseNameStatusZ, parseNumstat } from "./diffParse";

// GitError 는 gitExec 로 옮겼지만, 기존 import 경로 호환을 위해 다시 내보낸다.
export { GitError } from "./gitExec";

/**
 * 특정 저장소 루트에 묶인 git 작업 단위.
 * - 인스턴스는 repoRoot 하나에 대응한다. 여러 저장소를 다룰 땐 루트별로 생성한다.
 */
export class GitService {
  constructor(public readonly repoRoot: string) {}

  /**
   * 주어진 경로가 속한 git 저장소의 루트를 찾는다.
   * - 파일/폴더 어느 쪽이든 그 위치를 기준으로 `git rev-parse --show-toplevel` 실행.
   * @param cwd 탐색 시작 디렉터리(파일이면 그 파일의 디렉터리를 넘긴다)
   * @returns 저장소 루트 절대 경로, 저장소가 아니면 undefined
   */
  static async detectRepoRoot(cwd: string): Promise<string | undefined> {
    try {
      const out = await runGit(["rev-parse", "--show-toplevel"], cwd);
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 현재 체크아웃된 브랜치 이름을 반환한다.
   * - 분리된 HEAD 상태면 "HEAD" 가 반환될 수 있다.
   */
  async getCurrentBranch(): Promise<string> {
    const out = await this.run(["rev-parse", "--abbrev-ref", "HEAD"]);
    return out.trim();
  }

  /**
   * 로컬/원격 브랜치 목록을 반환한다.
   * - for-each-ref 로 한 번에 읽어 파싱한다. 현재 브랜치는 isCurrent=true.
   * @param includeRemote 원격 브랜치 포함 여부
   * @returns 브랜치 정보 배열(로컬 먼저, 그다음 원격)
   */
  async listBranches(includeRemote: boolean): Promise<BranchInfo[]> {
    const current = await this.getCurrentBranch();
    const refs = includeRemote
      ? ["refs/heads", "refs/remotes"]
      : ["refs/heads"];
    const out = await this.run([
      "for-each-ref",
      "--format=%(refname:short)\t%(refname)",
      ...refs,
    ]);

    const branches: BranchInfo[] = [];
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const [short, full] = trimmed.split("\t");
      const isRemote = full.startsWith("refs/remotes/");
      // 원격의 심볼릭 HEAD(origin/HEAD)는 비교 대상으로 의미가 없으니 제외한다.
      if (isRemote && short.endsWith("/HEAD")) {
        continue;
      }
      branches.push({
        name: short,
        kind: isRemote ? "remote" : "local",
        isCurrent: !isRemote && short === current,
      });
    }
    return branches;
  }

  /**
   * 두 ref 사이에 변경된 파일 목록을 반환한다.
   * - diffBase 에 따라 두 점(base..target) 또는 세 점(base...target) 비교를 쓴다.
   * - --name-status 출력을 파싱하며 이름변경/복사(Rxxx/Cxxx)도 처리한다.
   * @param base     기준 ref(왼쪽)
   * @param target   대상 ref(오른쪽)
   * @param diffBase 비교 기준
   */
  async listChanges(
    base: string,
    target: string,
    diffBase: DiffBase
  ): Promise<FileChange[]> {
    const range =
      diffBase === "threeDot" ? `${base}...${target}` : `${base}..${target}`;
    // 상태(추가/수정/이름변경)와 증감 라인 수를 각각 조회해 합친다.
    const [nameStatus, numstat] = await Promise.all([
      this.run(["diff", "--name-status", "-z", range]),
      this.run(["diff", "--numstat", "-M", range]),
    ]);
    const counts = parseNumstat(numstat);
    return parseNameStatusZ(nameStatus).map((change) => {
      const stat = counts.get(change.path);
      return {
        ...change,
        additions: stat?.additions,
        deletions: stat?.deletions,
      };
    });
  }

  /**
   * 특정 ref 시점의 파일 내용을 문자열로 반환한다.
   * - `git show <ref>:<상대경로>` 사용. 해당 ref에 파일이 없으면(추가/삭제된 경우)
   *   빈 문자열을 반환해 diff에서 "빈 쪽"으로 자연스럽게 표시되게 한다.
   * @param ref    git 참조(브랜치/커밋)
   * @param fsPath 파일 경로(절대 또는 저장소 상대)
   */
  async getFileContentAtRef(ref: string, fsPath: string): Promise<string> {
    const rel = this.toRepoRelative(fsPath);
    try {
      return await this.run(["show", `${ref}:${rel}`]);
    } catch (err) {
      // 파일이 그 ref에 존재하지 않는 경우 등은 빈 내용으로 취급한다.
      if (err instanceof GitError) {
        return "";
      }
      throw err;
    }
  }

  /**
   * 절대 경로를 저장소 루트 기준 상대 경로(슬래시 구분)로 변환한다.
   * - git은 항상 POSIX 스타일 경로를 기대하므로 Windows 백슬래시를 슬래시로 바꾼다.
   * @param fsPath 변환할 경로(이미 상대면 그대로 정규화만 수행)
   */
  toRepoRelative(fsPath: string): string {
    const rel = path.isAbsolute(fsPath)
      ? path.relative(this.repoRoot, fsPath)
      : fsPath;
    return rel.split(path.sep).join("/");
  }

  // ---- 내부 구현 ----

  /**
   * 이 인스턴스의 repoRoot 를 cwd 로 git 명령을 실행한다.
   * @param args git 인자 배열
   */
  private run(args: string[]): Promise<string> {
    return runGit(args, this.repoRoot);
  }
}
