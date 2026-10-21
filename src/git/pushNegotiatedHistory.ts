// 결측 promisor metadata가 있을 때만 실제 push 서버와 객체 없는 협상을 한 번 시도한다.
import { GitError, type RunGitOptions } from "./gitExec";
import { isGitLifecycleError } from "./gitError";
import { readGitConfigSnapshot } from "./gitConfigSnapshot";
import { fetchNegotiationCommand } from "./gitFetchNegotiation";
import { MAX_PUBLISHED_TIPS, verifyLocalPublishedCommits } from "./pushPublishedHistory";
import type { PushGitRunner } from "./sequentialPush";
import { logInfo } from "../ui/outputLog";

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/**
 * 원격 tip을 아직 받지 않은 partial clone의 공유 base를 Native ACK로 확인한다.
 * @param root 저장소 @param url 실제 단일 push URL @param head 승인한 원본 OID
 * @param excluded 기존 제외 tip @param runner 공통 Git 실행 경계 @param options 원본 DAG와 취소 정책
 * @returns promisor가 아니면 false. 지원되지 않는 협상은 base 없이 기존 추정으로 돌아간다.
 */
export async function readNegotiatedPushBase(root: string, url: string, head: string, excluded: readonly string[],
  runner: PushGitRunner, options: RunGitOptions): Promise<{ promisor: boolean; base?: string }> {
  // Git이 지원하는 숫자·빈 값 등 모든 boolean 표기를 Native 정규화로 처리한다.
  const config = await readGitConfigSnapshot(root, "^remote\\..*\\.promisor$", options,
    (args, directory) => runner.run([args[0], "--type=bool", ...args.slice(1)], directory, options));
  const promisor = config.keys().some(key => config.get(key) === "true");
  if (!promisor || excluded.length >= MAX_PUBLISHED_TIPS + 1) return { promisor };
  const localOptions = { ...options, maxBuffer: Math.min(options.maxBuffer ?? 65536, 65536), env: { ...options.env, GIT_NO_LAZY_FETCH: "1" } };
  let output: string;
  try { output = await runner.run(fetchNegotiationCommand(head, url), root, localOptions); }
  catch (error) {
    if (options.signal?.aborted || isGitLifecycleError(error) || !(error instanceof GitError)) throw error;
    logInfo("push shared history negotiation skipped", { repoRoot: root, reason: "negotiationUnavailable" });
    return { promisor: true };
  }
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines.some(line => !OID.test(line))) throw new Error("Could not verify negotiated Git history.");
  const acknowledged = [...new Set(lines)].slice(0, MAX_PUBLISHED_TIPS);
  const verified = await verifyLocalPublishedCommits(root, acknowledged, runner, localOptions);
  if (!verified.length || verified.every(oid => excluded.includes(oid))) return { promisor: true };
  let base = verified[0];
  if (verified.length > 1) {
    try { base = (await runner.run(["merge-base", head, ...verified], root, localOptions)).trim(); }
    catch (error) { if (error instanceof GitError && error.code === 1) return { promisor: true }; throw error; }
    if (!OID.test(base) || !verified.includes(base)) throw new Error("Could not verify negotiated Git history.");
  }
  if (excluded.includes(base)) return { promisor: true };
  logInfo("push shared history negotiated", { repoRoot: root, acknowledged: verified.length, addedBases: 1 });
  return { promisor: true, base };
}
