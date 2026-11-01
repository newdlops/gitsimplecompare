// Git이 선택한 현재 branch의 PR head를 GitHub 조회와 분리해 해석한다.
import { runGit, GitError } from "./gitExec";
import { readGitConfigSnapshot } from "./gitConfigSnapshot";
import { isGitLifecycleError } from "./gitError";
import type { PullRequestBranchSelector } from "./pullRequestBranchLookup";

/** 테스트는 읽기 전용 Git 경계만 대체하고 실제 설정 해석은 그대로 검증한다. */
export type BranchSelectorGit = typeof runGit;

/**
 * gh가 현재 branch에서 찾는 PR head를 native push 해석과 명시 설정 우선순위로 결정한다.
 * @param root Git 루트, branch 이미 캡처한 현재 이름, signal 취소, runner Git 경계, env 고정한 부모 환경
 * @returns PR-ref 번호 또는 head/remote identity. Git 설정·원격 주소 원문은 로그에 남기지 않는다.
 */
export async function resolveCurrentPullRequestSelector(root: string, branch: string, signal?: AbortSignal,
  runner: BranchSelectorGit = runGit, env?: Record<string, string>): Promise<PullRequestBranchSelector> {
  signal?.throwIfAborted();
  if (!branch || /[\r\n\0]/.test(branch)) throw selectorError();
  const options = { signal, ...(env ? { env, inheritEnv: false } : {}) };
  const [config, pushed] = await Promise.all([
    readGitConfigSnapshot(root, "^(branch\\..*\\.(remote|pushremote|merge)|remote\\..*\\.(url|pushurl)|remote\\.pushdefault|push\\.default)$", options, runner),
    runner(["for-each-ref", "--format=%(refname)%00%(push:remotename)%00%(push:remoteref)", `refs/heads/${branch}`], root, options)
      .catch(error => { signal?.throwIfAborted(); if (isGitLifecycleError(error) || !(error instanceof GitError)) throw error; return ""; }),
  ]);
  signal?.throwIfAborted();
  const prefix = `branch.${branch}.`, merge = config.get(prefix + "merge") ?? "";
  const pr = /^refs\/pull\/([1-9]\d*)\/head$/.exec(merge);
  if (pr) return { key: branch, number: Number(pr[1]) };
  const row = pushed.split(/\r?\n/).map(line => line.split("\0")).find(parts => parts[0] === `refs/heads/${branch}`);
  let remote = row?.[1], head = row?.[2]?.replace(/^refs\/heads\//, "");
  if (!remote || !head) {
    head = ["upstream", "tracking"].includes(config.get("push.default") ?? "") && merge ? merge.replace(/^refs\/heads\//, "") : branch;
    remote = config.get(prefix + "pushRemote") || config.get("remote.pushDefault") || config.get(prefix + "remote");
  }
  if (!remote) return { key: branch, headRefName: head };
  const source = /^(?:[a-z][a-z0-9+.-]*:\/\/|[^@\s]+@[^:\s]+:)/i.test(remote)
    ? remote : (await runner(["remote", "get-url", remote], root, options)).trim();
  const repository = repositoryIdentity(source);
  if (!repository) throw selectorError();
  return { key: branch, headRefName: head, headRepository: repository };
}

/** HTTPS/SSH/SCP 표기의 host와 owner/name만 반환하며 URL에 있는 인증 값은 버린다. */
function repositoryIdentity(source: string): PullRequestBranchSelector["headRepository"] {
  try {
    const scp = /^[^@\s]+@([^:\s]+):(.+)$/.exec(source);
    const url = scp ? undefined : new URL(source);
    const host = scp?.[1] ?? url!.host, path = (scp?.[2] ?? url!.pathname).replace(/^\//, "").replace(/\.git\/?$/i, "").replace(/\/$/, "");
    const [owner, name, extra] = path.split("/");
    if (!host || !owner || !name || extra !== undefined || /[\r\n\0]/.test(host + owner + name)) return undefined;
    return { host, owner, name };
  } catch { return undefined; }
}

/** 불완전한 local selector를 다른 PR로 조용히 대체하지 않는 안전 오류다. */
function selectorError(): Error { return new Error("Cannot resolve the current pull request branch. Refresh and try again."); }
