// git graph 상세 패널에서 쓰는 브랜치 ref 캐시.
// - 브랜치 ref 전체를 한 번에 읽고 해시별로 묶어, 커밋 클릭마다 git 을 다시 호출하지 않게 한다.
import type { CommitBranchInfo } from "../graph/graphTypes";
import { runGit } from "./gitExec";
import { parseBranchRefRecords } from "./gitLogRefs";

/** 브랜치 ref 캐시의 현재 스냅샷 */
interface BranchRefSnapshot {
  byHash: Map<string, CommitBranchInfo[]>;
  current: CommitBranchInfo[];
}

/**
 * 저장소의 local/remote branch ref 를 해시별로 캐시한다.
 * - 캐시는 GitLogService 인스턴스 생명주기를 따르며, checkout/fetch/branch 변경 뒤 명시적으로 무효화한다.
 */
export class GitBranchRefCache {
  private snapshotPromise: Promise<BranchRefSnapshot> | undefined;
  private containsPromises = new Map<string, Promise<CommitBranchInfo[]>>();

  /**
   * @param repoRoot  git 명령을 실행할 저장소 루트
   * @param separator git for-each-ref 포맷 필드 구분자
   */
  constructor(
    private readonly repoRoot: string,
    private readonly separator: string
  ) {}

  /**
   * 지정 커밋을 직접 가리키는 branch ref 목록을 캐시에서 반환한다.
   * @param hash 브랜치 ref 의 objectname 과 비교할 커밋 해시
   * @returns 커밋을 직접 가리키는 로컬/원격 브랜치 목록
   */
  async getBranchesPointingAt(hash: string): Promise<CommitBranchInfo[]> {
    const snapshot = await this.snapshot();
    return cloneBranchInfos(snapshot.byHash.get(hash) ?? []);
  }

  /**
   * 지정 커밋을 포함하는 branch ref 목록을 반환한다.
   * - 커밋 상세를 열 때마다 `git branch --contains` 계열 조회를 반복하지 않도록 커밋 해시별 Promise 를 캐시한다.
   * @param hash 포함 여부를 확인할 커밋 해시
   * @returns 해당 커밋을 히스토리에 포함하는 로컬/원격 브랜치 목록
   */
  async getBranchesContainingCommit(hash: string): Promise<CommitBranchInfo[]> {
    let cached = this.containsPromises.get(hash);
    if (!cached) {
      cached = this.loadBranchesContainingCommit(hash);
      this.containsPromises.set(hash, cached);
    }
    return cloneBranchInfos(await cached);
  }

  /**
   * 현재 checkout 된 로컬 브랜치 정보를 캐시에서 반환한다.
   * - detached HEAD 상태면 빈 배열이 된다.
   * @returns 현재 브랜치 chip 으로 보여줄 브랜치 목록
   */
  async getCurrentBranches(): Promise<CommitBranchInfo[]> {
    const snapshot = await this.snapshot();
    return cloneBranchInfos(snapshot.current);
  }

  /** 다음 조회가 최신 ref 상태를 다시 읽도록 캐시를 비운다. */
  invalidate(): void {
    this.snapshotPromise = undefined;
    this.containsPromises.clear();
  }

  /**
   * 캐시가 있으면 재사용하고, 없으면 전체 브랜치 ref 스냅샷을 만든다.
   * @returns 해시별/현재 브랜치별로 정리된 캐시 스냅샷
   */
  private snapshot(): Promise<BranchRefSnapshot> {
    if (!this.snapshotPromise) {
      this.snapshotPromise = this.loadSnapshot();
    }
    return this.snapshotPromise;
  }

  /**
   * refs/heads 와 refs/remotes 를 한 번에 읽어 해시별 브랜치 목록으로 묶는다.
   * @returns git ref 테이블에서 만든 캐시 스냅샷
   */
  private async loadSnapshot(): Promise<BranchRefSnapshot> {
    const format = [
      "%(objectname)",
      "%(HEAD)",
      "%(refname:short)",
      "%(refname)",
    ].join(this.separator);
    const out = await runGit(
      [
        "for-each-ref",
        `--format=${format}`,
        "refs/heads",
        "refs/remotes",
      ],
      this.repoRoot
    ).catch(() => "");
    const refs = parseBranchRefRecords(out, this.separator);
    const byHash = new Map<string, CommitBranchInfo[]>();
    const current: CommitBranchInfo[] = [];

    for (const ref of refs) {
      const info = toBranchInfo(ref);
      const list = byHash.get(ref.hash) ?? [];
      list.push(info);
      byHash.set(ref.hash, list);
      if (ref.current) {
        current.push(info);
      }
    }
    return { byHash, current };
  }

  /**
   * refs/heads 와 refs/remotes 중 지정 커밋을 포함하는 브랜치만 읽는다.
   * @param hash 포함 여부를 확인할 커밋 해시
   * @returns git for-each-ref --contains 결과를 상세 패널용 브랜치 정보로 변환한 목록
   */
  private async loadBranchesContainingCommit(hash: string): Promise<CommitBranchInfo[]> {
    const format = [
      "%(objectname)",
      "%(HEAD)",
      "%(refname:short)",
      "%(refname)",
    ].join(this.separator);
    const out = await runGit(
      [
        "for-each-ref",
        "--contains",
        hash,
        `--format=${format}`,
        "refs/heads",
        "refs/remotes",
      ],
      this.repoRoot
    ).catch(() => "");
    return parseBranchRefRecords(out, this.separator).map(toBranchInfo);
  }
}

/**
 * 해시 필드를 제외하고 상세 패널에서 필요한 브랜치 정보만 복사한다.
 * @param ref 해시를 포함한 내부 캐시 ref 레코드
 * @returns 웹뷰 payload 로 보낼 브랜치 정보
 */
function toBranchInfo(ref: CommitBranchInfo & { hash: string }): CommitBranchInfo {
  return {
    name: ref.name,
    tipHash: ref.hash,
    kind: ref.kind,
    current: ref.current,
  };
}

/**
 * 캐시 내부 배열을 호출자가 변경하지 못하도록 얕은 복사본으로 변환한다.
 * @param branches 캐시에 저장된 브랜치 정보 배열
 * @returns 외부로 반환할 브랜치 정보 복사본
 */
function cloneBranchInfos(branches: CommitBranchInfo[]): CommitBranchInfo[] {
  return branches.map((branch) => ({ ...branch }));
}
