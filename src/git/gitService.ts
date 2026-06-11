// git CLI를 감싸는 서비스 모듈.
// - 이 확장에서 git에 접근하는 "유일한" 지점이다. UI/프로바이더/명령 레이어는
//   반드시 GitService 를 통해서만 git을 다룬다(경계 분리·재사용성).
// - vscode API에 의존하지 않으므로 단위 테스트나 다른 환경에서도 그대로 쓸 수 있다.
import * as path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { BranchInfo, DiffBase, FileChange, StashEntry } from "./gitTypes";
import { GitError, runGit } from "./gitExec";
import {
  parseNameStatusZ,
  parseNumstat,
  parsePorcelainGroups,
} from "./diffParse";

/** 작업트리 상태를 스테이징/미스테이징 두 그룹으로 나눈 결과 */
export interface StatusGroups {
  staged: FileChange[];
  unstaged: FileChange[];
}

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
   * 작업트리 변경을 스테이징/미스테이징 두 그룹으로 나눠 반환한다(Source Control 의
   * "Staged Changes" / "Changes" 와 동일 성격).
   * - `git status --porcelain -z --untracked-files=all` 로 모든 변경/미추적을 잡는다.
   *   `--untracked-files=all` 이 없으면 새로 생긴 디렉터리가 "newdir/" 한 줄로 접혀
   *   1뎁스 이상 깊은 새 파일이 트리에 안 잡힌다.
   * - 스테이징은 `git diff --cached --numstat`, 미스테이징은 `git diff --numstat` 로
   *   각각 추가/삭제 라인 수를 병합한다. 미추적은 `git diff` 에 안 잡히므로 라인 수를
   *   직접 세어 추가(+) 통계를 채운다.
   */
  async getStatusGroups(): Promise<StatusGroups> {
    const [statusOut, stagedNum, unstagedNum, untrackedOut] = await Promise.all([
      this.run(["status", "--porcelain", "-z", "--untracked-files=all"]),
      // 커밋 0개(HEAD 없음) 등은 빈 출력으로 처리한다.
      this.run(["diff", "--cached", "--numstat", "-M"]).catch(() => ""),
      this.run(["diff", "--numstat", "-M"]).catch(() => ""),
      // 미추적(무시 제외) 파일 집합 — 미스테이징 numstat 누락분을 라인 수로 보완할 대상.
      this.run(["ls-files", "--others", "--exclude-standard", "-z"]).catch(
        () => ""
      ),
    ]);
    const { staged, unstaged } = parsePorcelainGroups(statusOut);
    const stagedCounts = parseNumstat(stagedNum);
    const unstagedCounts = parseNumstat(unstagedNum);
    const untracked = new Set(
      untrackedOut.split("\0").filter((p) => p.length > 0)
    );

    const withStaged = staged.map((c) => {
      const s = stagedCounts.get(c.path);
      return { ...c, additions: s?.additions, deletions: s?.deletions };
    });
    const withUnstaged = await Promise.all(
      unstaged.map(async (c) => {
        let s = unstagedCounts.get(c.path);
        if (!s && untracked.has(c.path)) {
          s = await this.countUntrackedLines(c.path);
        }
        return { ...c, additions: s?.additions, deletions: s?.deletions };
      })
    );
    return { staged: withStaged, unstaged: withUnstaged };
  }

  /**
   * 미추적 파일 집합(저장소 상대 경로)을 반환한다.
   * - discard 시 추적 파일(되돌리기)과 미추적 파일(삭제)을 구분하는 데 쓴다.
   */
  async listUntracked(): Promise<Set<string>> {
    const out = await this.run([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]).catch(() => "");
    return new Set(out.split("\0").filter((p) => p.length > 0));
  }

  // ---- 스테이징/커밋(쓰기 작업) ----

  /**
   * 지정 경로들을 스테이징한다(`git add`).
   * @param paths 저장소 상대 경로 목록
   */
  async stage(paths: string[]): Promise<void> {
    if (paths.length) {
      await this.run(["add", "--", ...paths]);
    }
  }

  /** 모든 변경(추적·미추적·삭제)을 스테이징한다(`git add -A`). */
  async stageAll(): Promise<void> {
    await this.run(["add", "-A"]);
  }

  /**
   * 지정 경로들의 스테이징을 해제한다(`git reset HEAD --`).
   * @param paths 저장소 상대 경로 목록
   */
  async unstage(paths: string[]): Promise<void> {
    if (paths.length) {
      await this.run(["reset", "-q", "HEAD", "--", ...paths]);
    }
  }

  /** 모든 스테이징을 해제한다(`git reset`). */
  async unstageAll(): Promise<void> {
    await this.run(["reset", "-q"]);
  }

  /**
   * 미스테이징 변경을 버린다.
   * - 추적 파일은 작업트리를 인덱스 내용으로 되돌리고(`git checkout --`),
   *   미추적 파일은 디스크에서 삭제한다.
   * @param paths 버릴 미스테이징 경로 목록
   */
  async discard(paths: string[]): Promise<void> {
    if (!paths.length) {
      return;
    }
    const untracked = await this.listUntracked();
    const tracked = paths.filter((p) => !untracked.has(p));
    const toDelete = paths.filter((p) => untracked.has(p));
    if (tracked.length) {
      await this.run(["checkout", "--", ...tracked]);
    }
    for (const rel of toDelete) {
      await rm(path.resolve(this.repoRoot, rel), { force: true });
    }
  }

  /**
   * 커밋한다(`git commit -m`).
   * - 스테이징 여부 판단·스마트 커밋은 호출부(명령 레이어)가 담당한다.
   * @param message 커밋 메시지
   * @param opts amend(마지막 커밋 수정) 여부
   */
  async commit(message: string, opts?: { amend?: boolean }): Promise<void> {
    const args = ["commit"];
    if (opts?.amend) {
      args.push("--amend");
    }
    if (message) {
      args.push("-m", message);
    } else {
      // 메시지 없이 amend 면 기존 메시지를 유지한다(--no-edit).
      args.push("--no-edit");
    }
    await this.run(args);
  }

  /**
   * 미추적 파일의 추가 라인 수를 직접 센다(추가=파일 전체 라인 수, 삭제=0).
   * - 미추적 파일은 `git diff HEAD` numstat 에 없으므로 이걸로 보완한다.
   * - 널 바이트가 있으면 바이너리로 보고, 빈 파일/읽기 실패와 함께 0 으로 처리한다
   *   (git numstat 의 바이너리 "-" 처리와 동일하게 +0 −0 으로 보이게).
   * @param relPath 저장소 루트 기준 상대 경로
   * @returns { additions, deletions } 라인 통계
   */
  private async countUntrackedLines(
    relPath: string
  ): Promise<{ additions: number; deletions: number }> {
    try {
      const buf = await readFile(path.resolve(this.repoRoot, relPath));
      if (buf.length === 0 || buf.includes(0)) {
        return { additions: 0, deletions: 0 };
      }
      let lines = 0;
      for (const byte of buf) {
        if (byte === 0x0a) {
          lines++;
        }
      }
      // 마지막 줄이 개행으로 끝나지 않으면 한 줄 더 센다(git 의 라인 계수와 동일).
      if (buf[buf.length - 1] !== 0x0a) {
        lines++;
      }
      return { additions: lines, deletions: 0 };
    } catch {
      return { additions: 0, deletions: 0 };
    }
  }

  // ---- stash ----

  /**
   * 지정 경로(없으면 전체)를 stash 한다(`git stash push`).
   * - 선택 파일만 stash: `git stash push -u [-m msg] -- <paths>`.
   * - `-u` 로 지정 경로 중 미추적 파일도 포함한다(추적만 있으면 무해).
   * @param paths   stash 할 저장소 상대 경로(빈 배열이면 전체 변경)
   * @param message stash 메시지(선택)
   */
  async stashPush(paths: string[], message?: string): Promise<void> {
    const args = ["stash", "push", "-u"];
    if (message) {
      args.push("-m", message);
    }
    if (paths.length) {
      args.push("--", ...paths);
    }
    await this.run(args);
  }

  /**
   * stash 목록을 반환한다(`git stash list`).
   * - 필드 구분 \x1f, 레코드 구분 \x1e 로 포매팅해 메시지에 개행이 있어도 안전하게 파싱한다.
   * - %gd(stash@{n}) · %gs(reflog 제목) · %cr(상대시각) · %H(해시).
   */
  async listStashes(): Promise<StashEntry[]> {
    const out = await this.run([
      "stash",
      "list",
      "--format=%gd%x1f%gs%x1f%cr%x1f%H%x1e",
    ]).catch(() => "");
    const entries: StashEntry[] = [];
    for (const rec of out.split("\x1e")) {
      const line = rec.replace(/^\s+/, "");
      if (!line) {
        continue;
      }
      const [gd, gs, cr, hash] = line.split("\x1f");
      if (!gd) {
        continue;
      }
      const idxMatch = /stash@\{(\d+)\}/.exec(gd);
      const index = idxMatch ? Number(idxMatch[1]) : entries.length;
      // gs 예: "WIP on main: 1a2b3c4 subject" 또는 "On main: 내 메시지"
      const subjMatch = /^(?:WIP on|On) ([^:]+):\s?(.*)$/.exec(gs ?? "");
      const branch = subjMatch ? subjMatch[1] : "";
      const message = (subjMatch ? subjMatch[2] : gs) || gs || "";
      entries.push({
        index,
        ref: `stash@{${index}}`,
        message,
        branch,
        relativeDate: cr ?? "",
        hash: hash ?? "",
      });
    }
    return entries;
  }

  /**
   * 특정 stash 가 담은 변경 파일 목록을 반환한다.
   * - `git stash show --include-untracked --name-status -z <ref>` 를 파싱한다.
   * @param ref stash 참조(stash@{n})
   */
  async stashShowFiles(ref: string): Promise<FileChange[]> {
    const out = await this.run([
      "stash",
      "show",
      "--include-untracked",
      "--name-status",
      "-z",
      ref,
    ]).catch(() => "");
    return parseNameStatusZ(out);
  }

  /** stash 를 작업트리에 적용한다(`git stash apply`). */
  async stashApply(ref: string): Promise<void> {
    await this.run(["stash", "apply", ref]);
  }

  /** stash 를 적용하고 목록에서 제거한다(`git stash pop`). */
  async stashPop(ref: string): Promise<void> {
    await this.run(["stash", "pop", ref]);
  }

  /** stash 를 버린다(`git stash drop`). */
  async stashDrop(ref: string): Promise<void> {
    await this.run(["stash", "drop", ref]);
  }

  /** stash 를 새 브랜치로 펼친다(`git stash branch <name> <ref>`). */
  async stashBranch(name: string, ref: string): Promise<void> {
    await this.run(["stash", "branch", name, ref]);
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
