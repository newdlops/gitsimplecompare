// push 계획의 HEAD·upstream commit을 한 native 조회로 읽고, 모호한 경우 기존 checkout 검증에 맡긴다.
import { realpath } from "node:fs/promises";
import { GitError, runGit } from "./gitExec";
import { readGitCommitCheckoutIdentity, type GitCheckoutIdentity } from "./repositoryIdentity";
import { rememberGitOperationDirectory } from "./gitStatePathScope";
import { logInfo } from "../ui/outputLog";

const OID = "([a-f0-9]{40}|[a-f0-9]{64})";
const prefix = new RegExp(`^${OID}(\\r?\\n)${OID}\\2(HEAD|refs/heads/[^\\r\\n]+)\\2`);
const commitPair = new RegExp(`^${OID}(\\r?\\n)${OID}\\2`);

/**
 * 같은 Git 프로세스에서 source commit, upstream commit, symbolic HEAD, metadata 위치를 고정한다.
 * - 길이를 알 수 있는 세 필드를 앞에 두어 Git directory 안의 줄바꿈·끝 공백을 그대로 보존한다.
 * - upstream 부재·손상이나 HEAD 이름 충돌은 기존 checkout 조회로 돌아간다. timeout은 재시도하지 않는다.
 * @param repoRoot push 계획을 만들 저장소 또는 linked worktree 루트
 * @returns 검증한 checkout과 commit으로 해석된 upstream 힌트. ref/OID 일치는 호출부가 새 metadata로 확인한다.
 */
export async function readPushCheckoutIdentity(repoRoot: string): Promise<{ checkout: GitCheckoutIdentity; upstreamCommit?: string }> {
  let output: string;
  try {
    output = await runGit(["rev-parse", "--revs-only", "HEAD^{commit}", "@{upstream}^{commit}",
      "--symbolic-full-name", "HEAD", "--absolute-git-dir"], repoRoot);
  } catch (error) {
    if (!(error instanceof GitError) || (error.code !== 1 && error.code !== 128)) throw error;
    output = error.stdout;
  }
  const record = prefix.exec(output);
  if (record) {
    const rawDirectory = output.slice(record[0].length), ending = record[2];
    const directory = rawDirectory.endsWith(ending) ? rawDirectory.slice(0, -ending.length) : "";
    if (directory) {
      const gitDir = await realpath(directory), branchRef = record[4] === "HEAD" ? "" : record[4];
      await rememberGitOperationDirectory(repoRoot, gitDir);
      return { checkout: { gitDir, head: record[1], branchRef, branch: branchRef.slice("refs/heads/".length) },
        upstreamCommit: record[3] };
    }
  }
  logInfo("push checkout identity fallback", { repoRoot, reason: "missingUpstreamOrAmbiguousCheckout" });
  const checkout = await readGitCommitCheckoutIdentity(repoRoot), pair = commitPair.exec(output);
  return { checkout, upstreamCommit: pair?.[1] === checkout.head ? pair[3] : undefined };
}
