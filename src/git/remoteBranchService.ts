// 현재 브랜치의 upstream remote 를 웹 브랜치 URL 로 변환하는 git 서비스.
// - UI 레이어가 remote URL 형식(git@, ssh://, https://)을 직접 해석하지 않도록 분리한다.
import { runGit } from "./gitExec";

/** 현재 브랜치 upstream 을 웹에서 열기 위한 링크 정보 */
export type RemoteBranchLink =
  | { kind: "linked"; upstream: string; url: string }
  | { kind: "unsupported"; upstream: string; remoteUrl: string };

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
   * upstream 이름에서 remote 이름을 찾는다.
   * - remote 이름이 경로처럼 겹칠 수 있으므로 가장 긴 prefix 를 우선한다.
   * @param upstream 예: origin/main, upstream/feature/a
   */
  private async remoteNameFor(upstream: string): Promise<string | undefined> {
    const remotes = (await runGit(["remote"], this.repoRoot))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    return remotes.find((remote) => upstream.startsWith(`${remote}/`));
  }
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
