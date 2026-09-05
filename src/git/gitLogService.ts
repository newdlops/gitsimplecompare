// git 로그/커밋 상세를 읽는 서비스 모듈.
// - 그래프 UI 가 필요로 하는 커밋 목록과, 노드 클릭 시 보여줄 상세 정보를 제공한다.
// - git 접근은 공유 실행기(runGit)만 사용한다(경계 분리).
import { runGit } from "./gitExec";
import { logInfo } from "../ui/outputLog";
import { parseNameStatusZ, parseNumstat } from "./diffParse";
import {
  Commit,
  CommitDetail,
  CommitFileChange,
  GraphLocalBranchSnapshot,
  GraphRowKind,
  LocalBranchStatus,
} from "../graph/graphTypes";
import { GitBranchRefCache } from "./gitBranchRefCache";
import { invalidateGitBranchListCaches } from "./gitBranchListCache";
import { GitGraphActionService } from "./gitGraphActionService";
import type { RevertCommitResult } from "./gitGraphActionService";
import { runGitStatus } from "./gitStatusExec";
import { readGraphLocalBranchSnapshot } from "./graphLocalBranches";
import { GitLocalOnlyBranchCache } from "./gitLocalOnlyBranches";
import { gitLogPrettyFormat, LOG_FIELD_SEPARATOR, parseGitLogOutput } from "./gitLogParse";
import {
  ForcePushMode,
  PushCurrentPlan,
  PushCurrentResult,
} from "./pushService";
import { countUntrackedLines } from "./untrackedStats";

export type { RevertCommitResult } from "./gitGraphActionService";

/** 빈 트리 오브젝트 해시(루트 커밋의 부모 대용으로 diff 비교에 사용) */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** 작업트리 전체 상태를 나타내는 그래프 전용 가상 커밋 해시 */
export const ONGOING_COMMIT_HASH = "__gsc_virtual_ongoing__";
/** index 상태를 나타내는 그래프 전용 가상 커밋 해시 */
export const STAGED_COMMIT_HASH = "__gsc_virtual_staged__";

/** 로그 필드 구분자(제어문자 Unit Separator) */
const FS = LOG_FIELD_SEPARATOR;

/**
 * 특정 저장소의 로그/상세를 다루는 서비스(저장소 루트 1개에 대응).
 */
export class GitLogService {
  private readonly branchRefCache: GitBranchRefCache;
  private readonly localOnlyBranchCache: GitLocalOnlyBranchCache;
  private readonly graphActions: GitGraphActionService;

  constructor(public readonly repoRoot: string) {
    this.branchRefCache = new GitBranchRefCache(repoRoot, FS);
    this.localOnlyBranchCache = new GitLocalOnlyBranchCache(repoRoot);
    this.graphActions = new GitGraphActionService(repoRoot, () => {
      this.invalidateCaches();
      invalidateGitBranchListCaches(repoRoot);
    });
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
    if (safeSkip === 0 && this.branchRefCache.getStats().indexedPages > 0) this.branchRefCache.invalidate();
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
    const branchStats = this.branchRefCache.indexPage({ commits, skip: safeSkip, allRefs: refs.length === 0 });
    logInfo("graph branch containment index page", {
      repoRoot: this.repoRoot, skip: safeSkip, commits: commits.length,
      snapshots: branchStats.snapshots, indexedPages: branchStats.indexedPages,
      indexedCommits: branchStats.indexedCommits, fallbacks: branchStats.fallbacks,
      incomplete: branchStats.incomplete,
    });
    if (includeLocalOnlyBranches) {
      await this.attachLocalOnlyBranches(commits);
    }
    return commits;
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
   * - 손상 ref는 Graph 전용 snapshot 경계에서 격리해 다른 브랜치 작업도 중단되지 않게 한다.
   */
  async getLocalBranches(): Promise<LocalBranchStatus[]> {
    return (await this.getLocalBranchSnapshot()).branches;
  }

  /**
   * Graph 첫 로드가 정상 브랜치와 손상 ref를 동시에 판단할 수 있는 snapshot을 반환한다.
   * @returns 정상 LocalBranchStatus와 UI에 경고할 누락-object ref 목록
   */
  async getLocalBranchSnapshot(): Promise<GraphLocalBranchSnapshot> {
    return readGraphLocalBranchSnapshot(this.repoRoot);
  }

  /**
   * Graph가 이미 읽은 local/remote tip을 containment cache에 주입한다.
   * - 같은 ref를 다시 읽지 않아 cold-start 첫 post와 background warmup을 분리한다.
   * @param localStatus 현재 local branch status 조회 결과
   * @param remoteTips remote catalog가 제공한 name/object ID 목록
   */
  seedGraphBranchTips(localStatus: readonly LocalBranchStatus[], remoteTips?: readonly { name: string; hash: string }[]): void {
    this.branchRefCache.seedLocalBranches(localStatus);
    this.localOnlyBranchCache.setLocalBranches(localStatus);
    if (remoteTips) {
      this.branchRefCache.seedRemoteBranches(remoteTips);
      this.localOnlyBranchCache.setRemoteTips(remoteTips);
    }
  }

  /** remote catalog 실패를 containment/local-only cache에 반영해 과거 remote tip 표시를 제거한다. */
  markGraphRemoteBranchesUnavailable(): void {
    this.branchRefCache.seedRemoteBranches([]);
    this.localOnlyBranchCache.setRemoteUnavailable();
  }

  /**
   * 현재 index/working tree 상태를 그래프 맨 위에 붙일 가상 커밋으로 만든다.
   * - uncommitted 변경이 없으면 빈 배열을 반환해 실제 git log 만 렌더링하게 한다.
   * - ongoing 은 working tree 전체(HEAD 대비 staged+unstaged), staged 는 index 스냅샷을 뜻한다.
   */
  async getVirtualCommits(): Promise<Commit[]> {
    const status = await runGitStatus(["status", "--porcelain=v1"], this.repoRoot);
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

  /** 로컬 브랜치 전환을 변경 전용 서비스에 위임한다. */
  checkoutLocalBranch(branchName: string, merge = false): Promise<void> {
    return this.graphActions.checkoutLocalBranch(branchName, merge);
  }

  /** 원격 추적 브랜치 생성과 전환을 변경 전용 서비스에 위임한다. */
  checkoutRemoteBranchAsLocal(remoteBranch: string, merge = false): Promise<string> {
    return this.graphActions.checkoutRemoteBranchAsLocal(remoteBranch, merge);
  }

  /** 원격 short ref를 받아 checkout 확인창에 표시할 충돌 없는 로컬 생성 후보 이름을 반환한다. */
  getRemoteBranchCheckoutName(remoteBranch: string): Promise<string> {
    return this.graphActions.getRemoteBranchCheckoutName(remoteBranch);
  }

  /** detached HEAD 전환을 변경 전용 서비스에 위임한다. */
  checkoutCommitDetached(hash: string, merge = false): Promise<void> {
    return this.graphActions.checkoutCommitDetached(hash, merge);
  }

  /** rebase 중 checkout 차단 여부 검사를 변경 전용 서비스에 위임한다. */
  ensureCheckoutAllowed(): Promise<void> {
    return this.graphActions.ensureCheckoutAllowed();
  }

  /** 새 로컬 브랜치 생성을 변경 전용 서비스에 위임한다. */
  createBranchAt(name: string, startPoint: string): Promise<void> {
    return this.graphActions.createBranchAt(name, startPoint);
  }

  /** 로컬 브랜치 삭제를 변경 전용 서비스에 위임한다. */
  deleteLocalBranch(name: string, force = false): Promise<void> {
    return this.graphActions.deleteLocalBranch(name, force);
  }

  /** 원격 브랜치 삭제를 변경 전용 서비스에 위임한다. */
  deleteRemoteBranch(ref: string): Promise<void> {
    return this.graphActions.deleteRemoteBranch(ref);
  }

  /** Graph 액션용 브랜치 목록 조회를 변경 전용 서비스에 위임한다. */
  getBranches(): Promise<{ name: string; kind: "local" | "remote" }[]> {
    return this.graphActions.getBranches();
  }

  /** lightweight tag 생성을 변경 전용 서비스에 위임한다. */
  createTag(name: string, target: string): Promise<void> {
    return this.graphActions.createTag(name, target);
  }

  /** 로컬 tag 삭제를 변경 전용 서비스에 위임한다. */
  deleteTag(name: string): Promise<void> {
    return this.graphActions.deleteTag(name);
  }

  /** 원격 tag 삭제와 관련 캐시 무효화를 변경 전용 서비스에 위임한다. */
  deleteRemoteTag(remote: string, name: string): Promise<void> {
    return this.graphActions.deleteRemoteTag(remote, name);
  }

  /** 로컬 tag 목록 조회를 변경 전용 서비스에 위임한다. */
  getTags(): Promise<string[]> {
    return this.graphActions.getTags();
  }

  /** 원격 저장소 목록 조회를 변경 전용 서비스에 위임한다. */
  getRemotes(): Promise<string[]> {
    return this.graphActions.getRemotes();
  }

  /** tag push와 관련 캐시 무효화를 변경 전용 서비스에 위임한다. */
  pushTag(remote: string, name: string): Promise<void> {
    return this.graphActions.pushTag(remote, name);
  }

  /** 원격 브랜치 fetch/prune을 변경 전용 서비스에 위임한다. */
  fetchAll(): Promise<void> {
    return this.graphActions.fetchAll();
  }

  /** tag fetch를 변경 전용 서비스에 위임한다. */
  fetchTags(): Promise<void> {
    return this.graphActions.fetchTags();
  }

  /** 현재 브랜치 fast-forward pull을 변경 전용 서비스에 위임한다. */
  pullCurrent(): Promise<void> {
    return this.graphActions.pullCurrent();
  }

  /** 현재 브랜치 push와 upstream 보정을 변경 전용 서비스에 위임한다. */
  pushCurrent(plan?: PushCurrentPlan): Promise<PushCurrentResult> {
    return this.graphActions.pushCurrent(plan);
  }

  /** 현재 브랜치 force push를 변경 전용 서비스에 위임한다. */
  forcePushCurrent(mode: ForcePushMode, plan?: PushCurrentPlan): Promise<PushCurrentResult> {
    return this.graphActions.forcePushCurrent(mode, plan);
  }

  /** cherry-pick 실행을 변경 전용 서비스에 위임한다. */
  cherryPick(hash: string): Promise<void> {
    return this.graphActions.cherryPick(hash);
  }

  /** 현재 브랜치 commit revert를 변경 전용 서비스에 위임한다. */
  revertCommitOnCurrentBranch(hash: string, mainline?: number): Promise<RevertCommitResult> {
    return this.graphActions.revertCommitOnCurrentBranch(hash, mainline);
  }

  /** 마지막 unpushed commit의 soft reset을 변경 전용 서비스에 위임한다. */
  undoLastUnpushedCommit(hash: string): Promise<void> {
    return this.graphActions.undoLastUnpushedCommit(hash);
  }

  // ---- 내부 구현 ----

  /** 브랜치 ref 와 로컬 전용 커밋 표시 캐시를 함께 비운다. */
  invalidateCaches(): void {
    const branchStats = this.branchRefCache.getStats();
    logInfo("graph branch containment index invalidated", {
      repoRoot: this.repoRoot, generation: branchStats.generation,
      snapshots: branchStats.snapshots, indexedPages: branchStats.indexedPages,
      indexedCommits: branchStats.indexedCommits, fallbacks: branchStats.fallbacks,
      incomplete: branchStats.incomplete,
    });
    this.branchRefCache.invalidate();
    this.localOnlyBranchCache.invalidate("gitMutation");
  }

  /** UI filter/pagination reset에서는 ref 기반 local-only 결과를 보존하고 page containment index만 초기화한다. */
  resetGraphBranchIndex(): void {
    this.branchRefCache.invalidate();
  }

  /**
   * 패널이 hidden/dispose된 동안 containment propagation이 새 task에서 시작하지 못하게 취소한다.
   * @param reason OUTPUT에서 lifecycle 취소 원인을 확인할 문자열
   * @returns 없음
   */
  cancelGraphBranchContainment(reason: string): void {
    this.branchRefCache.cancelWarmup(reason);
    this.localOnlyBranchCache.cancel(reason);
  }

  /**
   * checkout처럼 화면의 기존 DAG를 재사용할 때 새 ref snapshot으로 containment를 다시 만든다.
   * @param commits 화면에 유지한 topo-order 커밋 목록
   * @param skip 이 목록의 git log 시작 offset
   * @param refs 화면이 사용 중인 명시 ref. 비어야 all-refs exact index가 된다.
   */
  async reindexGraphBranchContainment(commits: readonly Commit[], skip: number, refs: readonly string[]): Promise<void> {
    const stats = this.branchRefCache.indexPage({ commits, skip, allRefs: refs.length === 0 });
    logInfo("graph branch containment index reused", {
      repoRoot: this.repoRoot, commits: commits.length, skip,
      snapshots: stats.snapshots, indexedPages: stats.indexedPages,
      indexedCommits: stats.indexedCommits, fallbacks: stats.fallbacks,
      incomplete: stats.incomplete,
    });
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
    const byHash = await this.localOnlyBranchCache.getMap().catch(() => new Map<string, string[]>());
    let changed = 0;
    for (const commit of commits) {
      const branches = byHash.get(commit.hash);
      delete commit.localOnlyBranches;
      if (branches?.length) {
        commit.localOnlyBranches = [...branches];
        changed++;
      }
    }
    return changed;
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

  /** 현재 HEAD 해시를 반환한다. 아직 커밋이 없으면 undefined 를 반환한다. */
  private async getHeadHash(): Promise<string | undefined> {
    try {
      return (await runGit(["rev-parse", "--verify", "HEAD"], this.repoRoot)).trim();
    } catch {
      return undefined;
    }
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
