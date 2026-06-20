// 현재 브랜치의 upstream remote 를 웹 브랜치 URL 로 변환하는 git 서비스.
// - UI 레이어가 remote URL 형식(git@, ssh://, https://)을 직접 해석하지 않도록 분리한다.
import { runGit } from "./gitExec";

/** 현재 브랜치 upstream 을 웹에서 열기 위한 링크 정보 */
export type RemoteBranchLink =
  | { kind: "linked"; upstream: string; url: string }
  | { kind: "unsupported"; upstream: string; remoteUrl: string };

/** 원격 tracking branch 한 개의 이름과 분해된 remote/branch 값 */
export interface RemoteTrackingBranch {
  name: string;
  remote: string;
  branch: string;
}

/** 현재 로컬 브랜치가 원격 브랜치와 연결된 상태 */
export interface CurrentRemoteBranchState {
  branch?: string;
  upstream?: string;
  upstreamGone: boolean;
  remotes: string[];
  remoteBranches: RemoteTrackingBranch[];
}

/** 원격 브랜치를 upstream 으로 설정한 결과 */
export interface RemoteBranchSetupResult {
  branch: string;
  upstream: string;
  remote: string;
  remoteBranch: string;
}

/** 현재 로컬 브랜치의 upstream 설정을 해제한 결과 */
export interface RemoteBranchUnsetResult {
  branch: string;
  upstream?: string;
}

/** 저장소 한 개의 remote branch 웹 URL 계산 서비스 */
export class RemoteBranchService {
  constructor(private readonly repoRoot: string) {}

  /**
   * 현재 브랜치가 추적하는 upstream remote branch 의 웹 URL 을 만든다.
   * - upstream 이 없으면 undefined 를 반환한다.
   * - remote URL 을 웹 URL 로 해석할 수 없으면 unsupported 를 반환해 UI 가 안내하게 한다.
   */
  async getCurrentBranchLink(): Promise<RemoteBranchLink | undefined> {
    const upstream = (await runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      this.repoRoot
    ).catch(() => "")).trim();
    if (!upstream) {
      return undefined;
    }

    const remote = await this.remoteNameFor(upstream);
    if (!remote) {
      return undefined;
    }
    const branch = upstream.slice(remote.length + 1);
    const remoteUrl = (await runGit(
      ["config", "--get", `remote.${remote}.url`],
      this.repoRoot
    )).trim();
    const webBase = remoteWebBase(remoteUrl);
    if (!webBase) {
      return { kind: "unsupported", upstream, remoteUrl };
    }
    return {
      kind: "linked",
      upstream,
      url: `${webBase}${branchPathSegment(webBase)}${encodeBranch(branch)}`,
    };
  }

  /**
   * 현재 로컬 브랜치의 원격 연결 상태와 선택 가능한 remote branch 목록을 읽는다.
   * - UI 는 이 결과만 보고 "기존 upstream 지정" 또는 "push 로 생성" 흐름을 결정한다.
   */
  async getCurrentBranchRemoteState(): Promise<CurrentRemoteBranchState> {
    const branch = await optionalGit(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      this.repoRoot
    );
    const remotes = await this.listRemotes();
    if (!branch) {
      return {
        remotes,
        upstreamGone: false,
        remoteBranches: await this.listRemoteBranches(remotes),
      };
    }
    const [upstream, track, remoteBranches] = await Promise.all([
      optionalGit(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        this.repoRoot
      ),
      optionalGit(
        [
          "for-each-ref",
          "--format=%(upstream:track)",
          `refs/heads/${branch}`,
        ],
        this.repoRoot
      ),
      this.listRemoteBranches(remotes),
    ]);
    return {
      branch,
      upstream,
      upstreamGone: /\[gone\]/i.test(track ?? ""),
      remotes,
      remoteBranches,
    };
  }

  /**
   * 현재 로컬 브랜치가 기존 remote tracking branch 를 upstream 으로 추적하게 설정한다.
   * @param upstream `origin/main` 같은 remote tracking branch short name
   */
  async setCurrentBranchUpstream(
    upstream: string
  ): Promise<RemoteBranchSetupResult> {
    const state = await this.getCurrentBranchRemoteState();
    if (!state.branch) {
      throw new Error("Cannot set a remote branch while HEAD is detached.");
    }
    const parsed = splitRemoteBranchName(upstream, state.remotes);
    if (!parsed) {
      throw new Error(`Invalid remote branch: ${upstream}`);
    }
    await runGit(
      ["branch", "--set-upstream-to", upstream, state.branch],
      this.repoRoot
    );
    return {
      branch: state.branch,
      upstream,
      remote: parsed.remote,
      remoteBranch: parsed.branch,
    };
  }

  /**
   * 현재 로컬 브랜치를 지정 remote 로 push 하면서 upstream 으로 설정한다.
   * - remote branch 가 아직 없으면 git push 가 생성한다.
   * @param remote 원격 저장소 이름
   * @param remoteBranch 만들거나 갱신할 원격 브랜치 이름
   */
  async pushCurrentBranchToRemote(
    remote: string,
    remoteBranch: string
  ): Promise<RemoteBranchSetupResult> {
    const targetBranch = remoteBranch.trim();
    const state = await this.getCurrentBranchRemoteState();
    if (!state.branch) {
      throw new Error("Cannot set a remote branch while HEAD is detached.");
    }
    if (!state.remotes.includes(remote)) {
      throw new Error(`No git remote found: ${remote}`);
    }
    await this.assertValidRemoteBranchName(targetBranch);
    await runGit(
      ["push", "-u", remote, `HEAD:refs/heads/${targetBranch}`],
      this.repoRoot
    );
    return {
      branch: state.branch,
      upstream: `${remote}/${targetBranch}`,
      remote,
      remoteBranch: targetBranch,
    };
  }

  /**
   * 현재 로컬 브랜치의 upstream 연결만 제거한다.
   * - 로컬 브랜치와 원격 브랜치는 삭제하지 않고, branch.*.remote/merge 추적 설정만 제거한다.
   * @returns 해제된 로컬 브랜치와 이전 upstream 정보
   */
  async unsetCurrentBranchUpstream(): Promise<RemoteBranchUnsetResult> {
    const state = await this.getCurrentBranchRemoteState();
    if (!state.branch) {
      throw new Error("Cannot set a remote branch while HEAD is detached.");
    }
    if (!state.upstream) {
      throw new Error("No remote branch is connected to the current branch.");
    }
    await runGit(["branch", "--unset-upstream", state.branch], this.repoRoot);
    return {
      branch: state.branch,
      upstream: state.upstream,
    };
  }

  /**
   * git 이 허용하는 remote branch short name 인지 확인한다.
   * - push refspec 의 `refs/heads/<name>` 뒤에 붙일 이름이므로 remote prefix 없는 branch 이름만 받는다.
   * @param remoteBranch 검사할 원격 브랜치 내부 이름(예: feature/a)
   */
  async assertValidRemoteBranchName(remoteBranch: string): Promise<void> {
    const name = remoteBranch.trim();
    if (!name) {
      throw new Error("Remote branch name is required.");
    }
    await runGit(["check-ref-format", "--branch", name], this.repoRoot);
  }

  /**
   * upstream 이름에서 remote 이름을 찾는다.
   * - remote 이름이 경로처럼 겹칠 수 있으므로 가장 긴 prefix 를 우선한다.
   * @param upstream 예: origin/main, upstream/feature/a
   */
  private async remoteNameFor(upstream: string): Promise<string | undefined> {
    const remotes = (await this.listRemotes()).sort((a, b) => b.length - a.length);
    return remotes.find((remote) => upstream.startsWith(`${remote}/`));
  }

  /**
   * 저장소에 등록된 remote 이름 목록을 반환한다.
   * - remote 가 없는 저장소도 정상 상태이므로 빈 배열로 반환한다.
   */
  private async listRemotes(): Promise<string[]> {
    const out = await optionalGit(["remote"], this.repoRoot);
    return (out ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * refs/remotes 아래의 remote tracking branch 목록을 반환한다.
   * - `origin/HEAD` 같은 symbolic 기본 ref 는 사용자가 upstream 으로 고를 수 없으므로 제외한다.
   * @param remotes 현재 등록된 remote 이름 목록
   */
  private async listRemoteBranches(
    remotes: string[]
  ): Promise<RemoteTrackingBranch[]> {
    const out = await optionalGit(
      ["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
      this.repoRoot
    );
    return (out ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => name && !name.endsWith("/HEAD"))
      .flatMap((name) => {
        const parsed = splitRemoteBranchName(name, remotes);
        return parsed ? [{ name, ...parsed }] : [];
      });
  }
}

/**
 * remote/branch 형태의 remote tracking branch 이름을 분해한다.
 * @param name `origin/main` 같은 short name
 * @param remotes 현재 저장소 remote 이름 목록
 */
function splitRemoteBranchName(
  name: string,
  remotes: string[]
): { remote: string; branch: string } | undefined {
  const remote = [...remotes]
    .sort((a, b) => b.length - a.length)
    .find((candidate) => name.startsWith(`${candidate}/`));
  if (!remote || name.length <= remote.length + 1) {
    return undefined;
  }
  return { remote, branch: name.slice(remote.length + 1) };
}

/**
 * 실패할 수 있는 git 조회 명령을 선택적으로 실행한다.
 * @param args git 인자 배열
 * @param repoRoot git 저장소 루트
 */
async function optionalGit(
  args: string[],
  repoRoot: string
): Promise<string | undefined> {
  const out = await runGit(args, repoRoot).catch(() => undefined);
  const text = out?.trim();
  return text ? text : undefined;
}

/**
 * git remote URL 을 브라우저에서 열 수 있는 저장소 URL 로 변환한다.
 * @param raw git remote URL
 */
function remoteWebBase(raw: string): string | undefined {
  const normalized = raw.trim().replace(/\/$/, "");
  const scp = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(normalized);
  if (scp && !normalized.includes("://")) {
    return `https://${scp[1]}/${stripGitSuffix(scp[2])}`;
  }
  try {
    const url = new URL(normalized);
    if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol)) {
      return undefined;
    }
    const path = stripGitSuffix(url.pathname.replace(/^\/+/, ""));
    return `https://${url.host}/${path}`;
  } catch {
    return undefined;
  }
}

/** 저장소 경로 끝의 .git suffix 를 제거한다. */
function stripGitSuffix(path: string): string {
  return path.replace(/\.git$/i, "");
}

/** hosting 서비스별 branch page 경로 prefix 를 선택한다. */
function branchPathSegment(webBase: string): string {
  const host = new URL(webBase).host.toLowerCase();
  if (host.includes("gitlab")) {
    return "/-/tree/";
  }
  if (host.includes("bitbucket")) {
    return "/branch/";
  }
  return "/tree/";
}

/** 브랜치 이름을 URL 경로 세그먼트로 안전하게 인코딩한다. */
function encodeBranch(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}
