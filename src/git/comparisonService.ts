// Explorer와 에디터 장식이 공유하는 비교 스냅샷을 만드는 git 도메인 서비스.
// - 브랜치, 현재 로컬 브랜치의 upstream, GitHub Pull Request 비교를 같은 형태로 정규화한다.
// - VS Code API에 의존하지 않으므로 Explorer/Tab 장식과 다른 UI가 동일한 결과를 재사용할 수 있다.
import type { LocalBranchStatus } from "../graph/graphTypes";
import { GitLogService } from "./gitLogService";
import { runGit } from "./gitExec";
import { GitService } from "./gitService";
import type { DiffBase, FileChange } from "./gitTypes";
import {
  PullRequestService,
  type PullRequestInfo,
  type PullRequestOverview,
} from "./pullRequestService";
import {
  resolvePreviewHeadRef,
  resolvePreviewTargetRef,
} from "./pullRequestPreviewTarget";
import { RemoteBranchService } from "./remoteBranchService";

/** Explorer 비교가 가리킬 수 있는 비교 원본 종류 */
export type ComparisonKind = "branches" | "localRemote" | "pullRequest";

/** PR 스냅샷을 새로고침할 때 다시 조회하는 데 필요한 최소 식별 정보 */
export interface ComparisonPullRequest {
  number: number;
  title: string;
  baseBranch: string;
  baseHash?: string;
  headBranch: string;
  headHash?: string;
}

/**
 * 한 시점의 파일 비교 결과.
 * - `baseRef`와 `targetRef`는 실제 git 명령에서 사용할 수 있도록 해석된 ref다.
 * - `baseLabel`과 `targetLabel`은 ref 해석 과정과 무관하게 사용자에게 보여 줄 이름이다.
 * - `targetMatchesHead`는 대상 쪽 파일을 현재 작업트리 파일과 연결해 편집 가능한 비교를
 *   제공할 수 있는지 UI가 판단하는 근거다.
 */
export interface ComparisonSnapshot {
  version: 1;
  kind: ComparisonKind;
  repoRoot: string;
  baseRef: string;
  /** three-dot 비교에서 merge-base로 치환되기 전 사용자가 선택한 기준 ref */
  sourceBaseRef: string;
  targetRef: string;
  baseLabel: string;
  targetLabel: string;
  diffBase: DiffBase;
  changes: FileChange[];
  targetMatchesHead: boolean;
  /** 양쪽 ref가 로컬 object database에서 해석되어 정확한 파일 diff를 열 수 있는지 여부 */
  diffAvailable: boolean;
  /** snapshot 생성 시 실제로 해석된 왼쪽 commit hash */
  resolvedBaseHash?: string;
  /** three-dot 계산에 사용한 원래 기준 ref의 commit hash */
  resolvedSourceBaseHash?: string;
  /** snapshot 생성 시 실제로 해석된 오른쪽 commit hash */
  resolvedTargetHash?: string;
  /** snapshot 생성 시 checkout되어 있던 HEAD commit hash */
  resolvedHeadHash?: string;
  updatedAt: string;
  truncated?: boolean;
  pullRequest?: ComparisonPullRequest;
}

/** 비교 서비스의 하위 git 서비스들을 테스트나 상위 레지스트리에서 재사용하기 위한 선택 의존성 */
export interface ComparisonServiceDependencies {
  git?: GitService;
  gitLog?: GitLogService;
  remoteBranches?: RemoteBranchService;
  pullRequests?: PullRequestService;
}

/** 브랜치 ref와 별도로 사용자에게 보여 줄 비교 양쪽 이름. */
export interface ComparisonRefLabels {
  /** 실제 merge-base/hash 대신 표시할 기준 쪽 이름. */
  base?: string;
  /** 고정 commit hash 대신 표시할 대상 쪽 이름. */
  target?: string;
}

/** 비교 스냅샷 생성에 공통으로 필요한 내부 값 */
interface SnapshotInput {
  kind: ComparisonKind;
  baseRef: string;
  sourceBaseRef: string;
  targetRef: string;
  baseLabel: string;
  targetLabel: string;
  diffBase: DiffBase;
  changes: FileChange[];
  /** false로 지정하면 ref가 우연히 해석돼도 authoritative PR OID가 아니므로 diff를 막는다. */
  diffAvailable?: boolean;
  truncated?: boolean;
  pullRequest?: ComparisonPullRequest;
}

/** 저장소 한 개에 묶여 여러 비교 모드의 파일 변경 스냅샷을 만드는 서비스 */
export class ComparisonService {
  private readonly git: GitService;
  private readonly gitLog: GitLogService;
  private readonly remoteBranches: RemoteBranchService;
  private readonly pullRequests: PullRequestService;

  /**
   * 저장소 루트에 연결된 비교 서비스를 만든다.
   * - 의존성을 생략하면 각 git 서비스를 같은 저장소 루트로 생성한다.
   * - 테스트나 저장소별 서비스 레지스트리는 이미 만든 인스턴스를 주입해 캐시를 공유할 수 있다.
   * @param repoRoot 비교할 git 저장소의 절대 경로
   * @param dependencies 선택적으로 재사용할 하위 서비스 인스턴스
   */
  constructor(
    public readonly repoRoot: string,
    dependencies: ComparisonServiceDependencies = {}
  ) {
    this.git = dependencies.git ?? new GitService(repoRoot);
    this.gitLog = dependencies.gitLog ?? new GitLogService(repoRoot);
    this.remoteBranches =
      dependencies.remoteBranches ?? new RemoteBranchService(repoRoot);
    this.pullRequests =
      dependencies.pullRequests ?? new PullRequestService(repoRoot);
  }

  /**
   * GitHub Pull Request 선택기에 사용할 첫 PR 페이지를 읽는다.
   * - PullRequestService가 현재 브랜치와 해당 브랜치의 base 후보를 계산할 수 있도록 로컬
   *   브랜치 상태를 함께 제공한다.
   * - gh 실행/인증 오류는 PullRequestOverview.available=false와 error에 보존되어 UI가
   *   다른 비교 모드를 계속 제공할 수 있다.
   * @returns 저장소 식별자, 현재/대상 브랜치 추정값, PR 목록을 포함한 overview
   */
  async listPullRequests(): Promise<PullRequestOverview> {
    const localBranches = await this.localBranchesForOverview();
    return this.pullRequests.getOverview(localBranches);
  }

  /**
   * 두 git ref 사이의 파일 변경을 비교한다.
   * - 실제 diff와 numstat 파싱은 기존 GitService.listChanges에 위임해 rename 및 라인 수
   *   처리 규칙이 기존 Changes 뷰와 동일하게 유지된다.
   * @param base 기준이 되는 왼쪽 git ref
   * @param target 비교 대상인 오른쪽 git ref
   * @param diffBase 두 끝점을 직접 비교할지, 공통 조상에서 비교할지 정하는 방식
   * @param labels ref를 hash로 고정해도 UI에는 브랜치/HEAD 이름을 유지할 선택 라벨
   * @returns Explorer/에디터/Tab 장식이 함께 소비할 브랜치 비교 스냅샷
   */
  async compareRefs(
    base: string,
    target: string,
    diffBase: DiffBase,
    labels: ComparisonRefLabels = {}
  ): Promise<ComparisonSnapshot> {
    const baseRef = requiredRef(base, "base");
    const targetRef = requiredRef(target, "target");
    const [changes, effectiveBase] = await Promise.all([
      this.git.listChanges(baseRef, targetRef, diffBase),
      resolveEffectiveBaseRef(this.repoRoot, baseRef, targetRef, diffBase),
    ]);
    return this.createSnapshot({
      kind: "branches",
      baseRef: effectiveBase.ref,
      sourceBaseRef: baseRef,
      targetRef,
      baseLabel: labels.base ?? baseRef,
      targetLabel: labels.target ?? targetRef,
      diffBase,
      changes,
      diffAvailable: effectiveBase.resolved ? undefined : false,
    });
  }

  /**
   * 현재 로컬 브랜치와 설정된 upstream remote-tracking branch를 비교한다.
   * - RemoteBranchService의 현재 상태를 매번 읽으므로 checkout이나 upstream 재설정 뒤에는
   *   새 브랜치 연결을 자동으로 따른다.
   * - 기준은 upstream, 대상은 현재 로컬 브랜치로 두어 로컬 쪽이 HEAD와 같은지 명확히 한다.
   * @param diffBase 원격 tip과 로컬 tip을 직접 또는 공통 조상 기준으로 비교하는 방식
   * @returns 현재 branch/upstream 연결을 반영한 비교 스냅샷
   */
  async compareUpstream(diffBase: DiffBase): Promise<ComparisonSnapshot> {
    const state = await this.remoteBranches.getCurrentBranchRemoteState();
    if (!state.branch) {
      throw new Error("Cannot compare an upstream while HEAD is detached.");
    }
    if (state.upstreamGone) {
      throw new Error("The current branch upstream no longer exists.");
    }
    if (!state.upstream) {
      throw new Error("The current branch has no upstream.");
    }
    const [changes, effectiveBase] = await Promise.all([
      this.git.listChanges(state.upstream, state.branch, diffBase),
      resolveEffectiveBaseRef(
        this.repoRoot,
        state.upstream,
        state.branch,
        diffBase
      ),
    ]);
    return this.createSnapshot({
      kind: "localRemote",
      baseRef: effectiveBase.ref,
      sourceBaseRef: state.upstream,
      targetRef: state.branch,
      baseLabel: state.upstream,
      targetLabel: state.branch,
      diffBase,
      changes,
      diffAvailable: effectiveBase.resolved ? undefined : false,
    });
  }

  /**
   * GitHub Pull Request의 실제 changed-files 목록을 비교 스냅샷으로 만든다.
   * - 파일 목록은 댓글/patch를 요청하지 않는 전용 REST 경로를 사용한다.
   * - GitHub의 base/head 브랜치 이름을 로컬 ref 또는 head commit으로 해석해 파일 diff를
   *   열 때 기존 가상 문서 provider가 사용할 수 있는 ref를 함께 제공한다.
   * @param pr listPullRequests에서 선택한 Pull Request 정보
   * @returns PR 메타데이터와 API 잘림 여부를 포함한 비교 스냅샷
   */
  async comparePullRequest(pr: PullRequestInfo): Promise<ComparisonSnapshot> {
    assertPullRequest(pr);
    const [resolvedBaseRef, resolvedTargetRef, changedFiles] = await Promise.all([
      resolvePreviewTargetRef(this.repoRoot, pr.baseRefName),
      resolvePreviewHeadRef(this.repoRoot, pr.headRefName, pr.headHash),
      this.pullRequests.getChangedFiles(pr.number),
    ]);
    // GitHub OID가 있으면 같은 이름의 stale local branch보다 authoritative commit을 우선한다.
    const sourceBaseRef = pr.baseHash || resolvedBaseRef;
    const targetRef = pr.headHash || resolvedTargetRef;
    const authoritativeRefs = Boolean(pr.baseHash && pr.headHash);
    const effectiveBase = await resolveEffectiveBaseRef(
      this.repoRoot,
      sourceBaseRef,
      targetRef,
      "threeDot"
    );
    return this.createSnapshot({
      kind: "pullRequest",
      baseRef: effectiveBase.ref,
      sourceBaseRef,
      targetRef,
      baseLabel: pr.baseRefName,
      targetLabel: pr.headRefName,
      diffBase: "threeDot",
      changes: changedFiles.files,
      diffAvailable: authoritativeRefs && effectiveBase.resolved
        ? undefined
        : false,
      truncated: changedFiles.truncated,
      pullRequest: toSnapshotPullRequest(pr),
    });
  }

  /**
   * 저장된 비교 종류와 식별 정보를 이용해 최신 스냅샷을 다시 만든다.
   * - 브랜치 비교는 같은 ref를, local/remote 비교는 현재 checkout의 최신 upstream을 사용한다.
   * - PR 비교는 overview에서 같은 번호의 최신 메타데이터를 우선 찾고, 목록 조회가 실패하거나
   *   첫 페이지에 없으면 스냅샷에 저장한 최소 메타데이터로 파일 목록을 다시 읽는다.
   * @param snapshot 이전에 이 서비스가 만든 version 1 비교 스냅샷
   * @returns 현재 git/GitHub 상태를 반영한 새 스냅샷
   */
  async refresh(snapshot: ComparisonSnapshot): Promise<ComparisonSnapshot> {
    this.assertRefreshableSnapshot(snapshot);
    switch (snapshot.kind) {
      case "branches":
        return this.compareRefs(
          snapshot.sourceBaseRef || snapshot.baseRef,
          snapshot.targetRef,
          snapshot.diffBase,
          { base: snapshot.baseLabel, target: snapshot.targetLabel }
        );
      case "localRemote":
        return this.compareUpstream(snapshot.diffBase);
      case "pullRequest":
        return this.refreshPullRequest(snapshot);
    }
  }

  /**
   * 공통 필드를 채우고 target ref가 현재 HEAD commit과 같은지 계산한다.
   * @param input 비교 종류별 조회가 만든 ref, label, 파일 목록
   * @returns 저장소/버전/갱신 시각까지 포함한 완전한 스냅샷
   */
  private async createSnapshot(input: SnapshotInput): Promise<ComparisonSnapshot> {
    const identity = await resolveComparisonRefIdentity(
      this.repoRoot,
      input.baseRef,
      input.targetRef,
      input.sourceBaseRef
    );
    return {
      version: 1,
      kind: input.kind,
      repoRoot: this.repoRoot,
      baseRef: input.baseRef,
      sourceBaseRef: input.sourceBaseRef,
      targetRef: input.targetRef,
      baseLabel: input.baseLabel,
      targetLabel: input.targetLabel,
      diffBase: input.diffBase,
      changes: validateComparisonChanges(input.changes),
      targetMatchesHead: Boolean(
        identity.targetHash && identity.targetHash === identity.headHash
      ),
      diffAvailable:
        input.diffAvailable ??
        Boolean(identity.baseHash && identity.targetHash),
      resolvedBaseHash: identity.baseHash,
      resolvedSourceBaseHash: identity.sourceBaseHash,
      resolvedTargetHash: identity.targetHash,
      resolvedHeadHash: identity.headHash,
      updatedAt: new Date().toISOString(),
      ...(input.truncated === undefined
        ? {}
        : { truncated: input.truncated }),
      ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
    };
  }

  /**
   * PR refresh에 사용할 최신 PR 정보 또는 스냅샷 fallback을 선택한다.
   * @param snapshot pullRequest 메타데이터를 가진 이전 PR 스냅샷
   * @returns 다시 조회한 changed-files 기반 스냅샷
   */
  private async refreshPullRequest(
    snapshot: ComparisonSnapshot
  ): Promise<ComparisonSnapshot> {
    const stored = snapshot.pullRequest;
    if (!stored) {
      throw new Error("Pull request comparison metadata is missing.");
    }
    const overview = await this.listPullRequests();
    const current = overview.pullRequests.find(
      (candidate) => candidate.number === stored.number
    );
    return this.comparePullRequest(
      current ?? fromSnapshotPullRequest(stored, snapshot)
    );
  }

  /**
   * PullRequestService overview에 전달할 로컬 브랜치 목록을 읽는다.
   * - commit이 하나도 없는 새 저장소 등 조회할 수 없는 상태에서는 빈 목록으로 되돌려
   *   PullRequestService가 PR 자체는 계속 표시할 수 있게 한다.
   * @returns 현재 브랜치 표시와 target 추정에 사용할 로컬 브랜치 상태 배열
   */
  private async localBranchesForOverview(): Promise<LocalBranchStatus[]> {
    return this.gitLog.getLocalBranches().catch(() => []);
  }

  /**
   * 다른 저장소 또는 알 수 없는 버전의 스냅샷을 잘못 새로고침하지 않도록 검증한다.
   * @param snapshot 호출자가 전달한 이전 스냅샷
   */
  private assertRefreshableSnapshot(snapshot: ComparisonSnapshot): void {
    if (snapshot.version !== 1) {
      throw new Error(`Unsupported comparison snapshot version: ${snapshot.version}`);
    }
    if (snapshot.repoRoot !== this.repoRoot) {
      throw new Error("The comparison snapshot belongs to another repository.");
    }
  }
}

/**
 * 비교 파일 경로가 저장소 루트 안의 상대 경로인지 검사한다.
 * @param value git/GitHub 응답 또는 command 인자에서 받은 경로
 * @returns 절대 경로, 상위 이동(`..`), 빈 경로가 아니면 true
 */
export function isSafeComparisonPath(value: string): boolean {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return false;
  }
  return !trimmed.split(/[\\/]/).some((segment) => segment === "..");
}

/**
 * 서비스 경계를 통과하는 FileChange 경로를 검증하고 독립 복사본을 만든다.
 * @param changes git 또는 GitHub에서 정규화한 변경 목록
 * @returns 저장소 내부 경로만 가진 안전한 변경 목록
 */
function validateComparisonChanges(changes: FileChange[]): FileChange[] {
  return changes.map((change) => {
    if (
      !isSafeComparisonPath(change.path) ||
      (change.oldPath && !isSafeComparisonPath(change.oldPath))
    ) {
      throw new Error(`Unsafe comparison path: ${change.path}`);
    }
    return { ...change };
  });
}

/**
 * 비교 대상 ref가 현재 HEAD와 같은 commit을 가리키는지 확인한다.
 * - branch 이름과 HEAD 문자열이 달라도 peeled commit hash가 같으면 true다.
 * - PR head commit을 아직 fetch하지 않은 경우처럼 ref를 해석할 수 없으면 안전하게 false다.
 * @param repoRoot git 저장소 루트
 * @param targetRef 비교 오른쪽에 놓인 git ref 또는 commit hash
 * @returns target과 HEAD가 같은 commit이면 true
 */
export async function targetMatchesHead(
  repoRoot: string,
  targetRef: string
): Promise<boolean> {
  const [headHash, targetHash] = await Promise.all([
    resolveCommitHash(repoRoot, "HEAD"),
    resolveCommitHash(repoRoot, targetRef),
  ]);
  return Boolean(headHash && targetHash && headHash === targetHash);
}

/** 비교 ref와 현재 HEAD의 해석된 commit hash 묶음. */
export interface ComparisonRefIdentity {
  baseHash?: string;
  sourceBaseHash?: string;
  targetHash?: string;
  headHash?: string;
}

/**
 * 비교 ref와 HEAD가 현재 어떤 commit을 가리키는지 한 번에 읽는다.
 * - Explorer controller는 이 identity로 작업파일 변경 이벤트와 ref/checkout 변경을 구분한다.
 * @param repoRoot git 저장소 루트
 * @param baseRef 비교의 실제 왼쪽 ref
 * @param targetRef 비교의 실제 오른쪽 ref
 * @param sourceBaseRef three-dot 계산 전 사용자가 선택한 기준 ref
 * @returns 각 ref가 로컬에서 해석되면 전체 commit hash를 포함한 객체
 */
export async function resolveComparisonRefIdentity(
  repoRoot: string,
  baseRef: string,
  targetRef: string,
  sourceBaseRef = baseRef
): Promise<ComparisonRefIdentity> {
  const [baseHash, sourceBaseHash, targetHash, headHash] = await Promise.all([
    resolveCommitHash(repoRoot, baseRef),
    resolveCommitHash(repoRoot, sourceBaseRef),
    resolveCommitHash(repoRoot, targetRef),
    resolveCommitHash(repoRoot, "HEAD"),
  ]);
  return { baseHash, sourceBaseHash, targetHash, headHash };
}

/**
 * two-dot은 선택한 base tip을, three-dot은 두 ref의 merge-base를 실제 왼쪽 문서로 고른다.
 * - target이 로컬에 없는 fork PR처럼 merge-base를 계산할 수 없으면 선택 base를 보존하고,
 *   별도 diffAvailable=false가 잘못된 빈 문서 diff를 여는 일을 막는다.
 * @param repoRoot git 저장소 루트
 * @param baseRef 사용자가 선택하거나 PR이 제공한 기준 ref
 * @param targetRef 비교 대상 ref
 * @param diffBase two-dot 또는 three-dot 비교 방식
 * @returns 파일 목록 산출 기준과 일치하는 실제 왼쪽 ref
 */
async function resolveEffectiveBaseRef(
  repoRoot: string,
  baseRef: string,
  targetRef: string,
  diffBase: DiffBase
): Promise<{ ref: string; resolved: boolean }> {
  if (diffBase === "twoDot") {
    return { ref: baseRef, resolved: true };
  }
  const mergeBase = await runGit(
    ["merge-base", baseRef, targetRef],
    repoRoot
  ).catch(() => "");
  const resolved = mergeBase.trim();
  return resolved
    ? { ref: resolved, resolved: true }
    : { ref: baseRef, resolved: false };
}

/**
 * ref를 비교 가능한 전체 commit hash로 해석한다.
 * @param repoRoot git 저장소 루트
 * @param ref branch/tag/commit 형태의 git ref
 * @returns 해석된 commit hash, ref가 로컬에 없으면 undefined
 */
async function resolveCommitHash(
  repoRoot: string,
  ref: string
): Promise<string | undefined> {
  const out = await runGit(
    ["rev-parse", "--verify", `${ref}^{commit}`],
    repoRoot
  ).catch(() => "");
  return out.trim() || undefined;
}

/**
 * 사용자 선택 ref의 앞뒤 공백을 제거하고 빈 ref를 거부한다.
 * @param value 정규화할 ref 문자열
 * @param side 오류 메시지에 표시할 비교 방향
 * @returns git 명령에 전달할 비어 있지 않은 ref
 */
function requiredRef(value: string, side: "base" | "target"): string {
  const ref = value.trim();
  if (!ref) {
    throw new Error(`A ${side} ref is required for comparison.`);
  }
  return ref;
}

/**
 * PR 비교에 반드시 필요한 번호와 양쪽 branch 이름을 검증한다.
 * @param pr overview 또는 refresh fallback에서 만든 PR 정보
 */
function assertPullRequest(pr: PullRequestInfo): void {
  if (!Number.isInteger(pr.number) || pr.number <= 0) {
    throw new Error("A valid pull request number is required for comparison.");
  }
  if (!pr.baseRefName.trim() || !pr.headRefName.trim()) {
    throw new Error("Pull request base and head branches are required.");
  }
}

/**
 * 전체 PR overview 항목에서 refresh에 필요한 최소 메타데이터만 복사한다.
 * @param pr PullRequestService가 정규화한 PR 항목
 * @returns 스냅샷에 직렬화 가능한 최소 PR 정보
 */
function toSnapshotPullRequest(pr: PullRequestInfo): ComparisonPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    baseBranch: pr.baseRefName,
    baseHash: pr.baseHash,
    headBranch: pr.headRefName,
    headHash: pr.headHash,
  };
}

/**
 * 저장된 최소 PR 메타데이터를 comparePullRequest가 받는 overview 항목으로 복원한다.
 * - 표시/비교에 쓰지 않는 필드는 중립값으로 채우고, 이전 targetRef가 commit hash이면
 *   오래된 스냅샷에 headHash가 없어도 로컬 ref 해석 fallback으로 사용한다.
 * @param stored 스냅샷에 저장된 최소 PR 정보
 * @param snapshot 이전 비교의 ref와 파일 목록
 * @returns changed-files를 다시 조회할 수 있는 PullRequestInfo
 */
function fromSnapshotPullRequest(
  stored: ComparisonPullRequest,
  snapshot: ComparisonSnapshot
): PullRequestInfo {
  return {
    number: stored.number,
    title: stored.title,
    state: "",
    url: "",
    headRefName: stored.headBranch,
    headHash: stored.headHash ?? commitHashCandidate(snapshot.targetRef),
    baseRefName: stored.baseBranch,
    baseHash: stored.baseHash,
    author: "",
    isDraft: false,
    commentCount: 0,
    fileCount: snapshot.changes.length,
    commitHashes: [],
  };
}

/**
 * ref 문자열이 commit hash처럼 보일 때만 PR head fallback으로 사용한다.
 * @param value 검사할 이전 target ref
 * @returns 7~64자리 16진수 commit 후보 또는 undefined
 */
function commitHashCandidate(value: string): string | undefined {
  return /^[0-9a-f]{7,64}$/i.test(value) ? value : undefined;
}
