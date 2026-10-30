// Graph 이동·커밋 상세에 필요한 PR 식별자와 누락 객체만 준비한다. 전체 PR 목록·댓글·파일은 조회하지 않는다.
import { GitError, runGit } from "./gitExec";
import { fetchPullRequestRefs } from "./pullRequestRefLookup";
import { readGitHubInteractive } from "./githubReadCache";
import type { PullRequestInfo } from "./pullRequestInfo";
import { logInfo } from "../ui/outputLog";
import { PULL_REQUEST_GRAPH_FETCH_OPTIONS } from "./pullRequestGraphFetch";
import { findLocalCommitCandidates } from "./gitLogWindow";

/**
 * merge 결과·head·마지막 PR commit 순서로 이동 후보를 만든다.
 * @param pr 목록 또는 단건 조회에서 확인한 PR @returns 중복과 빈 값을 제거한 OID 목록
 */
export function pullRequestGraphHashes(pr: PullRequestInfo): string[] {
  return [...new Set([pr.mergeHash || "", pr.headHash || "", ...pr.commitHashes.slice().reverse()].filter(isOid))];
}

/**
 * 가벼운 첫 목록에 OID가 없으면 클릭한 PR 한 건의 ref만 취소 가능한 우선 조회로 읽는다.
 * @param refresh 누락 객체를 가져오기 전에 원격에서 움직인 head도 다시 확인할지 여부
 * @returns 이동 가능한 최신 PR. API가 다른 PR을 반환하거나 취소되면 실패한다.
 */
export async function resolvePullRequestGraphTarget(root: string, pr: PullRequestInfo, signal?: AbortSignal,
  refresh = false): Promise<PullRequestInfo> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0) throw new Error("Invalid pull request number.");
  if (!refresh && isOid(pr.headHash) && (pr.state !== "MERGED" || isOid(pr.mergeHash))) return pr;
  const latest = await fetchPullRequestRefs(root, pr.number,
    (args, cwd, options) => readGitHubInteractive(args, cwd, { ...options, signal }));
  signal?.throwIfAborted();
  if (!latest || latest.number !== pr.number || !isOid(latest.headHash)) throw new Error("Pull request refs are unavailable.");
  logInfo("graph pull request jump refs resolved", { repoRoot: root, number: pr.number });
  return latest;
}

/**
 * 선택한 PR 커밋의 내용을 Graph 페이지·브랜치 필터와 무관하게 읽을 수 있도록 객체만 준비한다.
 * @param root 현재 저장소, pr host가 조회해 둔 PR 또는 목록 갱신으로 사라진 PR 번호, hash 정확한 커밋 OID
 * @param signal 상세 선택·창 수명에 연결한 취소 신호
 * @returns 로컬 객체가 있으면 즉시 완료한다. 없으면 PR head 또는 선택한 머지 결과만 가져와 정확한 OID를 재확인한다.
 */
export async function preparePullRequestCommit(root: string, pr: PullRequestInfo | number, hash: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!isOid(hash)) throw new Error("Invalid pull request commit OID.");
  const number = typeof pr === "number" ? pr : pr.number;
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Invalid pull request number.");
  logInfo("graph pull request commit preparing", { repoRoot: root, number, hash });
  const available = async () => (await findLocalCommitCandidates(root, [hash], signal)).length > 0;
  if (await available()) {
    logInfo("graph pull request commit object ready", { repoRoot: root, number, hash, source: "local" });
    return;
  }
  const latest = typeof pr === "number" ? await fetchPullRequestRefs(root, number,
    (args, cwd, options) => readGitHubInteractive(args, cwd, { ...options, signal }))
    : await resolvePullRequestGraphTarget(root, pr, signal, true);
  signal?.throwIfAborted();
  if (!latest || latest.number !== number || !isOid(latest.headHash)) throw new Error("Pull request refs are unavailable.");
  await fetchPullRequestGraphObjects(root, latest, signal, { preferHead: hash.toLowerCase() !== latest.mergeHash?.toLowerCase() });
  signal?.throwIfAborted();
  if (!await available()) throw new Error("The selected pull request commit is unavailable. Refresh pull requests and try again.");
  logInfo("graph pull request commit object ready", { repoRoot: root, number, hash, source: "fetched" });
}

/**
 * 일반 fetch에 포함되지 않는 PR의 객체만 가져온다. named ref·FETCH_HEAD·작업트리·index는 갱신하지 않는다.
 * @param root 저장소 루트 @param pr 단건 조회로 확인한 PR URL/OID @param signal Graph 이동 수명
 * @param options preferHead면 개별 PR commit의 위쪽 이력도 탐색하도록 원본 PR head를 먼저 가져온다.
 * @returns 객체 전송이 끝나면 완료한다. 취소 또는 30초 제한 뒤에는 후속 조회를 시작하지 않는다.
 */
export async function fetchPullRequestGraphObjects(root: string, pr: PullRequestInfo, signal?: AbortSignal,
  options: { preferHead?: boolean } = {}): Promise<void> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0) throw new Error("Invalid pull request number.");
  const remote = await matchingRemote(root, pr.url, signal);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, 30_000);
  timer.unref();
  try {
    const merge = pr.state === "MERGED" && isOid(pr.mergeHash) ? pr.mergeHash : undefined;
    const head = `refs/pull/${pr.number}/head`;
    const sources = [...new Set((options.preferHead ? [head, merge] : [merge, head]).filter((source): source is string => !!source))];
    for (let index = 0; index < sources.length; index++) {
      controller.signal.throwIfAborted();
      try {
        await runGit(["fetch", ...PULL_REQUEST_GRAPH_FETCH_OPTIONS, remote, sources[index]], root,
        { signal: controller.signal, retryOnLock: false, env: { GIT_TERMINAL_PROMPT: "0" } });
        controller.signal.throwIfAborted();
        logInfo("graph pull request jump objects fetched", { repoRoot: root, number: pr.number });
        return;
      } catch (error) {
        controller.signal.throwIfAborted();
        if (index === sources.length - 1) throw error;
      }
    }
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}

/** GitHub 입력이 refspec이나 옵션으로 해석되지 않도록 전체 SHA-1/SHA-256 commit OID만 허용한다. */
function isOid(value: unknown): value is string { return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value); }

/** PR가 속한 저장소와 host/path가 같은 remote만 선택한다. fork의 origin으로 임의 fallback하지 않는다. */
async function matchingRemote(root: string, prUrl: string, signal?: AbortSignal): Promise<string> {
  const target = repositoryIdentity(prUrl, true);
  if (!target) throw new Error("Pull request repository is unavailable.");
  let output: string;
  try { output = await runGit(["config", "--null", "--get-regexp", "^remote\\..*\\.url$"], root, { signal }); }
  catch (error) { if (!(error instanceof GitError && error.code === 1)) throw error; output = ""; }
  const remotes = output.split("\0").flatMap(record => {
    const split = record.indexOf("\n"), key = record.slice(0, split);
    if (split < 0 || !key.startsWith("remote.") || !key.endsWith(".url")) return [];
    const name = key.slice(7, -4);
    return name && !name.startsWith("-") && repositoryIdentity(record.slice(split + 1)) === target ? [name] : [];
  });
  const remote = remotes.includes("origin") ? "origin" : remotes.sort()[0];
  if (!remote) throw new Error("No Git remote matches the pull request repository.");
  return remote;
}

/** HTTPS/SSH/SCP URL에서 자격 증명을 제외한 host·owner/repo를 정규화한다. PR URL은 /pull/번호도 검증한다. */
function repositoryIdentity(raw: string, pullRequest = false): string | undefined {
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(raw);
  try {
    const url = new URL(scp && !raw.includes("://") ? `ssh://${scp[1]}/${scp[2]}` : raw);
    if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol)) return undefined;
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length !== (pullRequest ? 4 : 2) || pullRequest && (parts[2] !== "pull" || !/^\d+$/.test(parts[3]))) return undefined;
    return `${url.hostname}/${parts[0]}/${parts[1].replace(/\.git$/i, "")}`.toLowerCase();
  } catch { return undefined; }
}
