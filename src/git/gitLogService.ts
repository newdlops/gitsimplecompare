// git 로그/커밋 상세를 읽는 서비스 모듈.
// - 그래프 UI 가 필요로 하는 커밋 목록과, 노드 클릭 시 보여줄 상세 정보를 제공한다.
// - git 접근은 공유 실행기(runGit)만 사용한다(경계 분리).
import { runGit } from "./gitExec";
import { detectOperation } from "./conflictService";
import { parseNameStatusZ, parseNumstat } from "./diffParse";
import {
  Commit,
  CommitDetail,
  CommitFileChange,
  GraphRowKind,
  LocalBranchStatus,
} from "../graph/graphTypes";
import { GitBranchRefCache } from "./gitBranchRefCache";
import { loadLocalOnlyBranchMap } from "./gitLocalOnlyBranches";
import { gitLogPrettyFormat, LOG_FIELD_SEPARATOR, parseGitLogOutput } from "./gitLogParse";
import { loadCommitWindowAround } from "./gitLogWindow";
import { parseTrack } from "./gitLogRefs";
import {
  isUnpushedLocalHead,
  localNameFromRemoteRef,
  splitRemoteRef,
} from "./gitRefNames";
import {
  ForcePushMode,
  PushCurrentPlan,
  PushCurrentResult,
  forcePushCurrent,
  pushCurrentWithAutoUpstream,
} from "./pushService";
import { countUntrackedLines } from "./untrackedStats";

/** 빈 트리 오브젝트 해시(루트 커밋의 부모 대용으로 diff 비교에 사용) */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** 작업트리 전체 상태를 나타내는 그래프 전용 가상 커밋 해시 */
export const ONGOING_COMMIT_HASH = "__gsc_virtual_ongoing__";
/** index 상태를 나타내는 그래프 전용 가상 커밋 해시 */
export const STAGED_COMMIT_HASH = "__gsc_virtual_staged__";

/** 커밋 revert 실행 결과 */
export type RevertCommitResult =
  | {
      status: "reverted";
      branch: string;
      targetHash: string;
      beforeHead: string;
      afterHead: string;
    }
  | {
      status: "conflicts";
      branch: string;
      targetHash: string;
      beforeHead: string;
    };

/** 로그 필드 구분자(제어문자 Unit Separator) */
const FS = LOG_FIELD_SEPARATOR;

/**
 * 특정 저장소의 로그/상세를 다루는 서비스(저장소 루트 1개에 대응).
 */
export class GitLogService {
  private readonly branchRefCache: GitBranchRefCache;
  private localOnlyBranchMapPromise: Promise<Map<string, string[]>> | undefined;

  constructor(public readonly repoRoot: string) {
    this.branchRefCache = new GitBranchRefCache(repoRoot, FS);
  }

  /**
   * 커밋 목록을 자식→부모 순(topo-order)으로 반환한다.
   * - refs 가 비면 모든 참조(--all)를 대상으로 한다.
   * - %D(decoration)로 브랜치/태그/HEAD 참조 이름을 함께 읽는다.
   * @param limit 가져올 최대 커밋 수(성능 보호)
   * @param refs  대상 참조 목록(비면 --all)
   */
  async getCommits(limit: number, refs: string[] = []): Promise<Commit[]> {
    return this.getCommitPage(limit, 0, refs);
  }

  /**
   * 커밋 목록을 페이지 단위로 반환한다.
   * - 큰 저장소에서 그래프를 한 번에 모두 읽지 않고, 웹뷰 스크롤에 맞춰 필요한 구간만
   *   이어 붙일 수 있도록 skip/limit 을 git log 옵션으로 직접 전달한다.
   * - refs 가 비면 모든 참조(--all)를 대상으로 한다.
   * @param limit 이번 페이지에서 가져올 최대 커밋 수
   * @param skip  이미 로드한 커밋 수(앞에서 건너뛸 개수)
   * @param refs  대상 참조 목록(비면 --all)
   * @param includeLocalOnlyBranches true 면 로컬 전용 브랜치 표시 메타데이터까지 붙인다.
   */
  async getCommitPage(
    limit: number,
    skip: number,
    refs: string[] = [],
    includeLocalOnlyBranches = true
  ): Promise<Commit[]> {
    const safeLimit = Math.max(0, Math.floor(limit));
    if (safeLimit === 0) {
      return [];
    }
    const safeSkip = Math.max(0, Math.floor(skip));
    if (safeSkip === 0) {
      this.invalidateCaches();
    }
    const refArgs = refs.length > 0 ? refs : ["--branches", "--remotes", "--tags"];
    const out = await runGit(
      [
        "log",
        "--topo-order",
        "--decorate=short",
        `--pretty=tformat:${gitLogPrettyFormat()}`,
        "-z",
        `-n${safeLimit}`,
        ...(safeSkip > 0 ? [`--skip=${safeSkip}`] : []),
        ...refArgs,
      ],
      this.repoRoot
    );

    const commits = parseGitLogOutput(out);
    if (includeLocalOnlyBranches) {
      await this.attachLocalOnlyBranches(commits);
    }
    return commits;
  }

  /**
   * 특정 commit 을 중심으로 graph window 를 읽는다.
   * - 오래된 PR commit 으로 점프할 때 HEAD 부터 대상까지 모든 중간 페이지를 누적하지 않고,
   *   대상 위/아래 일부 커밋만 새 graph view 로 렌더링하기 위해 사용한다.
   * @param hash   중심 commit hash
   * @param before 중심 commit 위쪽에 포함할 descendant 수
   * @param after  중심 commit 과 아래쪽 ancestor 수
   * @param refs   대상 ref 목록. 비면 전체 branch/remote/tag 범위
   */
  async getCommitWindowAround(
    hash: string,
    before: number,
    after: number,
    refs: string[] = []
  ): Promise<Commit[]> {
    return loadCommitWindowAround(this.repoRoot, hash, { before, after, refs });
  }

  /**
   * 커밋 한 개의 상세(메시지/작성자/변경 파일+증감)를 반환한다.
   * - 변경 파일은 첫 부모(루트면 빈 트리)와의 diff 로 구한다.
   * @param hash 대상 커밋 해시
   */
  async getCommitDetail(hash: string): Promise<CommitDetail> {
    if (isVirtualCommitHash(hash)) {
      return this.getVirtualCommitDetail(hash);
    }
    const headerFormat = ["%H", "%P", "%an", "%ae", "%aI", "%B"].join(FS);
    const header = await runGit(
      ["show", "-s", `--pretty=format:${headerFormat}`, hash],
      this.repoRoot
    );
    const parts = header.split(FS);
    const parents = parts[1] ? parts[1].split(" ").filter(Boolean) : [];
    const base = parents[0] ?? EMPTY_TREE;

    const [files, branches] = await Promise.all([
      this.getCommitFiles(base, hash),
      this.branchRefCache.getBranchesContainingCommit(hash),
    ]);
    return {
      hash: parts[0],
      parents,
      authorName: parts[2] ?? "",
      authorEmail: parts[3] ?? "",
      authorDateIso: parts[4] ?? "",
      message: parts.slice(5).join(FS).trimEnd(),
      branches,
      files,
    };
  }

  /**
   * 지정 커밋의 부모 해시 목록을 반환한다.
   * - merge commit revert 에서 mainline parent 를 고를 때 사용한다.
   * @param hash 대상 커밋 해시
   */
  async getCommitParents(hash: string): Promise<string[]> {
    if (isVirtualCommitHash(hash)) {
      return [];
    }
    const out = await runGit(["show", "-s", "--pretty=%P", hash], this.repoRoot);
    return out.trim().split(/\s+/).filter(Boolean);
  }

  /**
   * 로컬 브랜치 현황을 반환한다.
   * - refs/heads 만 읽어 현재 브랜치, upstream, ahead/behind, 마지막 커밋 정보를 보여준다.
   * - upstream 이 사라진 브랜치는 gone=true 로 표시해 사용자가 정리가 필요한 브랜치를 찾게 한다.
   */
  async getLocalBranches(): Promise<LocalBranchStatus[]> {
    const format = [
      "%(HEAD)",
      "%(refname:short)",
      "%(objectname)",
      "%(upstream:short)",
      "%(upstream:track)",
      "%(committerdate:iso8601-strict)",
      "%(subject)",
    ].join(FS);
    const out = await runGit(
      ["for-each-ref", "--sort=-committerdate", `--format=${format}`, "refs/heads"],
      this.repoRoot
    );
    return out
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => this.parseBranchStatus(line));
  }

  /**
   * 현재 index/working tree 상태를 그래프 맨 위에 붙일 가상 커밋으로 만든다.
   * - uncommitted 변경이 없으면 빈 배열을 반환해 실제 git log 만 렌더링하게 한다.
   * - ongoing 은 working tree 전체(HEAD 대비 staged+unstaged), staged 는 index 스냅샷을 뜻한다.
   */
  async getVirtualCommits(): Promise<Commit[]> {
    const status = await runGit(["status", "--porcelain=v1"], this.repoRoot);
    if (!status.trim()) {
      return [];
    }
    const head = await this.getHeadHash();
    const now = new Date().toISOString();
    return [
      virtualCommit("ongoing", ONGOING_COMMIT_HASH, [STAGED_COMMIT_HASH], now),
      virtualCommit("staged", STAGED_COMMIT_HASH, head ? [head] : [], now),
    ];
  }

  /**
   * 그래프의 로컬 브랜치 chip 클릭에서 선택한 브랜치로 전환한다.
   * - 호출부에서 getLocalBranches 로 검증한 로컬 브랜치 이름만 전달한다.
   * - merge=true 면 작업트리 변경과 대상 브랜치를 3-way merge 하며 checkout 해 충돌을 노출한다.
   * @param branchName 전환할 로컬 브랜치 이름
   * @param merge      로컬 변경 충돌 시 merge checkout 을 시도할지 여부
   */
  async checkoutLocalBranch(branchName: string, merge = false): Promise<void> {
    await this.ensureCheckoutAllowed();
    await runGit(
      ["switch", ...(merge ? ["--merge"] : []), branchName],
      this.repoRoot
    );
    this.invalidateCaches();
  }

  /**
   * 원격 브랜치와 같은 이름의 로컬 브랜치를 만들고 checkout 한다.
   * - origin/feature 처럼 remote/name 형태의 ref 에서 name 부분을 로컬 브랜치명으로 쓴다.
   * - merge=true 면 작업트리 변경과 대상 브랜치를 3-way merge 하며 checkout 해 충돌을 노출한다.
   * @param remoteBranch checkout 할 원격 브랜치 short name
   * @param merge        로컬 변경 충돌 시 merge checkout 을 시도할지 여부
   * @returns 생성/checkout 한 로컬 브랜치명
   */
  async checkoutRemoteBranchAsLocal(
    remoteBranch: string,
    merge = false
  ): Promise<string> {
    await this.ensureCheckoutAllowed();
    const localName = localNameFromRemoteRef(remoteBranch);
    await runGit(
      [
        "switch",
        ...(merge ? ["--merge"] : []),
        "-c",
        localName,
        "--track",
        remoteBranch,
      ],
      this.repoRoot
    );
    this.invalidateCaches();
    return localName;
  }

  /**
   * 특정 커밋으로 detached HEAD checkout 을 수행한다.
   * @param hash  checkout 할 커밋 해시
   * @param merge 로컬 변경과 3-way merge 하며 전환할지 여부
   */
  async checkoutCommitDetached(hash: string, merge = false): Promise<void> {
    await this.ensureCheckoutAllowed();
    await runGit(
      ["switch", ...(merge ? ["--merge"] : []), "--detach", hash],
      this.repoRoot
    );
    this.invalidateCaches();
  }

  /** rebase 진행 중에는 다른 브랜치/커밋으로 checkout 하지 못하게 막는다. */
  async ensureCheckoutAllowed(): Promise<void> {
    if (await detectOperation(this.repoRoot) === "rebase") {
      throw new Error(
        "Cannot checkout while a rebase is in progress. Continue or abort the rebase first."
      );
    }
  }

  /** 지정 커밋을 시작점으로 새 로컬 브랜치를 만든다. */
  async createBranchAt(name: string, startPoint: string): Promise<void> {
    await runGit(["branch", name, startPoint], this.repoRoot);
    this.invalidateCaches();
  }

  /** 로컬 브랜치를 삭제한다. */
  async deleteLocalBranch(name: string, force = false): Promise<void> {
    await runGit(["branch", force ? "-D" : "-d", name], this.repoRoot);
    this.invalidateCaches();
  }

  /** 원격 브랜치를 원격 저장소에서 삭제한다. */
  async deleteRemoteBranch(ref: string): Promise<void> {
    const parsed = splitRemoteRef(ref);
    await runGit(["push", parsed.remote, "--delete", parsed.branch], this.repoRoot);
    this.invalidateCaches();
  }

  /** 그래프 액션에서 선택할 수 있는 브랜치 목록을 반환한다. */
  async getBranches(): Promise<{ name: string; kind: "local" | "remote" }[]> {
    const out = await runGit(
      [
        "for-each-ref",
        "--format=%(refname:short)\x1f%(refname)",
        "refs/heads",
        "refs/remotes",
      ],
      this.repoRoot
    );
    return out
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        const [name, full] = line.split(FS);
        if (!name || name.endsWith("/HEAD")) {
          return [];
        }
        return [{ name, kind: full.startsWith("refs/remotes/") ? "remote" : "local" }];
      });
  }

  /** 특정 커밋에 lightweight tag 를 만든다. */
  async createTag(name: string, target: string): Promise<void> {
    await runGit(["tag", name, target], this.repoRoot);
  }

  /** 로컬 tag 를 삭제한다. */
  async deleteTag(name: string): Promise<void> {
    await runGit(["tag", "-d", name], this.repoRoot);
  }

  /** 원격 저장소에서 tag 를 삭제한다. */
  async deleteRemoteTag(remote: string, name: string): Promise<void> {
    await runGit(["push", remote, `:refs/tags/${name}`], this.repoRoot);
  }

  /** tag 목록을 이름순으로 반환한다. */
  async getTags(): Promise<string[]> {
    const out = await runGit(["tag", "--list"], this.repoRoot);
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  /** 원격 저장소 목록을 반환한다. */
  async getRemotes(): Promise<string[]> {
    const out = await runGit(["remote"], this.repoRoot);
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  /** 지정 tag 를 원격 저장소로 push 한다. */
  async pushTag(remote: string, name: string): Promise<void> {
    await runGit(["push", remote, `refs/tags/${name}`], this.repoRoot);
  }

  /** 전체 원격 브랜치 ref 를 fetch/prune 한다. tag 동기화는 tag 충돌을 피하기 위해 별도 액션으로 분리한다. */
  async fetchAll(): Promise<void> {
    await runGit(["fetch", "--all", "--prune"], this.repoRoot);
    this.invalidateCaches();
  }

  /** tag 목록만 원격에서 가져온다. */
  async fetchTags(): Promise<void> {
    await runGit(["fetch", "--tags"], this.repoRoot);
  }

  /** 현재 브랜치의 upstream 변경을 fast-forward 방식으로 pull 한다. */
  async pullCurrent(): Promise<void> {
    await runGit(["pull", "--ff-only"], this.repoRoot);
    this.invalidateCaches();
  }

  /** 현재 브랜치의 커밋을 remote 로 push 한다. upstream 보정 계획은 호출부가 먼저 확인한다. */
  async pushCurrent(plan?: PushCurrentPlan): Promise<PushCurrentResult> {
    const result = await pushCurrentWithAutoUpstream(this.repoRoot, plan);
    this.invalidateCaches();
    return result;
  }

  /** 현재 브랜치의 커밋을 사용자가 고른 force 옵션으로 remote 에 push 한다. */
  async forcePushCurrent(
    mode: ForcePushMode,
    plan?: PushCurrentPlan
  ): Promise<PushCurrentResult> {
    const result = await forcePushCurrent(this.repoRoot, mode, plan);
    this.invalidateCaches();
    return result;
  }

  /** 지정 커밋을 현재 브랜치에 cherry-pick 한다. */
  async cherryPick(hash: string): Promise<void> {
    await runGit(["cherry-pick", hash], this.repoRoot);
    this.invalidateCaches();
  }

  /**
   * 현재 로컬 브랜치에 포함된 커밋을 revert 해서 새 커밋을 만든다.
   * - detached HEAD 나 현재 브랜치에 포함되지 않은 커밋은 차단한다.
   * - merge commit 은 호출부가 고른 mainline parent 번호가 필요하다.
   * @param hash     revert 대상 커밋 해시
   * @param mainline merge commit revert 에 사용할 mainline parent 번호(1부터 시작)
   */
  async revertCommitOnCurrentBranch(
    hash: string,
    mainline?: number
  ): Promise<RevertCommitResult> {
    if (isVirtualCommitHash(hash)) {
      throw new Error("Virtual commits cannot be reverted.");
    }
    await this.assertReadyForRevert();
    const branch = (await this.getLocalBranches()).find((item) => item.current);
    if (!branch) {
      throw new Error("Only commits on the current local branch can be reverted.");
    }
    const targetHash = await this.normalizeCommit(hash);
    if (!(await this.isAncestor(targetHash, "HEAD"))) {
      throw new Error("Only commits on the current local branch can be reverted.");
    }
    await this.assertValidRevertMainline(targetHash, mainline);
    const beforeHead = await this.getHeadHash();
    if (!beforeHead) {
      throw new Error("Cannot revert because HEAD is unavailable.");
    }
    try {
      await runGit(
        [
          "revert",
          "--no-edit",
          ...(mainline ? ["-m", String(mainline)] : []),
          targetHash,
        ],
        this.repoRoot,
        { env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" } }
      );
    } catch (err) {
      this.invalidateCaches();
      if (
        (await detectOperation(this.repoRoot).catch(() => "none")) === "revert" &&
        (await this.hasUnmergedChanges())
      ) {
        return {
          status: "conflicts",
          branch: branch.name,
          targetHash,
          beforeHead,
        };
      }
      throw err;
    }
    const afterHead = await this.getHeadHash();
    if (!afterHead) {
      throw new Error("Revert completed, but the new HEAD could not be read.");
    }
    this.invalidateCaches();
    return {
      status: "reverted",
      branch: branch.name,
      targetHash,
      beforeHead,
      afterHead,
    };
  }

  /**
   * 현재 로컬 브랜치의 최신 unpushed commit 을 되돌린다.
   * - HEAD 가 요청 해시와 같고, 현재 브랜치가 upstream 보다 앞서 있거나 upstream 이 없는 경우만 허용한다.
   * - --soft reset 을 사용해 커밋 내용은 staged 상태로 남긴다.
   * @param hash undo 대상 HEAD 커밋 해시
   */
  async undoLastUnpushedCommit(hash: string): Promise<void> {
    const branch = (await this.getLocalBranches()).find((item) => item.current);
    if (!branch || branch.hash !== hash || !isUnpushedLocalHead(branch)) {
      throw new Error(`Commit is not an unpushed local HEAD: ${hash}`);
    }
    await runGit(["reset", "--soft", "HEAD~1"], this.repoRoot);
    this.invalidateCaches();
  }

  // ---- 내부 구현 ----

  /** 브랜치 ref 와 로컬 전용 커밋 표시 캐시를 함께 비운다. */
  invalidateCaches(): void {
    this.branchRefCache.invalidate();
    this.localOnlyBranchMapPromise = undefined;
  }

  /**
   * 현재 페이지 커밋에 upstream 보다 앞선 로컬 브랜치 이름을 붙인다.
   * - 그래프에서 원격 기준점 이후의 로컬 전용 노드를 별도 스타일로 표시하기 위한 메타데이터다.
   * @param commits 이번 그래프 페이지에 포함된 커밋 목록
   * @returns 로컬 전용 브랜치 메타데이터가 붙은 커밋 수
   */
  async attachLocalOnlyBranches(commits: Commit[]): Promise<number> {
    if (!commits.length) {
      return 0;
    }
    const byHash = await this.localOnlyBranchMap().catch(() => new Map<string, string[]>());
    let changed = 0;
    for (const commit of commits) {
      const branches = byHash.get(commit.hash);
      if (branches?.length) {
        commit.localOnlyBranches = [...branches];
        changed++;
      }
    }
    return changed;
  }

  /**
   * 로컬 전용 커밋 해시별 브랜치 목록을 캐시해서 반환한다.
   * @returns commit hash → 이 커밋을 upstream 보다 앞선 변경으로 포함하는 로컬 브랜치 이름들
   */
  private localOnlyBranchMap(): Promise<Map<string, string[]>> {
    if (!this.localOnlyBranchMapPromise) {
      this.localOnlyBranchMapPromise = this.loadLocalOnlyBranchMap();
    }
    return this.localOnlyBranchMapPromise;
  }

  /**
   * ahead 상태인 로컬 브랜치의 `upstream..local` 범위를 해시별로 묶는다.
   * - upstream 이 없거나 사라진 브랜치는 기준점이 모호하므로 여기서는 표시하지 않는다.
   * @returns 로컬 전용 커밋 해시별 브랜치 이름 맵
   */
  private async loadLocalOnlyBranchMap(): Promise<Map<string, string[]>> {
    const branches = await this.getLocalBranches().catch(() => []);
    return loadLocalOnlyBranchMap(this.repoRoot, branches);
  }

  /**
   * base..hash 사이 변경 파일 목록을 상태 + 증감 라인 수와 함께 만든다.
   * @param base 비교 기준(첫 부모 또는 빈 트리)
   * @param hash 대상 커밋
   */
  private async getCommitFiles(
    base: string,
    hash: string
  ): Promise<CommitFileChange[]> {
    return this.getFilesFromDiff(
      ["diff", "--name-status", "-M", "-z", base, hash],
      ["diff", "--numstat", "-z", "-M", base, hash]
    );
  }

  /**
   * 가상 커밋 detail 을 만든다.
   * @param hash ongoing/staged 가상 커밋 해시
   */
  private async getVirtualCommitDetail(hash: string): Promise<CommitDetail> {
    const kind: GraphRowKind =
      hash === ONGOING_COMMIT_HASH ? "ongoing" : "staged";
    const head = await this.getHeadHash();
    const base = head ? "HEAD" : EMPTY_TREE;
    let files =
      kind === "ongoing"
        ? await this.getFilesFromDiff(
            ["diff", "--name-status", "-M", "-z", base],
            ["diff", "--numstat", "-z", "-M", base]
          )
        : await this.getFilesFromDiff(
            ["diff", "--cached", "--name-status", "-M", "-z", base],
            ["diff", "--cached", "--numstat", "-z", "-M", base]
          );
    if (kind === "ongoing") {
      files = [...files, ...(await this.getUntrackedFiles(files))];
    }
    const parent = kind === "ongoing" ? STAGED_COMMIT_HASH : head;
    return {
      hash,
      parents: parent ? [parent] : [],
      authorName: kind === "ongoing" ? "Working Tree" : "Index",
      authorEmail: "",
      authorDateIso: new Date().toISOString(),
      message:
        kind === "ongoing"
          ? "Ongoing changes\n\nIncludes staged and unstaged working tree changes."
          : "Staged changes\n\nRepresents the current index snapshot.",
      branches: await this.branchRefCache.getCurrentBranches(),
      files,
      kind,
    };
  }

  /**
   * name-status 와 numstat 인자 쌍을 실행해 CommitFileChange 배열로 합친다.
   * @param nameStatusArgs `git` 뒤에 붙일 name-status 인자
   * @param numstatArgs    `git` 뒤에 붙일 numstat 인자
   */
  private async getFilesFromDiff(
    nameStatusArgs: string[],
    numstatArgs: string[]
  ): Promise<CommitFileChange[]> {
    const nameStatus = await runGit(
      nameStatusArgs,
      this.repoRoot
    );
    const numstat = await runGit(
      numstatArgs,
      this.repoRoot
    );
    const counts = parseNumstat(numstat);

    return parseNameStatusZ(nameStatus).map((change) => {
      const stat = counts.get(change.path);
      return {
        status: change.status,
        path: change.path,
        oldPath: change.oldPath,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
      };
    });
  }

  /**
   * 아직 git 이 추적하지 않는 파일을 ongoing 가상 커밋 파일 목록에 추가한다.
   * @param existing 이미 diff 로 찾은 파일 목록(중복 방지용)
   */
  private async getUntrackedFiles(
    existing: CommitFileChange[]
  ): Promise<CommitFileChange[]> {
    const seen = new Set(existing.map((file) => file.path));
    const out = await runGit(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      this.repoRoot
    );
    const paths = out
      .split("\0")
      .filter((path) => path.length > 0 && !seen.has(path));
    return Promise.all(
      paths.map(async (path) => ({
        status: "A" as const,
        path,
        additions: (await countUntrackedLines(this.repoRoot, path)) ?? 0,
        deletions: 0,
      }))
    );
  }

  /** revert 시작 전 진행 중인 git 작업이나 unmerged 파일이 없는지 확인한다. */
  private async assertReadyForRevert(): Promise<void> {
    const operation = await detectOperation(this.repoRoot);
    if (operation !== "none") {
      throw new Error(`Cannot revert while ${operation} is in progress.`);
    }
    if (await this.hasUnmergedChanges()) {
      throw new Error("Resolve unmerged files before reverting a commit.");
    }
  }

  /**
   * merge commit revert 의 mainline parent 번호가 실제 부모 범위 안에 있는지 확인한다.
   * @param hash     revert 대상 커밋 해시
   * @param mainline 사용자가 선택한 mainline parent 번호
   */
  private async assertValidRevertMainline(
    hash: string,
    mainline?: number
  ): Promise<void> {
    const parents = await this.getCommitParents(hash);
    if (parents.length <= 1) {
      return;
    }
    if (
      !Number.isInteger(mainline) ||
      !mainline ||
      mainline < 1 ||
      mainline > parents.length
    ) {
      throw new Error("Reverting a merge commit requires a mainline parent.");
    }
  }

  /**
   * ancestor 가 target 의 조상인지 확인한다.
   * @param ancestor 조상이어야 하는 커밋
   * @param target   기준 커밋/ref
   */
  private async isAncestor(ancestor: string, target: string): Promise<boolean> {
    try {
      await runGit(["merge-base", "--is-ancestor", ancestor, target], this.repoRoot);
      return true;
    } catch {
      return false;
    }
  }

  /** unmerged 파일이 남아 있는지 확인한다. */
  private async hasUnmergedChanges(): Promise<boolean> {
    const out = await runGit(
      ["diff", "--name-only", "--diff-filter=U"],
      this.repoRoot
    );
    return out.trim().length > 0;
  }

  /**
   * 입력 ref 가 실제 commit 인지 검증하고 전체 해시로 정규화한다.
   * @param hash 커밋으로 해석할 ref/hash
   */
  private async normalizeCommit(hash: string): Promise<string> {
    return (
      await runGit(["rev-parse", "--verify", `${hash}^{commit}`], this.repoRoot)
    ).trim();
  }

  /** 현재 HEAD 해시를 반환한다. 아직 커밋이 없으면 undefined 를 반환한다. */
  private async getHeadHash(): Promise<string | undefined> {
    try {
      return (await runGit(["rev-parse", "--verify", "HEAD"], this.repoRoot)).trim();
    } catch {
      return undefined;
    }
  }

  /**
   * git for-each-ref 한 줄을 로컬 브랜치 상태로 변환한다.
   * @param entry FS 로 구분된 브랜치 출력
   */
  private parseBranchStatus(entry: string): LocalBranchStatus {
    const [head, name, hash, upstream, track, dateIso, subject] = entry.split(FS);
    const parsedTrack = parseTrack(track ?? "");
    return {
      name: name ?? "",
      hash: hash ?? "",
      upstream: upstream || undefined,
      ahead: parsedTrack.ahead,
      behind: parsedTrack.behind,
      gone: parsedTrack.gone,
      current: head === "*",
      dateIso: dateIso ?? "",
      subject: subject ?? "",
    };
  }
}

/** 지정 해시가 그래프 전용 가상 커밋인지 확인한다. */
function isVirtualCommitHash(hash: string): boolean {
  return hash === ONGOING_COMMIT_HASH || hash === STAGED_COMMIT_HASH;
}

/** 작업트리/index 상태를 나타내는 가상 Commit 객체를 만든다. */
function virtualCommit(
  kind: GraphRowKind,
  hash: string,
  parents: string[],
  dateIso: string
): Commit {
  return {
    hash,
    parents,
    authorName: kind === "ongoing" ? "Working Tree" : "Index",
    authorEmail: "",
    dateIso,
    refs: [`virtual:${kind}`],
    subject: kind === "ongoing" ? "Ongoing changes" : "Staged changes",
    kind,
  };
}
