// GitHub PR stack 조회와 원격 토폴로지 변경을 담당하는 서비스 모듈.
// - GitHub 접근은 gh CLI, 로컬 branch/remote 접근은 공용 runGit 진입점만 사용한다.
// - 명령/UI 레이어에는 CLI 인자나 JSON 응답 형식을 노출하지 않는다.
import { runGh } from "./ghCli";
import { runGit } from "./gitExec";
import {
  buildPullRequestStacks,
  type PullRequestStacksSnapshot,
  type StackPullRequest,
} from "./pullRequestStackModel";

const FIELD_SEPARATOR = "\x1f";
const RECORD_SEPARATOR = "\x1e";

/** PR 생성 source로 선택할 수 있는 로컬 branch 정보 */
export interface PullRequestStackBranch {
  /** 로컬 branch short name */
  name: string;
  /** 현재 worktree에서 checkout 중인지 여부 */
  current: boolean;
  /** branch tip commit hash */
  hash: string;
  /** branch tip commit 제목 */
  subject: string;
  /** origin/feature 같은 upstream short name */
  upstream?: string;
  /** upstream에서 분리한 remote 이름 */
  remote?: string;
  /** GitHub PR의 head로 쓸 upstream 내부 branch 이름 */
  remoteBranch?: string;
}

/** 새 PR을 GitHub에 만들 때 필요한 입력 */
export interface CreateStackPullRequestOptions {
  /** GitHub에 이미 게시된 source branch 이름 */
  headBranch: string;
  /** 바로 아래 PR head 또는 일반 target branch */
  baseBranch: string;
  /** 새 Pull Request 제목 */
  title: string;
  /** 새 Pull Request 본문 */
  body: string;
  /** Draft로 생성할지 여부 */
  draft: boolean;
}

/** gh CLI의 `pr list --json` 한 항목 중 사용하는 필드 */
interface GhStackPullRequest {
  number?: number;
  title?: string;
  url?: string;
  headRefName?: string;
  baseRefName?: string;
  isCrossRepository?: boolean;
  headRepositoryOwner?: { login?: string };
  author?: { login?: string };
  isDraft?: boolean;
  reviewDecision?: string;
  mergeStateStatus?: string;
  updatedAt?: string;
}

/** gh CLI의 저장소 기본 branch 응답 */
interface GhRepositoryInfo {
  nameWithOwner?: string;
  defaultBranchRef?: { name?: string };
}

/** GitHub PR stack 관련 외부 상태를 읽고 변경하는 서비스 */
export class PullRequestStackService {
  constructor(public readonly repoRoot: string) {}

  /**
   * 현재 저장소의 열린 PR 전체를 읽고 base/head 관계로 스택을 구성한다.
   * @returns 저장소 식별자, 기본 branch, 원본 PR, 계산된 stack을 포함한 스냅샷
   */
  async getSnapshot(): Promise<PullRequestStacksSnapshot> {
    const [repository, pullRequests] = await Promise.all([
      this.repositoryInfo(),
      this.listOpenPullRequests(),
    ]);
    return {
      repository: repository.nameWithOwner || "",
      defaultBranch: repository.defaultBranchRef?.name,
      pullRequests,
      stacks: buildPullRequestStacks(pullRequests),
    };
  }

  /**
   * 선택한 PR이 대상으로 삼는 base branch를 바꿔 스택의 부모 관계를 재연결한다.
   * @param number 변경할 GitHub Pull Request 번호
   * @param baseBranch 새 base branch short name
   */
  async changeBase(number: number, baseBranch: string): Promise<void> {
    const branch = requiredBranch(baseBranch, "Base branch is required.");
    await runGh(["pr", "edit", String(number), "--base", branch], this.repoRoot);
  }

  /**
   * 이미 원격에 게시된 head branch로 새 Pull Request를 만든다.
   * @param options head/base/title/body/draft 생성 옵션
   * @returns gh가 출력한 새 Pull Request URL
   */
  async createPullRequest(options: CreateStackPullRequestOptions): Promise<string> {
    const head = requiredBranch(options.headBranch, "Head branch is required.");
    const base = requiredBranch(options.baseBranch, "Base branch is required.");
    const title = options.title.trim();
    if (!title) {
      throw new Error("Pull request title is required.");
    }
    const args = [
      "pr",
      "create",
      "--head",
      head,
      "--base",
      base,
      "--title",
      title,
      "--body",
      options.body,
    ];
    if (options.draft) {
      args.push("--draft");
    }
    return (await runGh(args, this.repoRoot)).trim();
  }

  /**
   * PR source로 선택할 로컬 branch와 upstream 게시 상태를 읽는다.
   * @returns 현재 branch 우선, 이후 이름순으로 정렬된 로컬 branch 목록
   */
  async listLocalBranches(): Promise<PullRequestStackBranch[]> {
    const remotes = await this.listRemotes();
    const format = [
      "%(HEAD)",
      "%(refname:short)",
      "%(upstream:short)",
      "%(objectname)",
      "%(subject)",
    ].join(FIELD_SEPARATOR) + RECORD_SEPARATOR;
    const out = await runGit(
      ["for-each-ref", `--format=${format}`, "refs/heads"],
      this.repoRoot
    );
    return out
      .split(RECORD_SEPARATOR)
      .map((record) => record.replace(/^\r?\n|\r?\n$/g, ""))
      .filter(Boolean)
      .map((record) => this.parseLocalBranch(record, remotes))
      .sort((left, right) => Number(right.current) - Number(left.current)
        || left.name.localeCompare(right.name));
  }

  /**
   * 저장소에 등록된 remote 이름을 반환한다.
   * @returns origin을 먼저 두고 나머지를 이름순으로 정렬한 remote 목록
   */
  async listRemotes(): Promise<string[]> {
    const out = await runGit(["remote"], this.repoRoot);
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort((left, right) => Number(right === "origin") - Number(left === "origin")
        || left.localeCompare(right));
  }

  /**
   * 로컬 branch를 지정한 remote branch로 게시하고 upstream을 연결한다.
   * - checkout을 바꾸지 않고 명시 refspec을 사용하므로 다른 worktree가 점유한 branch도 게시할 수 있다.
   * - 기존 upstream이 있더라도 PR 생성 직전에 일반 push를 수행해 로컬 commit 누락을 막는다.
   *   remote가 앞서거나 분기됐다면 force하지 않고 git push 실패를 그대로 돌려준다.
   * @param localBranch 게시할 로컬 branch short name
   * @param remote push 대상 remote 이름
   * @param remoteBranch remote에서 사용할 branch 이름. 생략하면 로컬 이름을 사용한다.
   * @returns GitHub PR head로 사용할 remote branch 이름
   */
  async publishBranch(
    localBranch: string,
    remote: string,
    remoteBranch = localBranch
  ): Promise<string> {
    const branch = requiredBranch(localBranch, "Local branch is required.");
    const target = requiredBranch(remoteBranch, "Remote branch is required.");
    const remotes = await this.listRemotes();
    if (!remotes.includes(remote)) {
      throw new Error(`Git remote '${remote}' is not available.`);
    }
    await runGit(["show-ref", "--verify", `refs/heads/${branch}`], this.repoRoot);
    await runGit(
      ["push", "-u", remote, `${branch}:refs/heads/${target}`],
      this.repoRoot
    );
    return target;
  }

  /**
   * 열린 Pull Request 목록을 가벼운 gh JSON 필드만 사용해 읽는다.
   * @returns stack 계산에 필요한 필드로 정규화한 열린 PR 배열
   */
  private async listOpenPullRequests(): Promise<StackPullRequest[]> {
    const fields = [
      "number",
      "title",
      "url",
      "headRefName",
      "baseRefName",
      "isCrossRepository",
      "headRepositoryOwner",
      "author",
      "isDraft",
      "reviewDecision",
      "mergeStateStatus",
      "updatedAt",
    ].join(",");
    const out = await runGh(
      ["pr", "list", "--state", "open", "--limit", "1000", "--json", fields],
      this.repoRoot
    );
    const parsed = JSON.parse(out) as GhStackPullRequest[];
    return parsed.map(normalizePullRequest);
  }

  /**
   * gh repo view로 owner/name과 기본 branch를 한 번에 읽는다.
   * @returns GitHub 저장소 표시와 root base 후보에 사용할 정보
   */
  private async repositoryInfo(): Promise<GhRepositoryInfo> {
    const out = await runGh(
      ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
      this.repoRoot
    );
    return JSON.parse(out) as GhRepositoryInfo;
  }

  /**
   * for-each-ref 한 레코드를 로컬 branch와 remote 게시 정보로 변환한다.
   * @param record FIELD_SEPARATOR로 나뉜 git 출력 레코드
   * @param remotes 현재 저장소 remote 이름 목록
   * @returns PR source QuickPick에서 사용할 branch 정보
   */
  private parseLocalBranch(
    record: string,
    remotes: string[]
  ): PullRequestStackBranch {
    const [head, name, upstream, hash, subject] = record.split(FIELD_SEPARATOR);
    const published = splitRemoteBranch(upstream || "", remotes);
    return {
      name,
      current: head.trim() === "*",
      hash,
      subject,
      upstream: upstream || undefined,
      remote: published?.remote,
      remoteBranch: published?.branch,
    };
  }
}

/**
 * gh PR JSON 한 항목을 내부 StackPullRequest로 정규화한다.
 * @param pr gh가 반환한 느슨한 JSON 객체
 * @returns 누락 문자열을 빈 값으로 보정한 PR 정보
 */
function normalizePullRequest(pr: GhStackPullRequest): StackPullRequest {
  return {
    number: Number(pr.number) || 0,
    title: pr.title || "",
    url: pr.url || "",
    headRefName: pr.headRefName || "",
    baseRefName: pr.baseRefName || "",
    isCrossRepository: Boolean(pr.isCrossRepository),
    headRepositoryOwner: pr.headRepositoryOwner?.login || undefined,
    author: pr.author?.login || "",
    isDraft: Boolean(pr.isDraft),
    reviewDecision: pr.reviewDecision || undefined,
    mergeStateStatus: pr.mergeStateStatus || undefined,
    updatedAt: pr.updatedAt || undefined,
  };
}

/**
 * remote/branch short name을 등록된 remote 기준으로 안전하게 나눈다.
 * @param upstream origin/feature 같은 upstream 이름
 * @param remotes 저장소에 등록된 remote 이름
 * @returns remote와 내부 branch 이름, 해석할 수 없으면 undefined
 */
function splitRemoteBranch(
  upstream: string,
  remotes: string[]
): { remote: string; branch: string } | undefined {
  const remote = [...remotes]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => upstream.startsWith(`${candidate}/`));
  if (!remote || upstream.length <= remote.length + 1) {
    return undefined;
  }
  return { remote, branch: upstream.slice(remote.length + 1) };
}

/**
 * 사용자/호출부가 넘긴 branch 이름을 trim하고 필수값을 검사한다.
 * @param value 검사할 branch 문자열
 * @param message 빈 값일 때 표시할 오류 문구
 * @returns 앞뒤 공백이 제거된 branch 이름
 */
function requiredBranch(value: string, message: string): string {
  const branch = value.trim();
  if (!branch) {
    throw new Error(message);
  }
  return branch;
}
