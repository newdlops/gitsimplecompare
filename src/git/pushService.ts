// 현재 브랜치 push 를 준비/실행하는 git 서비스.
// - 일반 push 가 upstream 이름 불일치나 미설정 상태에서 실패하지 않도록, remote 가 있으면
//   현재 로컬 브랜치명과 같은 remote branch 로 publish/upstream 설정할 계획을 계산한다.
import { GitError, runGit } from "./gitExec";
import { pushValidatedBranchCommits, pushConfigurationFingerprint, readPushConfiguration, SequentialPushError, type PushExecutionOptions, type PushExecutionResult } from "./sequentialPush";
import type { GitConfigSnapshot } from "./gitConfigSnapshot";
import { readPushCheckoutIdentity } from "./pushCheckoutIdentity";

/** 확인 당시의 커밋·목적 ref·설정 세대다. URL 원문은 로그에 노출하지 않도록 해시만 보존한다. */
interface PushSnapshot {
  head: string;
  targetRef: string;
  configFingerprint: string;
  remoteHead: string;
}

/** 현재 브랜치 push 가 실제로 실행한 방식 */
export type PushCurrentMode = "plain" | "setUpstream";

/** force push 실행 시 사용할 안전장치 옵션 */
export type ForcePushMode = "forceWithLease" | "force";

/** upstream 설정 push 가 필요한 이유 */
export type PushCurrentSetUpstreamReason =
  | "missingUpstream"
  | "goneUpstream"
  | "upstreamNameMismatch"
  | "unknownUpstream";

/** 현재 push 목적지를 유지하면서 승인할 커밋을 고정한 계획 */
export interface PlainPushCurrentPlan {
  mode: "plain";
  branch?: string;
  remote?: string;
  upstream?: string;
  snapshot: PushSnapshot;
}

/** remote branch 로 publish 하고 upstream 을 함께 설정해야 하는 계획 */
export interface SetUpstreamPushCurrentPlan {
  mode: "setUpstream";
  branch: string;
  remote: string;
  upstream?: string;
  targetUpstream: string;
  reason: PushCurrentSetUpstreamReason;
  snapshot: PushSnapshot;
}

/** 현재 브랜치 push 전에 UI 가 확인해야 할 실행 계획 */
export type PushCurrentPlan =
  | PlainPushCurrentPlan
  | SetUpstreamPushCurrentPlan;

/** 현재 브랜치 push 결과. UI/명령 레이어가 관찰 로그를 남길 때 사용한다. */
export type PushCurrentResult = PushCurrentPlan & { execution?: PushExecutionResult };

interface PushTarget {
  branch?: string;
  remote?: string;
  upstream?: string;
  upstreamGone: boolean;
  remotes: string[];
}

/**
 * 현재 브랜치 push 계획을 만든다.
 * - upstream 이 없거나, upstream branch 이름이 현재 로컬 브랜치명과 다르거나, upstream 이 사라졌으면
 *   remote 가 존재하는 경우 `setUpstream` 계획을 반환한다.
 * - detached HEAD나 remote 미설정은 계획 단계에서 중단하고, 유효한 계획에는 커밋/목적 ref를 고정한다.
 * @param repoRoot git 저장소 루트 경로
 * @returns push 실행 전에 UI 가 설명/확인에 사용할 계획
 */
export async function getCurrentPushPlan(
  repoRoot: string
): Promise<PushCurrentPlan> {
  const [{ checkout, upstreamCommit }, { config, fingerprint: configFingerprint }] = await Promise.all([
    readPushCheckoutIdentity(repoRoot),
    readPushConfiguration(repoRoot),
  ]);
  const { branch, branchRef: sourceRef } = checkout;
  if (!branch) throw new Error("Cannot push while HEAD is detached.");
  const remotes = await listRemotes(repoRoot, config);
  const configuredRemotes = [
    validRemoteConfig(config, remotes, `branch.${branch}.pushRemote`),
    validRemoteConfig(config, remotes, "remote.pushDefault"),
    validRemoteConfig(config, remotes, `branch.${branch}.remote`),
  ];
  const candidateRemote = firstRemote([...configuredRemotes, remotes.includes("origin") ? "origin" : undefined, remotes[0]]);
  const candidateTracking = candidateRemote ? `refs/remotes/${candidateRemote}/${branch}` : undefined;
  const refInfo = await runGit(["for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream)%00%(push:remoteref)%00%(push)%00%(upstream:remoteref)",
    sourceRef, ...(candidateTracking ? [candidateTracking] : [])], repoRoot);
  const refRows = new Map(refInfo.trimEnd().split("\n").map(line => { const fields = line.split("\0"); return [fields[0], fields] as const; }));
  const row = refRows.get(sourceRef);
  if (!row || row[1] !== checkout.head || row[2] !== "*") throw new Error("Cannot read the current branch commit. Refresh the checked-out branch before pushing.");
  const [, head, , upstreamRaw, upstreamTrackingRef, pushRef, trackingRef, upstreamRef] = row;
  const upstream = upstreamRaw || undefined;
  const remote = firstRemote([
    ...configuredRemotes,
    upstream ? splitRemoteBranch(upstream, remotes)?.remote : undefined,
    remotes.includes("origin") ? "origin" : undefined, remotes[0],
  ]);
  const selectedTracking = remote ? `refs/remotes/${remote}/${branch}` : "";
  // ref 이름·원본 OID만 읽어 이력 순회를 피하고, upstream의 commit 여부는 별도로 검증한다.
  const referenceTips = new Map([...refRows].map(([ref, fields]) => [ref, fields[1]]));
  const queriedRefs = new Set([sourceRef, candidateTracking]);
  const additionalRefs = [...new Set([upstreamTrackingRef, trackingRef, selectedTracking]
    .filter(ref => ref && !queriedRefs.has(ref) && !referenceTips.has(ref)))];
  if (additionalRefs.length) {
    for (const [ref, oid] of await readTrackingHeads(repoRoot, additionalRefs)) referenceTips.set(ref, oid);
  }
  const upstreamTip = referenceTips.get(upstreamTrackingRef);
  // blob·결측 객체는 Git처럼 gone으로 분류하고, 초기 힌트와 다른 OID만 대상 객체를 다시 검증한다.
  const upstreamGone = Boolean(upstreamTrackingRef && (!upstreamTip ||
    (upstreamTip !== upstreamCommit && !await readPushCommitTarget(repoRoot, upstreamTip))));
  const plan = toPushPlan({ branch, remotes, upstream, upstreamGone, remote });
  if (!plan.remote) throw new Error("No push remote is configured.");
  const pushDefault = config.get("push.default")?.trim();
  const customPush = config.getAll(`remote.${plan.remote}.push`).join("\n").trim();
  // Git은 명시적인 push refspec이 없으면 push:remoteref를 비울 수 있다.
  const defaultRef = !customPush && pushDefault !== "nothing"
    ? (["upstream", "tracking"].includes(pushDefault ?? "") ? upstreamRef : sourceRef) : "";
  const targetRef = plan.mode === "setUpstream" ? sourceRef : (pushRef || defaultRef);
  if (!targetRef?.startsWith("refs/")) throw new Error("Could not determine the current branch push target. Check the push configuration.");
  const tracking = plan.mode === "setUpstream"
    ? `refs/remotes/${plan.remote}/${plan.branch}` : trackingRef;
  const remoteHead = !tracking ? "" : referenceTips.get(tracking) ?? "";
  return { ...plan, snapshot: { head, targetRef, configFingerprint, remoteHead } };
}

/**
 * 이력 순회 없이 ref/OID가 실제 commit으로 해석되는지 확인하고 태그는 Git에 맡겨 peel한다.
 * - HEAD와 함께 읽은 힌트와 다른 upstream은 실제 metadata OID로 반드시 다시 검증한다.
 * - 정확한 OID의 손상·실행 중단 오류는 gone으로 숨기지 않고 호출부에 전달한다.
 * @param repoRoot 저장소 루트 @param ref metadata에서 고정한 원본 OID
 * @returns commit으로 해석되는 OID. 정상적인 결측/비commit이면 undefined
 */
async function readPushCommitTarget(repoRoot: string, ref: string): Promise<string | undefined> {
  return runGit(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], repoRoot)
    .then(output => output.trim() || undefined)
    .catch(error => {
      if (error instanceof GitError && error.code === 1) return undefined;
      throw error;
    });
}

/**
 * 사용자 refspec/upstream이 기본 추적 위치와 다를 때 필요한 ref를 한 번에 읽는다.
 * - OID만 읽어 이력을 열지 않으며, 접두사로 일치하는 자식 ref를 요청한 ref로 채택하지 않는다.
 * @param repoRoot 저장소 루트 @param refs 정확한 ref 이름 목록
 * @returns 실제로 존재하는 요청 ref와 OID의 새 맵. 없는 ref는 키가 없다.
 */
async function readTrackingHeads(repoRoot: string, refs: string[]): Promise<Map<string, string>> {
  const requested = new Set(refs);
  const output = await runGit(["for-each-ref", "--format=%(refname)%00%(objectname)", ...refs], repoRoot);
  return new Map(output.trimEnd().split("\n").map(line => line.split("\0"))
    .filter(fields => requested.has(fields[0])).map(([ref, oid]) => [ref, oid]));
}

/**
 * 현재 브랜치를 계획대로 push 한다.
 * - `setUpstream` 계획은 remote branch 가 없으면 새로 만들 수 있으므로 호출부가 먼저 사용자 확인을 받아야 한다.
 * - 확인 이후 브랜치/커밋/대상 설정이 바뀌면 원격에 쓰기 전에 중단한다.
 * @param repoRoot git 저장소 루트 경로
 * @param plan     이미 확인한 push 계획. 없으면 현재 상태를 다시 읽어 계획을 만든다.
 * @returns 실행한 push 방식과 대상 remote/branch 정보
 */
export async function pushCurrentWithAutoUpstream(
  repoRoot: string,
  plan?: PushCurrentPlan,
  options: PushExecutionOptions = {}
): Promise<PushCurrentResult> {
  const resolved = plan ?? (await getCurrentPushPlan(repoRoot));
  const execution = await executePush(repoRoot, resolved, undefined, options);
  return { ...resolved, execution };
}

/**
 * 현재 브랜치를 force push 한다.
 * - 일반 push 와 같은 upstream 보정 계획을 사용하되, 사용자가 고른 force 옵션을 명시적으로 붙인다.
 * - `forceWithLease` 는 확인 당시 알고 있던 remote OID를 고정해 background fetch가 덮어쓰기 보호를 풀지 못하게 한다.
 * @param repoRoot git 저장소 루트 경로
 * @param mode     `--force-with-lease` 또는 `--force` 선택
 * @param plan     이미 확인한 push 계획. 없으면 현재 상태를 다시 읽어 계획을 만든다.
 * @returns 실행한 push 방식과 대상 remote/branch 정보
 */
export async function forcePushCurrent(
  repoRoot: string,
  mode: ForcePushMode,
  plan?: PushCurrentPlan
): Promise<PushCurrentResult> {
  const resolved = plan ?? (await getCurrentPushPlan(repoRoot));
  await executePush(repoRoot, resolved, mode);
  return resolved;
}

/**
 * 승인한 계획과 현재 상태를 비교한 뒤 커밋 OID와 목적 ref를 명시하여 push한다.
 * - 네트워크 대기 중 HEAD가 바뀌어도 다른 커밋이 전송되지 않는다.
 * - upstream은 성공 후 승인한 로컬 브랜치에만 설정하므로 현재 HEAD를 따라가지 않는다.
 * @param repoRoot 대상 저장소
 * @param plan 사용자 확인 당시 계획
 * @param force 선택한 force 정책. 없으면 일반 push
 */
async function executePush(repoRoot: string, plan: PushCurrentPlan, force?: ForcePushMode, options: PushExecutionOptions = {}): Promise<PushExecutionResult | undefined> {
  await validatePushPlan(repoRoot, plan);
  let execution: PushExecutionResult | undefined;
  if (!force) {
    execution = await pushValidatedBranchCommits(repoRoot, {
      branch: plan.branch!, remote: plan.remote!, head: plan.snapshot.head, targetRef: plan.snapshot.targetRef,
    }, { ...options, setUpstream: false, requireCurrentBranch: true,
      approvedConfigurationFingerprint: plan.snapshot.configFingerprint });
  } else {
    const args = ["push"];
    if (force === "force") args.push("--force");
    if (force === "forceWithLease") {
      args.push(`--force-with-lease=${plan.snapshot.targetRef}:${plan.snapshot.remoteHead}`);
    }
    args.push(plan.remote!, `${plan.snapshot.head}:${plan.snapshot.targetRef}`);
    await runGit(args, repoRoot, { retryOnLock: false });
  }
  if (plan.mode === "setUpstream") {
    try {
      const source = (await runGit(["rev-parse", "--verify", `refs/heads/${plan.branch}`], repoRoot)).trim();
      if (source !== plan.snapshot.head || await pushConfigurationFingerprint(repoRoot) !== plan.snapshot.configFingerprint) {
        throw new Error("Push completed, but local branch settings changed. The upstream was not changed; refresh to check the result.");
      }
      await runGit(["branch", `--set-upstream-to=${plan.targetUpstream}`, "--", plan.branch], repoRoot, { retryOnLock: false });
    } catch (error) {
      if (execution?.strategy === "sequential") throw new SequentialPushError(error, execution);
      throw error;
    }
  }
  return execution;
}

/**
 * 사용자 확인 이후 첫 실행 전에 전체 계획이 유지되는지 검증한다.
 * - 각 전송 직전의 branch/source/config 검사는 pushBranchCommits가 한 번씩 담당한다.
 * @param repoRoot 저장소 루트 @param plan 사용자에게 확인받은 계획
 * @returns 계획이 일치하면 완료하고 변경됐다면 원격 mutation 전에 실패한다.
 */
async function validatePushPlan(repoRoot: string, plan: PushCurrentPlan): Promise<void> {
  const current = await getCurrentPushPlan(repoRoot);
  if (!plan.snapshot || plan.branch !== current.branch || plan.remote !== current.remote ||
      plan.mode !== current.mode || plan.upstream !== current.upstream ||
      plan.snapshot.head !== current.snapshot.head || plan.snapshot.targetRef !== current.snapshot.targetRef ||
      plan.snapshot.configFingerprint !== current.snapshot.configFingerprint) {
    throw new Error("Push target or local commits changed after confirmation. Refresh and try again.");
  }
}

/**
 * 현재 push 계획에서 upstream 설정이 필요한 이유를 계산한다.
 * - 반환값이 있으면 remote branch 생성 가능성이 있으므로 UI 확인이 필요하다.
 * @param target 현재 브랜치의 push 대상 후보 정보
 * @returns upstream 설정 이유 또는 설정이 필요 없으면 undefined
 */
function setUpstreamReason(
  target: PushTarget
): PushCurrentSetUpstreamReason | undefined {
  if (!target.branch || !target.remote) {
    return undefined;
  }
  if (!target.upstream) {
    return "missingUpstream";
  }
  if (target.upstreamGone) {
    return "goneUpstream";
  }
  const upstream = splitRemoteBranch(target.upstream, target.remotes);
  if (!upstream) {
    return "unknownUpstream";
  }
  return upstream.branch !== target.branch ? "upstreamNameMismatch" : undefined;
}

/**
 * git 조회 결과를 UI/실행 레이어가 공유할 push 계획으로 변환한다.
 * @param target 현재 브랜치의 push 대상 후보 정보
 * @returns plain push 또는 upstream 설정 push 계획
 */
function toPushPlan(target: PushTarget): Omit<PlainPushCurrentPlan, "snapshot"> | Omit<SetUpstreamPushCurrentPlan, "snapshot"> {
  const reason = setUpstreamReason(target);
  if (!reason || !target.branch || !target.remote) {
    return {
      mode: "plain",
      branch: target.branch,
      remote: target.remote,
      upstream: target.upstream,
    };
  }
  return {
    mode: "setUpstream",
    branch: target.branch,
    remote: target.remote,
    upstream: target.upstream,
    targetUpstream: `${target.remote}/${target.branch}`,
    reason,
  };
}

/**
 * 같은 계획에서 이미 읽은 설정을 재사용해 Git 순서의 remote 목록을 반환한다.
 * - 빈 subsection·손실 디코딩 등 모호한 키는 native git remote로 폴백해 기존 해석을 보존한다.
 * - 실행 실패는 실제 원인을 호출부로 전달해 remote 미설정과 구분한다.
 * @param repoRoot git 저장소 루트 경로
 * @param config 같은 계획의 최신 설정 snapshot @returns native 정렬·공백 처리 규칙의 remote 이름 배열
 */
async function listRemotes(repoRoot: string, config: GitConfigSnapshot): Promise<string[]> {
  const names = new Set<string>(), prefix = "remote.";
  let nativeFallback = false;
  for (const key of config.keys()) {
    if (!key.startsWith(prefix) || key === "remote.pushdefault") continue;
    const end = key.lastIndexOf(".");
    if (end <= prefix.length || /[\r\n\uFFFD]/.test(key)) { nativeFallback = true; break; }
    names.add(key.slice(prefix.length, end));
  }
  const out = nativeFallback ? ((await optionalGit(["remote"], repoRoot)) ?? "")
    : [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).join("\n");
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * git config 에 저장된 remote 이름이 실제 remote 목록에 있을 때만 반환한다.
 * - branch.remote 값이 `.` 이거나 삭제된 remote 를 가리키면 push 대상으로 쓰지 않는다.
 * @param config 같은 계획에서 새로 읽은 설정 snapshot
 * @param remotes 현재 저장소의 remote 이름 목록
 * @param key 읽을 git config 키
 * @returns 유효한 remote 이름 또는 undefined
 */
function validRemoteConfig(
  config: GitConfigSnapshot,
  remotes: string[],
  key: string
): string | undefined {
  const remote = config.get(key)?.trim();
  return remote && remotes.includes(remote) ? remote : undefined;
}

/**
 * 첫 번째 유효 remote 이름을 고른다.
 * - 호출부에서 Git 의 push remote 우선순위를 배열 순서로 넘기면, 빈 값 없이 첫 후보만 선택한다.
 * @param candidates 우선순위가 높은 순서의 remote 후보 목록
 * @returns 선택된 remote 이름 또는 undefined
 */
function firstRemote(candidates: Array<string | undefined>): string | undefined {
  return candidates.find((candidate) => Boolean(candidate));
}

/**
 * remote/branch 형태의 upstream short name 을 remote 이름과 branch 이름으로 나눈다.
 * - remote 이름이 겹칠 수 있으므로 등록된 remote 중 가장 긴 prefix 를 먼저 검사한다.
 * @param ref upstream short name 예: origin/main
 * @param remotes 현재 저장소의 remote 이름 목록
 * @returns remote/branch 조합 또는 해석 실패 시 undefined
 */
function splitRemoteBranch(
  ref: string,
  remotes: string[]
): { remote: string; branch: string } | undefined {
  const remote = [...remotes]
    .sort((a, b) => b.length - a.length)
    .find((name) => ref.startsWith(`${name}/`));
  if (!remote || ref.length <= remote.length + 1) {
    return undefined;
  }
  return { remote, branch: ref.slice(remote.length + 1) };
}

/**
 * 실패할 수 있는 git 조회 명령을 선택적으로 실행한다.
 * - config 키 부재와 detached HEAD만 정상 결측으로 다루고 실행 실패는 그대로 전달한다.
 * @param args git 인자 배열
 * @param repoRoot git 저장소 루트 경로
 * @returns trim 된 stdout 또는 undefined
 */
async function optionalGit(
  args: string[],
  repoRoot: string
): Promise<string | undefined> {
  const out = await runGit(args, repoRoot).catch(error => {
    if (error instanceof GitError && error.code === 1 &&
        (args[0] === "config" || args[0] === "symbolic-ref")) return undefined;
    throw error;
  });
  const text = out?.trim();
  return text ? text : undefined;
}
