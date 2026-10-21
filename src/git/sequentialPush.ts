// 큰 일반 push를 원격 tip의 조상 순서대로 나누는 서비스. VS Code나 UI에 의존하지 않는다.
// 병합으로 들어온 곁가지 커밋은 merge commit과 함께 전송해 목적 브랜치를 항상 fast-forward한다.
import { createHash } from "node:crypto";
import { GitError, runGit, runGitWithInput, runGitStreamWithInput, runGitReadPipeline, type RunGitOptions } from "./gitExec";
import { readGitConfigSnapshot } from "./gitConfigSnapshot";
import { MAX_PUBLISHED_TIPS, readPublishedPushTips, readPushBranchAdvertisement } from "./pushPublishedHistory";
import { logInfo } from "../ui/outputLog";

/** 압축 전 신규 Git 객체 합계가 이 값 이상인 다중 커밋 push를 분할한다. */
export const SEQUENTIAL_PUSH_THRESHOLD_BYTES = 50 * 1024 * 1024;

/** 이름 대신 OID로 고정한 source와 정확한 원격 destination이다. */
export interface BranchPushTarget {
  branch: string;
  head: string;
  remote: string;
  targetRef: string;
}

/** UI/로그가 같은 진행 상태를 표시하도록 전달하는 비밀 정보 없는 이벤트다. */
export interface PushProgress {
  phase: "planning" | "ready" | "pushing" | "pushed" | "stopped";
  strategy: "single" | "sequential";
  completed: number;
  total: number;
  commit?: string;
  estimatedBytes?: number;
  reason?: string;
}

/** 공통 push 실행 옵션. threshold=0은 크기에 관계없이 안전한 다중 커밋을 분할한다. */
export interface PushExecutionOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PushProgress) => void;
  sequentialThresholdBytes?: number;
  /** 승인 이후 HEAD/목적지 변경 등 호출부의 추가 조건을 매 전송 직전에 확인한다. */
  beforePush?: () => Promise<void>;
  /** 모든 전송 성공 후에만 고정한 로컬 브랜치의 upstream을 설정한다. */
  setUpstream?: boolean;
  /** 첫 서버 조회에 다른 게시 branch도 포함할 범위 힌트. 실제 목적 OID/lease 검증은 생략하지 않는다. */
  includePublishedBranches?: boolean;
  /** 현재 브랜치 push는 HEAD가 승인한 로컬 브랜치를 계속 가리키는지도 함께 확인한다. */
  requireCurrentBranch?: boolean;
  /** 상위 서비스의 승인 시점 설정 해시. 생략하면 이 실행의 초기 설정을 기준으로 고정한다. */
  approvedConfigurationFingerprint?: string;
}

/** 마지막 성공 OID는 부분 실패 뒤 사용자가 원격 상태를 확인하는 데 사용한다. */
export interface PushExecutionResult {
  strategy: "single" | "sequential";
  completed: number;
  total: number;
  estimatedBytes?: number;
  lastPushedCommit?: string;
}

/** 이미 성공한 원격 업데이트를 숨기지 않고 원본 오류와 확인된 진행량을 보존한다. */
export class SequentialPushError extends Error {
  readonly cancelled: boolean;

  /** @param cause 실패 원인 @param result 서버가 성공 응답한 커밋 수와 마지막 OID */
  constructor(cause: unknown, readonly result: PushExecutionResult, cancelled = false) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Push stopped after ${result.completed}/${result.total} commits. ${message}`, { cause });
    this.name = "SequentialPushError";
    this.cancelled = cancelled;
  }
}

/** 실제 Git 실행을 대체해 네트워크/동시 변경 경계를 결정적으로 검증하는 의존성이다. */
export interface PushGitRunner {
  run(args: string[], root: string, options?: RunGitOptions): Promise<string>;
  input(args: string[], root: string, input: string, options?: RunGitOptions): Promise<string>;
  /** 큰 객체 목록의 숫자 출력을 누적하지 않는 선택적 streaming 경계. 기존 대역은 input으로 폴백한다. */
  inputStream?(args: string[], root: string, input: string, onData: (chunk: Buffer) => void, options?: RunGitOptions): Promise<void>;
  /** 객체 목록 전체를 보관하지 않고 두 readonly Git 사이를 연결하는 선택적 transport다. */
  pipe?(sourceArgs: string[], targetArgs: string[], root: string, onData: (chunk: Buffer) => void, options?: RunGitOptions): Promise<void>;
}

interface TransferPlan {
  commits: string[];
  remoteHead: string;
  strategy: "single" | "sequential";
  estimatedBytes?: number;
  reason: string;
}

/** 최근 후보의 원본 부모를 함께 읽어 추가 Git 조회 없이 선형 이력과 전체 두 커밋 경계를 판정한다. */
interface RecentPushCommits { commits: string[]; oldestParents: string[]; headParents: string[]; publishedBase?: string; }

const defaultRunner: PushGitRunner = { run: runGit, input: runGitWithInput, inputStream: runGitStreamWithInput, pipe: runGitReadPipeline };
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/**
 * 큰 push를 오래된 커밋부터 하나씩 await하며 전송한다. 실패/취소 뒤에는 다음 push를 시작하지 않는다.
 * - 실제 push URL의 원격 OID를 다시 읽어 재시도 시 이미 전송한 커밋을 제외한다.
 * - 각 순차 push는 직전 성공 OID에 대한 명시적 lease로 다른 사용자의 업데이트를 보호한다.
 * @param repoRoot 저장소 루트 @param target 승인한 source OID와 목적 ref
 * @param options 취소·진행·승인 검증 옵션 @param runner 공유 Git 실행기 또는 테스트 대역
 * @returns 서버가 확인한 전송 결과. 부분 실패는 SequentialPushError로 전달한다.
 */
export async function pushBranchCommits(
  repoRoot: string, target: BranchPushTarget, options: PushExecutionOptions = {}, runner = defaultRunner
): Promise<PushExecutionResult> {
  return executeBranchPush(repoRoot, target, options, runner, false);
}

/**
 * 상위 push 서비스가 전체 계획을 방금 검증한 경우 준비 단계의 같은 두 조회만 생략한다.
 * - 설정 hash가 없거나 beforePush 추가 조건이 있으면 기존 초기 검사도 실행한다.
 * - 비동기 계획 뒤 실제 매 전송 직전의 HEAD/설정·취소 검사는 항상 실행하므로 쓰기 안전 경계는 같다.
 * @param repoRoot 승인한 저장소 @param target 방금 확인한 source/목적지 @param options 원본 승인 설정 hash와 실행 옵션
 */
export async function pushValidatedBranchCommits(repoRoot: string, target: BranchPushTarget, options: PushExecutionOptions): Promise<PushExecutionResult> {
  return executeBranchPush(repoRoot, target, options, defaultRunner, !!options.approvedConfigurationFingerprint && !options.beforePush);
}

/** 일반/검증 직후 진입점이 동일한 계획·전송·부분 실패 처리를 공유하는 실행 본문이다. */
async function executeBranchPush(repoRoot: string, target: BranchPushTarget, options: PushExecutionOptions,
  runner: PushGitRunner, initialValidated: boolean): Promise<PushExecutionResult> {
  if (!OID.test(target.head) || !target.targetRef.startsWith("refs/")) {
    throw new Error("A fixed commit and a remote branch are required for pushing.");
  }
  // lease가 일반 fast-forward 보호를 우회하므로 실제로 전송되는 원본 DAG만 조상 판단에 사용한다.
  const runOptions: RunGitOptions = { signal: options.signal, retryOnLock: false, env: {
    GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: process.platform === "win32" ? "NUL" : "/dev/null",
  } };
  const fingerprint = options.approvedConfigurationFingerprint ?? await pushConfigurationFingerprint(repoRoot, runner, runOptions);
  /** 커밋/remote 설정 변경은 이미 승인한 source를 다른 대상으로 보내기 전에 중단한다. */
  const validate = async () => {
    assertNotCancelled(options.signal);
    await options.beforePush?.();
    const [identity, currentFingerprint] = await Promise.all([
      runner.run(["for-each-ref", "--format=%(objectname)%00%(HEAD)", `refs/heads/${target.branch}`], repoRoot, runOptions),
      pushConfigurationFingerprint(repoRoot, runner, runOptions),
    ]);
    const [head, current] = identity.trim().split("\0");
    if (head !== target.head || (options.requireCurrentBranch && current !== "*") || currentFingerprint !== fingerprint) {
      throw new Error("Push target or local commits changed after confirmation. Refresh and try again.");
    }
  };
  options.onProgress?.({ phase: "planning", strategy: "single", completed: 0, total: 0 });
  if (initialValidated) assertNotCancelled(options.signal);
  else await validate();
  const plan = await prepareTransfer(repoRoot, target, options, runner, runOptions);
  const result: PushExecutionResult = {
    strategy: plan.strategy, completed: 0, total: plan.commits.length, estimatedBytes: plan.estimatedBytes,
  };
  /** 동일한 계획과 확인된 진행량을 복사해 소비자가 내부 상태를 바꾸지 못하게 한다. */
  const report = (phase: PushProgress["phase"], commit?: string) => options.onProgress?.({
    phase, strategy: result.strategy, completed: result.completed, total: result.total,
    estimatedBytes: result.estimatedBytes, commit, reason: plan.reason,
  });
  report("ready");
  let expectedRemoteHead = plan.remoteHead;
  try {
    for (const commit of plan.commits) {
      await validate();
      report("pushing", commit);
      assertNotCancelled(options.signal);
      const args = ["push"];
      if (plan.strategy === "sequential") {
        args.push(`--force-with-lease=${target.targetRef}:${expectedRemoteHead}`);
      }
      args.push("--", target.remote, `${commit}:${target.targetRef}`);
      await runner.run(args, repoRoot, runOptions);
      result.completed++;
      result.lastPushedCommit = commit;
      expectedRemoteHead = commit;
      report("pushed", commit);
    }
    if (options.setUpstream) {
      await validate();
      const branch = target.targetRef.slice("refs/heads/".length);
      // 좁은 fetch refspec에서는 tracking ref가 없을 수 있다. git push -u와 같은 설정을 직접 기록한다.
      await runner.run(["config", "--local", "--replace-all", `branch.${target.branch}.remote`, target.remote], repoRoot, runOptions);
      await runner.run(["config", "--local", "--replace-all", `branch.${target.branch}.merge`, `refs/heads/${branch}`], repoRoot, runOptions);
    }
    return result;
  } catch (error) {
    report("stopped");
    if (plan.strategy === "sequential" || options.signal?.aborted) {
      throw new SequentialPushError(error, { ...result }, options.signal?.aborted);
    }
    throw error;
  }
}

/**
 * 단일 목적지에서 일반 fast-forward가 가능한 경우만 분할한다.
 * @param target 고정한 목적지 @returns 크기와 안전한 조상 체인을 포함한 전송 계획
 */
async function prepareTransfer(
  root: string, target: BranchPushTarget, options: PushExecutionOptions, runner: PushGitRunner, runOptions: RunGitOptions
): Promise<TransferPlan> {
  const single = (reason: string, estimatedBytes?: number): TransferPlan => ({
    commits: [target.head], remoteHead: "", strategy: "single", reason, estimatedBytes,
  });
  if (!target.targetRef.startsWith("refs/heads/")) return single("nonBranchTarget");
  const threshold = options.sequentialThresholdBytes ?? SEQUENTIAL_PUSH_THRESHOLD_BYTES;
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error("Sequential push threshold must be a non-negative byte count.");
  const urls = (await runner.run(["remote", "get-url", "--push", "--all", target.remote], root, runOptions))
    .trim().split(/\r?\n/).filter(Boolean);
  // 여러 push URL을 서로 다른 부분 전송 상태로 만들지 않고 기존 Git의 일괄 push 동작을 유지한다.
  if (urls.length !== 1) return single("multiplePushDestinations");
  // upstream을 새로 연결하는 흐름만 게시 이력을 함께 읽는다. 일반 추적 push는 정확한 목적 ref만 조회한다.
  // 이 선택은 조회 범위 힌트이며, 실제 목적 OID와 lease는 항상 서버 응답으로 결정한다.
  const completeAdvertisement = options.includePublishedBranches ?? (options.setUpstream === true);
  const advertisement = await readPushBranchAdvertisement(root, urls[0], runner, runOptions, completeAdvertisement ? undefined : target.targetRef);
  const remoteHead = advertisement.get(target.targetRef) ?? "";
  if (remoteHead === target.head) return single("alreadyPushed");
  if (remoteHead && !(await isAncestor(root, remoteHead, target.head, runner, runOptions))) {
    return single("remoteNotAncestor");
  }
  // 같은 서버 광고의 게시 이력을 먼저 제외해 새 branch의 기존 기본 이력 전체를 크기 조회하지 않는다.
  // 제외 tip은 빈 목적 branch의 lease와 분리하고, 로컬에서 commit으로 검증한 값만 사용한다.
  const published = remoteHead ? undefined : completeAdvertisement ? advertisement : await readPushBranchAdvertisement(root, urls[0], runner, runOptions);
  const excludedHeads = remoteHead ? [remoteHead] : await readPublishedPushTips(root, urls[0], target.head, runner, runOptions, published);
  const recent = await readRecentFirstParentCommits(root, target, excludedHeads, runner, runOptions,
    published ? new Set(published.values()) : undefined);
  // 광고 순서 때문에 64개 표본에서 빠진 실제 first-parent base만 보충한다.
  // 기존 제외 tip은 모두 유지한다. 별도 Git 없이 읽은 commit이므로 최대 64+1개로 한정된다.
  if (recent.publishedBase && !excludedHeads.includes(recent.publishedBase)) excludedHeads.push(recent.publishedBase);
  if (!remoteHead) logInfo("push published history checked", { repoRoot: root, verifiedTips: excludedHeads.length,
    firstParentBaseUsed: !!recent.publishedBase });
  // 한 커밋은 분할하지 않으므로 이미 확인한 remoteHead → target.head 조상 관계를 다시 읽지 않는다.
  if (recent.commits.length < 2 || recent.commits.at(-1) !== target.head) return single("singleCommit");
  const complete = remoteHead ? recent.oldestParents[0] === remoteHead : !recent.oldestParents.length || excludedHeads.includes(recent.oldestParents[0]);
  // 직전 first-parent조차 원격 tip의 후손이 아니면 더 오래된 조상도 후손일 수 없다.
  // 두 번째 부모에서 원격 이력이 합쳐진 merge 하나만 보낼 때 전체 목록과 이진 탐색을 생략한다.
  // HEAD의 부모가 하나면 기존 remote→HEAD 검증만으로 그 부모도 후손임을 안다.
  if (remoteHead && !complete && recent.headParents.length > 1 &&
      !(await isAncestor(root, remoteHead, recent.commits[0], runner, runOptions))) return single("singleCommit");
  const estimatedBytes = await estimateObjectBytes(root, target.head, excludedHeads, runner, runOptions);
  if (estimatedBytes < threshold) return single("belowThreshold", estimatedBytes);
  // 실제 분할할 큰 push만 전체 전송 순서를 만든다. 작은 push는 확장 호스트에 긴 commit 배열을 남기지 않는다.
  let commits = complete ? recent.commits : await readFirstParentCommits(root, target, excludedHeads, runner, runOptions);
  if (commits.length < 2 || commits.at(-1) !== target.head) return single("singleCommit");
  // 원격 tip이 merge의 두 번째 부모에 있을 때도 첫 전송이 반드시 그 tip의 후손이어야 한다.
  if (remoteHead && commits[0] !== recent.commits[0] && !(await isAncestor(root, remoteHead, commits[0], runner, runOptions))) {
    // 일반 first-parent 조상은 첫 커밋만 확인한다. 곁가지 remote tip일 때만 이진 탐색한다.
    let low = 1, high = commits.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (await isAncestor(root, remoteHead, commits[middle], runner, runOptions)) high = middle;
      else low = middle + 1;
    }
    commits = commits.slice(low);
  }
  if (commits.length < 2 || commits.at(-1) !== target.head) return single("singleCommit");
  return { commits, remoteHead, strategy: "sequential", estimatedBytes, reason: "largePush" };
}

/**
 * @param root 저장소 루트 @param target 승인한 source @param excludedHeads 실제 서버 소유가 검증된 제외 tip
 * @param runner 공유 Git 실행기 @param runOptions 원본 DAG·취소 정책 @returns 큰 push의 오래된 순서 OID 목록
 */
async function readFirstParentCommits(
  root: string, target: BranchPushTarget, excludedHeads: readonly string[], runner: PushGitRunner, runOptions: RunGitOptions
): Promise<string[]> {
  const commits = (await runner.run([
    "rev-list", "--first-parent", "--reverse", target.head, ...excludedHeads.map(head => `^${head}`), "--",
  ], root, runOptions)).trim().split(/\r?\n/).filter(Boolean);
  if (commits.some(commit => !OID.test(commit))) throw new Error("Could not read the outgoing commit sequence.");
  return commits;
}

/**
 * @param root 저장소 루트 @param target 고정 source @param excludedHeads 실제 서버가 소유한 제외 tip
 * @param runner Git 실행 경계 @param runOptions 원본 DAG·취소 정책
 * @param publishedTips 같은 실제 서버가 광고한 OID. 64개를 넘을 때만 기존 조회를 최대 65개로 넓힌다.
 * @returns 최신 두 후보와 실제 부모 OID, Native first-parent 조회가 검증한 가장 가까운 게시 base
 * max-count는 reverse 전에 적용된다. 메시지는 출력하지 않고 NUL 필드로 해시와 부모만 구분한다.
 */
async function readRecentFirstParentCommits(
  root: string, target: BranchPushTarget, excludedHeads: readonly string[], runner: PushGitRunner, runOptions: RunGitOptions,
  publishedTips?: ReadonlySet<string>
): Promise<RecentPushCommits> {
  const maxCount = publishedTips && publishedTips.size > MAX_PUBLISHED_TIPS ? MAX_PUBLISHED_TIPS + 1 : 2;
  const output = await runner.run([
    "rev-list", "--first-parent", "--reverse", `--max-count=${maxCount}`, "--format=%H%x00%P", "--no-commit-header",
    target.head, ...excludedHeads.map(head => `^${head}`), "--",
  ], root, runOptions);
  const entries = output.trimEnd().split(/\r?\n/).filter(Boolean).map(line => {
    const [hash, rawParents] = line.split("\0");
    const parents = rawParents ? rawParents.split(" ") : [];
    if (!OID.test(hash) || rawParents === undefined || parents.some(parent => !OID.test(parent))) throw new Error("Could not read the outgoing commit sequence.");
    return { hash, parents };
  });
  if (entries.length > maxCount || entries.some((entry, index) => index > 0 && entry.parents[0] !== entries[index - 1].hash) ||
      (entries.length > 0 && entries.at(-1)!.hash !== target.head)) throw new Error("Could not read the outgoing commit sequence.");
  // 기존 제외 tip을 적용한 연속 first-parent 열이므로 추가 base의 조상 쪽 항목만 제거된다.
  let publishedIndex = -1;
  if (maxCount > 2) for (let index = entries.length - 1; index >= 0; index--) {
    if (publishedTips!.has(entries[index].hash)) { publishedIndex = index; break; }
  }
  const recent = entries.slice(publishedIndex + 1).slice(-2);
  return { commits: recent.map(entry => entry.hash), oldestParents: recent[0]?.parents || [], headParents: recent.at(-1)?.parents || [],
    publishedBase: publishedIndex < 0 ? undefined : entries[publishedIndex].hash };
}

/**
 * 원격 tip이 로컬 commit의 실제 조상인지 확인한다. 원격 객체를 fetch하여 로컬 ref를 바꾸지 않는다.
 * @returns 조상이면 true, 객체 부재/다른 이력이면 false. 취소와 기타 실행 오류는 보존한다.
 */
async function isAncestor(root: string, ancestor: string, head: string, runner: PushGitRunner, options: RunGitOptions): Promise<boolean> {
  try {
    await runner.run(["merge-base", "--is-ancestor", ancestor, head], root, options);
    return true;
  } catch (error) {
    if (!options.signal?.aborted && error instanceof GitError && [1, 128].includes(Number(error.code))) return false;
    throw error;
  }
}

/**
 * 신규 commit/tree/blob의 압축 전 바이트 합계를 구한다. 파일 내용은 읽지 않고 객체 메타데이터만 조회한다.
 * @param excludedHeads 서버가 이미 소유한 이력의 tip @returns 실제 pack/네트워크 크기와 다를 수 있는 크기 추정치
 */
async function estimateObjectBytes(root: string, head: string, excludedHeads: readonly string[], runner: PushGitRunner, options: RunGitOptions): Promise<number> {
  const objectArgs = [
    "rev-list", "--objects", "--no-object-names", head, ...excludedHeads.map(tip => `^${tip}`), "--",
  ];
  let bytes = 0, pending = "";
  /** 숫자 한 행만 검증해 objectsize 합계의 정확성과 safe integer 경계를 유지한다. */
  const addSize = (line: string) => {
    line = line.trim();
    if (!line) return;
    const value = Number(line);
    if (!/^\d+$/.test(line) || !Number.isSafeInteger(value) || !Number.isSafeInteger(bytes + value)) {
      throw new Error("Could not estimate the outgoing Git objects.");
    }
    bytes += value;
  };
  /** UTF-8 숫자 출력의 chunk 경계를 합치되 완성된 행이나 전체 숫자 배열은 보관하지 않는다. */
  const consume = (chunk: Buffer) => {
    const text = pending + chunk.toString("utf8");
    let start = 0, end: number;
    while ((end = text.indexOf("\n", start)) >= 0) { addSize(text.slice(start, end)); start = end + 1; }
    pending = text.slice(start);
    if (pending.length > 32) throw new Error("Could not estimate the outgoing Git objects.");
  };
  // 전체 합계를 구하는 조회는 EOF까지 기다릴 수 있어 객체마다 flush하는 IPC 비용을 줄인다.
  const args = ["cat-file", "--batch-check=%(objectsize)", "--buffer"];
  if (runner.pipe) await runner.pipe(objectArgs, args, root, consume, options);
  else {
    const objects = await runner.run(objectArgs, root, options);
    if (runner.inputStream) await runner.inputStream(args, root, objects, consume, options);
    else consume(Buffer.from(await runner.input(args, root, objects, options)));
  }
  addSize(pending);
  return bytes;
}

/**
 * remote URL/refspec/branch/push 설정을 같은 해시로 묶어 승인과 단계별 검증이 중복 조회 없이 공유한다.
 * @param root 저장소 루트 @param runner 공통 실행기 또는 테스트 대역
 * @param options 취소·조회 환경 @returns 민감한 원문을 포함하지 않는 SHA-256 해시
 */
export async function pushConfigurationFingerprint(root: string, runner = defaultRunner, options: RunGitOptions = {}): Promise<string> {
  return (await readPushConfiguration(root, runner, options)).fingerprint;
}

/**
 * 승인 해시를 만드는 바로 그 설정 원문을 대상 선택에도 제공해 별도 config 실행을 피한다.
 * @param root 저장소 루트 @param runner Git 실행 경계 @param options 취소 등 실행 옵션
 * @returns 같은 호출에서 읽은 설정 값과 기존 규칙의 SHA-256 fingerprint
 */
export async function readPushConfiguration(root: string, runner = defaultRunner, options: RunGitOptions = {}) {
  const config = await readGitConfigSnapshot(root, "^(branch\\.|remote\\.|push\\.|url\\.)", options, runner.run.bind(runner));
  return { config, fingerprint: createHash("sha256").update(config.raw).digest("hex") };
}

/** 다음 mutation 직전에 취소를 확인한다. 이미 성공한 원격 업데이트를 rollback하지 않는다. */
function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("Push cancelled."), { name: "AbortError" });
}
