// git CLI를 감싸는 서비스 모듈.
// - 이 확장에서 git에 접근하는 "유일한" 지점이다. UI/프로바이더/명령 레이어는
//   반드시 GitService 를 통해서만 git을 다룬다(경계 분리·재사용성).
// - vscode API에 의존하지 않으므로 단위 테스트나 다른 환경에서도 그대로 쓸 수 있다.
import * as path from "node:path";
import { rm } from "node:fs/promises";
import { BranchInfo, DiffBase, FileChange, StashEntry } from "./gitTypes";
import { GitBranchListCache } from "./gitBranchListCache";
import { runGit } from "./gitExec";
import { runGitStatus } from "./gitStatusExec";
import {
  readFileAtRef,
  readWorkingContentWithoutStaged,
  type ContentReadOptions,
} from "./fileContentReader";
import { bulkCheckinConfigArgs } from "./largeChangeSet";
import { runGitWithPaths } from "./pathspecExec";
import { StashService, type StashSelection } from "./stashService";
import { attachStatusStats } from "./statusStats";
import {
  appendIgnoreEntries,
  gitPathArgs,
  parseUnmergedPaths,
  type IgnoreTarget,
  type UntrackResult,
} from "./ignoreRules";
import {
  parseRawNumstatZ,
  parsePorcelainGroups,
} from "./diffParse";
import {
  cloneStatusGroups,
  StatusCache,
  type StatusGroupOptions,
  type StatusGroups,
} from "./statusCache";
export type { StatusGroupOptions, StatusGroups } from "./statusCache";
export type { IgnoreTarget, UntrackResult } from "./ignoreRules";
// GitError 는 gitExec 로 옮겼지만, 기존 import 경로 호환을 위해 다시 내보낸다.
export { GitError } from "./gitExec";

export type { ContentReadOptions } from "./fileContentReader";
/** `stageAll` 호출부가 전달할 수 있는 대상 규모 힌트. */
export interface StageAllOptions {
  /** stage 될 것으로 예상되는 파일 수. 대량이면 bulk-checkin 으로 blob 을 pack 하나에 기록한다. */
  expectedFileCount?: number;
}
/**
 * 특정 저장소 루트에 묶인 git 작업 단위.
 * - 인스턴스는 repoRoot 하나에 대응한다. 여러 저장소를 다룰 땐 루트별로 생성한다.
 */
export class GitService {
  private readonly statusCache = new StatusCache<StatusGroups>(cloneStatusGroups);
  private readonly branchListCache: GitBranchListCache;
  // 이 서비스로 마지막 git 상태 변경(commit/stage/unstage/discard 등)을 한 시각.
  // 직후 짧은 동안은 VS Code 내장 Git 캐시가 뒤처지므로, 새로고침이 CLI 로 강제 조회하도록 신호로 쓴다.
  private lastMutationAt = 0;

  constructor(public readonly repoRoot: string) {
    this.branchListCache = GitBranchListCache.forRepository(repoRoot);
  }
  /**
   * 현재 체크아웃된 브랜치 이름을 반환한다.
   * - 분리된 HEAD 상태면 "HEAD" 가 반환될 수 있다.
   */
  async getCurrentBranch(): Promise<string> {
    const out = await this.run(["rev-parse", "--abbrev-ref", "HEAD"]);
    return out.trim();
  }

  /** 현재 worktree HEAD의 full commit OID를 반환해 PR head와 exact identity를 비교한다. */
  async getHeadOid(): Promise<string> {
    return (await this.run(["rev-parse", "HEAD"])).trim();
  }

  /**
   * 로컬/원격 브랜치 목록을 반환한다.
   * - for-each-ref 로 한 번에 읽어 파싱한다. 현재 브랜치는 isCurrent=true.
   * @param includeRemote 원격 브랜치 포함 여부
   * @returns 브랜치 정보 배열(로컬 먼저, 그다음 원격)
   */
  async listBranches(includeRemote: boolean): Promise<BranchInfo[]> {
    return (await this.branchListCache.read(includeRemote, (args) => this.run(args))).branches;
  }

  /** checkout/commit/branch 생성처럼 ref가 바뀐 뒤 Quick Pick snapshot 세대를 즉시 올린다. */
  invalidateBranchCache(): void {
    this.branchListCache.invalidate();
  }

  /**
   * 두 ref 사이에 변경된 파일 목록을 반환한다.
   * - diffBase 에 따라 두 점(base..target) 또는 세 점(base...target) 비교를 쓴다.
   * - --raw --numstat을 한 번 실행해 상태·이름변경·증감 라인 수를 함께 읽는다.
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
    return parseRawNumstatZ(
      await this.run(["diff", "--raw", "--numstat", "-z", "-M", range])
    );
  }

  /**
   * 작업트리 변경을 스테이징/미스테이징 두 그룹으로 나눠 반환한다(Source Control 의
   * "Staged Changes" / "Changes" 와 동일 성격).
   * - `git status --porcelain -z --untracked-files=all` 로 모든 변경/미추적을 잡는다.
   *   `--untracked-files=all` 이 없으면 새로 생긴 디렉터리가 "newdir/" 한 줄로 접혀
   *   1뎁스 이상 깊은 새 파일이 트리에 안 잡힌다.
   * - 스테이징은 `git diff --cached --numstat -z`, 미스테이징은 `git diff --numstat -z` 로
   *   각각 추가/삭제 라인 수를 병합한다. `git diff`에 나오지 않는 미추적 파일은 파일을
   *   직접 읽어 추가 라인 수를 계산하고 삭제 라인은 0으로 표시한다.
   * - 한 bucket 이 수천 파일을 넘으면(largeChangeSet 정책) 그 bucket 의 라인 통계는 생략한다.
   * - includeStats=false 면 porcelain 목록만 한 번 읽어 UI가 SoT 상태를 먼저 반영하게 한다.
   * @param options 강제 조회, 캐시 유효 시간, 라인 통계 포함 여부
   * @returns authoritative porcelain 상태를 기준으로 분류한 작업트리 변경 그룹
   */
  async getStatusGroups(options: StatusGroupOptions = {}): Promise<StatusGroups> {
    const maxAge = options.maxCacheAgeMs ?? 1000;
    const includeStats = options.includeStats ?? true;
    const detailLevel = includeStats ? 1 : 0;
    if (!options.force) {
      const cached = this.statusCache.get(maxAge, detailLevel);
      if (cached) {
        return cached;
      }
    }
    return this.statusCache.read(
      () => this.readStatusGroups(includeStats),
      detailLevel
    );
  }

  /**
   * 작업트리 상태 캐시를 무효화한다.
   * - 실제 index/작업트리 변경만 mutation 시각을 기록하고, watcher의 수동적 무효화는
   *   false를 받아 후속 refresh가 불필요하게 Git CLI를 강제 실행하지 않게 한다.
   * @param markMutation 이 서비스가 실제 Git 상태를 변경한 직후인지 여부
   */
  invalidateStatusCache(markMutation = true): void {
    this.statusCache.invalidate();
    if (markMutation) this.lastMutationAt = Date.now();
  }

  /**
   * 현재 작업트리 status 캐시의 무효화 세대를 반환한다.
   * - provider 기반 비동기 조회는 시작 시 이 값을 저장하고, UI 반영 직전에 현재 여부를 검사해
   *   commit/stage 뒤에 늦게 도착한 과거 결과가 화면을 되돌리지 않게 한다.
   * @returns 마지막 수동/자동 invalidate 횟수를 반영한 generation 토큰
   */
  getStatusGeneration(): number {
    return this.statusCache.getGeneration();
  }

  /**
   * 비동기 status 조회가 시작된 세대가 아직 유효한지 확인한다.
   * @param generation 조회 시작 때 getStatusGeneration 으로 저장한 토큰
   * @returns 조회 도중 status 캐시가 invalidate 되지 않았다면 true
   */
  isStatusGenerationCurrent(generation: number): boolean {
    return this.statusCache.isGenerationCurrent(generation);
  }

  /**
   * 최근 withinMs 밀리초 안에 이 서비스로 git 상태를 바꿨는지 확인한다.
   * - true 면 VS Code 내장 Git 캐시가 아직 뒤처졌을 수 있으니, 호출부는 CLI 로 강제 조회해야 한다.
   * @param withinMs 최근으로 간주할 시간 창(ms)
   */
  mutatedRecently(withinMs: number): boolean {
    return this.lastMutationAt > 0 && Date.now() - this.lastMutationAt < withinMs;
  }

  /**
   * 외부 상태 provider 가 준 파일 목록에 git numstat 기반 +/- 정보를 보강한다.
   * - VS Code Git API 는 빠른 파일 상태를 주지만 추가/삭제 라인 수는 주지 않는다.
   * - `git status` 재스캔 없이 +/-를 붙이되 provider 결과는 authoritative 캐시에 저장하지 않는다.
   * @param groups staged/unstaged 로 이미 분류된 파일 목록
   */
  async addStatusStats(groups: StatusGroups): Promise<StatusGroups> {
    const value = await attachStatusStats(
      this.repoRoot,
      cloneStatusGroups(groups),
      (args) => this.run(args)
    );
    return cloneStatusGroups(value);
  }

  /**
   * authoritative git status 를 읽고 요청된 경우 diff 통계까지 병합한다.
   * - 통계는 status 로 파일 수를 안 뒤에 붙인다. 그래야 수만 파일 bucket 의 numstat/미추적 파일 읽기를
   *   largeChangeSet 정책에 따라 건너뛸 수 있다.
   * @param includeStats true면 staged/unstaged numstat과 미추적 파일 라인 수도 계산한다
   * @returns porcelain 기준 상태 그룹과 선택적으로 보강된 라인 통계
   */
  private async readStatusGroups(includeStats: boolean): Promise<StatusGroups> {
    const groups = parsePorcelainGroups(
      await runGitStatus(
        ["status", "--porcelain", "-z", "--untracked-files=all"],
        this.repoRoot
      )
    );
    return includeStats
      ? attachStatusStats(this.repoRoot, groups, (args) => this.run(args))
      : groups;
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

  /**
   * 선택 경로를 .gitignore 또는 .git/info/exclude 에 추가한다.
   * - 저장소 루트 기준 패턴(`/path` 또는 `/dir/`)으로 기록해 같은 이름의 다른 파일과
   *   섞이지 않게 한다.
   * - 이미 같은 패턴이 있으면 중복으로 쓰지 않는다.
   * @param target 규칙을 쓸 대상 파일
   * @param paths  저장소 상대/절대 경로 목록
   * @returns 실제로 새로 추가된 ignore 패턴 목록
   */
  async addIgnoreEntries(
    target: IgnoreTarget,
    paths: string[]
  ): Promise<string[]> {
    const added = await appendIgnoreEntries(
      this.repoRoot,
      target,
      paths.map((p) => this.toRepoRelative(p)),
      async (gitPath) =>
        (await this.run(["rev-parse", "--git-path", gitPath])).trim()
    );
    if (added.length) {
      this.invalidateStatusCache();
    }
    return added;
  }

  /**
   * 주어진 경로 중 Git 이 이미 추적 중인 파일 목록을 반환한다.
   * - 폴더 경로가 들어오면 `git ls-files` 가 하위 추적 파일로 펼쳐준다.
   * @param paths 저장소 상대/절대 경로 목록
   */
  async trackedPaths(paths: string[]): Promise<string[]> {
    const targets = gitPathArgs(paths.map((p) => this.toRepoRelative(p)));
    if (!targets.length) {
      return [];
    }
    const out = await this.run(["ls-files", "-z", "--", ...targets]).catch(
      () => ""
    );
    return gitPathArgs(out.split("\0"));
  }

  /**
   * 이미 추적 중인 파일을 인덱스에서 제거해 다음 커밋부터 제외되게 한다.
   * - 작업트리 파일은 보존한다(`git rm --cached`).
   * - 충돌 중인 파일은 자동 제거하지 않고 skipped 로 반환한다.
   * @param paths 저장소 상대/절대 경로 목록
   */
  async untrackPaths(paths: string[]): Promise<UntrackResult> {
    const tracked = await this.trackedPaths(paths);
    if (!tracked.length) {
      return { removed: [], skipped: [] };
    }
    const conflicted = await this.unmergedPaths(tracked);
    const removed = tracked.filter((p) => !conflicted.has(p));
    const skipped = tracked.filter((p) => conflicted.has(p));
    if (removed.length) {
      await this.run(["rm", "--cached", "-r", "-f", "--", ...removed]);
      this.invalidateStatusCache();
    }
    return { removed, skipped };
  }

  // ---- 스테이징/커밋(쓰기 작업) ----

  /**
   * 지정 경로들을 스테이징한다(`git add`).
   * - 대괄호나 pathspec magic이 있는 이름도 선택한 파일 그대로 처리한다.
   * - 경로가 수천 개면 stdin pathspec 으로 넘겨 명령줄 한도를 피하고, bulk-checkin 으로
   *   blob 을 pack 하나에 기록해 loose object 수만 개를 만드는 비용을 줄인다.
   * @param paths 저장소 상대 경로 목록
   */
  async stage(paths: string[]): Promise<void> {
    if (paths.length) {
      await runGitWithPaths(
        [...bulkCheckinConfigArgs(paths.length), "--literal-pathspecs", "add"],
        paths,
        this.repoRoot
      );
      this.invalidateStatusCache();
    }
  }

  /**
   * 모든 변경(추적·미추적·삭제)을 스테이징한다(`git add -A`).
   * - 호출부가 아는 대상 파일 수가 크면 bulk-checkin 으로 실행해 대량 변경의 stage 시간을 줄인다.
   * @param options expectedFileCount: 현재 화면의 미스테이징 파일 수 같은 대상 규모 힌트(모르면 생략)
   */
  async stageAll(options: StageAllOptions = {}): Promise<void> {
    await this.run([
      ...bulkCheckinConfigArgs(options.expectedFileCount),
      "add",
      "-A",
    ]);
    this.invalidateStatusCache();
  }

  /**
   * 지정 경로들의 스테이징을 해제한다(`git reset HEAD --`).
   * - 경로가 많으면 stdin pathspec 으로 넘겨 명령줄 한도를 피한다.
   * @param paths 저장소 상대 경로 목록
   */
  async unstage(paths: string[]): Promise<void> {
    if (paths.length) {
      await runGitWithPaths(
        ["--literal-pathspecs", "reset", "-q", "HEAD"],
        paths,
        this.repoRoot
      );
      this.invalidateStatusCache();
    }
  }

  /** 모든 스테이징을 해제한다(`git reset`). */
  async unstageAll(): Promise<void> {
    await this.run(["reset", "-q"]);
    this.invalidateStatusCache();
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
    await runGitWithPaths(
      ["--literal-pathspecs", "checkout"],
      tracked,
      this.repoRoot
    );
    for (const rel of toDelete) {
      await rm(path.resolve(this.repoRoot, rel), { force: true });
    }
    this.invalidateStatusCache();
  }

  /**
   * 커밋한다(`git commit --quiet -m`).
   * - 스테이징 여부 판단·스마트 커밋은 호출부(명령 레이어)가 담당한다.
   * - 여러 줄 메시지는 빈 줄 기준 문단으로 나눠 `-m` 을 반복해 subject/body 를 보존한다.
   * - `--quiet` 는 성공 뒤 출력하는 "N files changed" 요약만 생략한다. 이 요약은 모든 변경 blob 의
   *   diffstat 과 rename 탐지를 다시 계산하므로 수만 파일 커밋에서 수 초가 걸리지만 아무도 읽지 않는다.
   *   hook 출력과 "nothing to commit" 같은 실패 출력은 그대로 남아 실패 진단에 쓰인다.
   * @param message 커밋 메시지
   * @param opts amend(마지막 커밋 수정) 여부
   */
  async commit(message: string, opts?: { amend?: boolean }): Promise<void> {
    const args = ["commit", "--quiet"];
    if (opts?.amend) {
      args.push("--amend");
    }
    if (message) {
      args.push(...commitMessageArgs(message));
    } else {
      // 메시지 없이 amend 면 기존 메시지를 유지한다(--no-edit).
      args.push("--no-edit");
    }
    await this.run(args);
    this.invalidateStatusCache();
    this.invalidateBranchCache();
  }

  // ---- stash ----

  /**
   * 지정 경로(없으면 전체)를 stash 한다(`git stash push`).
   * - 선택 파일은 `--all` 로 ignored 파일까지 포함하고 pathspec 파일로 전달해 긴 경로 목록을 안전하게 처리한다.
   * - 전체 stash 는 `-u` 로 미추적 파일만 포함해 저장소 전체 ignored 산출물을 쓸어 담지 않는다.
   * @param paths   stash 할 저장소 상대 경로(빈 배열이면 전체 변경)
   * @param message stash 메시지(선택)
   */
  async stashPush(paths: string[], message?: string): Promise<void> {
    try { await new StashService(this.repoRoot).push(paths, message); }
    finally { this.invalidateStatusCache(); }
  }

  /**
   * stash 목록을 반환한다(`refs/stash` reflog).
   * - 일부 환경에서 `git stash list` 가 log 설정(max-count 등)의 영향을 받아 최신 1건만
   *   돌려주는 경우가 있어, reflog 를 직접 읽고 충분한 max-count 를 명시한다.
   * - 필드 구분 \x1f, 레코드 구분 \x1e 로 포매팅해 메시지에 개행이 있어도 안전하게 파싱한다.
   * - %gd(stash@{n}) · %gs(reflog 제목) · %cr(상대시각) · %H(해시).
   */
  async listStashes(): Promise<StashEntry[]> {
    return new StashService(this.repoRoot).list();
  }

  /** 확인창 전에 선택을 전체 hash로 고정한다. 없거나 모호한 선택이면 중단한다. */
  async resolveStash(selection: StashSelection): Promise<StashEntry> {
    return new StashService(this.repoRoot).resolve(selection);
  }

  /**
   * 특정 stash 가 담은 변경 파일 목록을 반환한다.
   * - `git stash show --include-untracked --name-status -z <ref>` 를 파싱한다.
   * @param ref stash 참조(stash@{n})
   */
  async stashShowFiles(ref: string): Promise<FileChange[]> {
    return new StashService(this.repoRoot).files(ref);
  }

  /** stash 를 작업트리에 적용한다(`git stash apply`). */
  async stashApply(selection: StashSelection): Promise<void> {
    try { await new StashService(this.repoRoot).apply(selection); }
    finally { this.invalidateStatusCache(); }
  }

  /** stash 를 적용하고 목록에서 제거한다(`git stash pop`). */
  async stashPop(selection: StashSelection): Promise<void> {
    try { await new StashService(this.repoRoot).apply(selection, true); }
    finally { this.invalidateStatusCache(); }
  }

  /** stash 를 버린다(`git stash drop`). */
  async stashDrop(selection: StashSelection): Promise<void> {
    await new StashService(this.repoRoot).drop(selection);
  }

  /** stash 를 새 브랜치로 펼친다(`git stash branch <name> <ref>`). */
  async stashBranch(name: string, selection: StashSelection): Promise<void> {
    try { await new StashService(this.repoRoot).branch(name, selection); }
    finally { this.invalidateStatusCache(); this.invalidateBranchCache(); }
  }

  /**
   * 특정 ref 시점의 파일 내용을 문자열로 반환한다(fileContentReader 에 위임).
   * - ref 가 `:0` 이면 index 의 stage 0 버전을 읽고, 해당 ref 에 파일이 없으면 빈 문자열을 반환한다.
   * - maxBytes 를 주면 그보다 큰 내용은 읽다가 멈추고 FileTooLargeError 를 던진다(diff 미리보기 보호).
   * @param ref    git 참조(브랜치/커밋)
   * @param fsPath 파일 경로(절대 또는 저장소 상대)
   * @param options maxBytes: 미리보기로 읽을 최대 byte 수(생략하면 git 출력 버퍼 기본 상한)
   */
  getFileContentAtRef(
    ref: string,
    fsPath: string,
    options: ContentReadOptions = {}
  ): Promise<string> {
    return readFileAtRef(this.repoRoot, ref, this.toRepoRelative(fsPath), options);
  }

  /**
   * 작업트리에서 staged 변경만 제거한 가상 파일 내용을 만든다(fileContentReader 에 위임).
   * - 부분 stage 뒤 남은 unstaged 변경만 HEAD 와 비교할 때 사용한다.
   * - maxBytes 를 주면 대용량 파일은 읽지 않고 FileTooLargeError 를 던진다.
   * @param fsPath 파일 경로(절대 또는 저장소 상대)
   * @param options maxBytes: 버전 하나당 읽을 최대 byte 수
   * @returns staged 변경을 뺀 작업트리 내용. 작업트리 파일이 없으면 빈 문자열
   */
  getWorkingContentWithoutStaged(
    fsPath: string,
    options: ContentReadOptions = {}
  ): Promise<string> {
    return readWorkingContentWithoutStaged(this.repoRoot, this.toRepoRelative(fsPath), options);
  }

  /**
   * 특정 파일에 staged 변경이 있는지 확인한다.
   * @param fsPath 파일 경로(절대 또는 저장소 상대)
   * @returns index 에 해당 파일 변경이 있으면 true
   */
  async hasStagedChangeForPath(fsPath: string): Promise<boolean> {
    const rel = this.toRepoRelative(fsPath);
    const out = await this.run(["diff", "--cached", "--name-only", "--", rel]);
    return out.trim().length > 0;
  }

  /**
   * 주어진 경로 중 merge/rebase 충돌로 unmerged index entry 를 가진 파일을 찾는다.
   * @param paths 저장소 상대 경로 목록
   */
  private async unmergedPaths(paths: string[]): Promise<Set<string>> {
    const targets = gitPathArgs(paths);
    if (!targets.length) {
      return new Set();
    }
    const out = await this.run(["ls-files", "-u", "-z", "--", ...targets]).catch(
      () => ""
    );
    return parseUnmergedPaths(out);
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

/**
 * git commit 인자에 넣을 메시지 문단을 만든다.
 * @param message 사용자가 입력한 전체 커밋 메시지
 * @returns git commit 에 전달할 `-m <paragraph>` 인자 배열
 */
function commitMessageArgs(message: string): string[] {
  const paragraphs = message.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return (paragraphs.length ? paragraphs : [message]).flatMap((part) => ["-m", part]);
}
