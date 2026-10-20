// 큰 Graph 브랜치 목록의 공통 upstream 이력 계산을 Git의 일괄 ahead/behind 계산으로 묶는다.
// - 커밋/설정/HEAD는 매번 새로 읽고, 조회 전략만 서비스 수명 안에서 기억한다.
import type { GraphLocalBranchSnapshot, LocalBranchStatus } from "../graph/graphTypes";
import { logInfo } from "../ui/outputLog";
import { GitError, runGit } from "./gitExec";
import { isGitLifecycleError } from "./gitError";
import { readGraphLocalBranchSnapshot, type GraphLocalBranchRunner } from "./graphLocalBranches";

const FS = "\x1f";
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MIN_TRACKED_BRANCHES = 128;
const MIN_TRACKING_DISTANCE = 10_000;
const MAX_BASES = 8;
const MAX_REF_ARGUMENT_BYTES = 24 * 1024;

/** UI 행과 별도로 원본 full ref를 보존해 이름 충돌과 upstream 변경을 구분한다. */
interface BranchCandidate { branch: LocalBranchStatus; fullRef: string; upstreamRef: string; }
/** 한 번의 Git 일괄 조회에서 확인한 로컬 tip과 기준점별 정확한 이력 차이다. */
interface TrackingCounts { hash: string; pairs: { ahead: number; behind: number }[]; }

/** 저장소 하나의 브랜치 조회 전략만 관리하고 이전 상태 데이터는 재사용하지 않는다. */
export class GraphLocalBranchTrackingReader {
  private preferBatch = false;
  private unsupported = false;

  /** @param repoRoot 저장소/linked worktree 경계 @param runner 취소를 전달하는 실제 Git 실행기 또는 테스트 경계 */
  constructor(private readonly repoRoot: string, private readonly runner: GraphLocalBranchRunner = runGit) {}

  /** 같은 fingerprint에서 새로 읽은 metadata도 큰 upstream의 다음 조회 전략에 반영한다. 데이터는 보관하지 않는다. */
  seedStrategy(branches: readonly LocalBranchStatus[]): void { this.preferBatch = shouldBatch(branches); }

  /** 현재 read가 한 native 조회로 시작하는지 알려 병렬 Graph 준비의 최대 Git 실행 수를 제한한다. */
  usesNativeSnapshot(): boolean { return !this.preferBatch || this.unsupported; }

  /**
   * 작은 목록과 첫 로드는 기존 단일 조회를 사용하고, 큰 공통 upstream 목록은 현재 ref로 일괄 계산한다.
   * @param signal 숨김·세대 교체 때 조회를 취소할 신호
   * @returns 기존 정렬·메타데이터·손상 ref 계약을 유지한 새 snapshot
   */
  async read(signal?: AbortSignal): Promise<GraphLocalBranchSnapshot> {
    signal?.throwIfAborted();
    let result: GraphLocalBranchSnapshot | undefined;
    if (this.preferBatch && !this.unsupported) {
      try { result = await this.readBatched(signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (isGitLifecycleError(error)) throw error;
        // 오류 문장은 Git locale에 따라 번역되므로 포맷 식별자가 포함된 진단으로만 판정한다.
        this.unsupported = error instanceof GitError && /\bahead-behind:/.test(error.stderr);
        logInfo("graph branch tracking fallback", { repoRoot: this.repoRoot,
          reason: this.unsupported ? "unsupportedGitFormat" : "snapshotReadChangedOrFailed" });
      }
    }
    result ??= await readGraphLocalBranchSnapshot(this.repoRoot, this.runner, undefined, signal);
    this.seedStrategy(result.branches);
    return result;
  }

  /**
   * 추적 계산을 뺀 행, upstream tip, 공통 기준점의 counts를 보통 세 프로세스로 새로 읽는다.
   * 긴 ref가 많으면 OS argv 상한을 넘지 않도록 counts 조회만 나눈다.
   * @param signal 현재 read 수명 @returns 지원하는 큰 목록이면 snapshot, 기준점이 너무 많으면 기존 조회 요청
   */
  private async readBatched(signal?: AbortSignal): Promise<GraphLocalBranchSnapshot | undefined> {
    const started = Date.now();
    const format = ["%(HEAD)", "%(refname:short)", "%(objectname)", "%(upstream:short)",
      "%(upstream)", "%(refname)", "%(committerdate:iso8601-strict)", "%(subject)"].join(FS);
    // 두 조회는 서로의 출력에 의존하지 않는다. 느린 프로세스 시작 비용을 직렬로 더하지 않는다.
    const [metadataRead, refRead] = await Promise.allSettled([
      this.runner(["for-each-ref", "--sort=-committerdate", `--format=${format}`, "refs/heads"], this.repoRoot, { signal }),
      this.runner(["for-each-ref", `--format=%(refname)${FS}%(objectname)`], this.repoRoot, { signal }),
    ]);
    signal?.throwIfAborted();
    // 다른 조회의 일반 오류가 먼저 끝나도 취소/timeout을 fallback 재시도로 바꾸지 않는다.
    for (const read of [metadataRead, refRead]) {
      if (read.status === "rejected" && isGitLifecycleError(read.reason)) throw read.reason;
    }
    if (metadataRead.status === "rejected") throw metadataRead.reason;
    if (refRead.status === "rejected") throw refRead.reason;
    const candidates = parseCandidates(metadataRead.value);
    const tracked = candidates.filter(candidate => candidate.upstreamRef);
    if (!tracked.length) return { branches: candidates.map(candidate => candidate.branch), invalidRefs: [] };
    // full ref만 열거하므로 custom fetch namespace와 로컬 upstream도 같은 기준으로 정확히 찾는다.
    const refs = parseRefTips(refRead.value);
    const bases = [...new Set(tracked.map(candidate => refs.get(candidate.upstreamRef)).filter((hash): hash is string => !!hash))];
    if (bases.length > MAX_BASES) {
      logInfo("graph branch tracking fallback", { repoRoot: this.repoRoot, reason: "tooManyBases", bases: bases.length });
      return undefined;
    }
    let counts = new Map<string, TrackingCounts>();
    if (bases.length) {
      const countFormat = ["%(refname)", "%(objectname)", ...bases.map(hash => `%(ahead-behind:${hash})`)].join(FS);
      const refsToCompare = tracked.filter(candidate => refs.has(candidate.upstreamRef)).map(candidate => candidate.fullRef);
      for (const batch of refArgumentBatches(refsToCompare)) {
        const current = parseTrackingCounts(await this.runner([
          "for-each-ref", `--format=${countFormat}`, ...batch,
        ], this.repoRoot, { signal }), bases.length);
        signal?.throwIfAborted();
        for (const [ref, value] of current) counts.set(ref, value);
      }
    }
    const baseIndexes = new Map(bases.map((hash, index) => [hash, index]));
    for (const candidate of tracked) {
      const upstream = refs.get(candidate.upstreamRef);
      if (!upstream) { candidate.branch.gone = true; continue; }
      const current = counts.get(candidate.fullRef), index = baseIndexes.get(upstream);
      // 조회 사이에 로컬 tip이 바뀌면 이전 메타데이터에 새 counts를 붙이지 않고 기존 조회로 다시 읽는다.
      if (!current || current.hash !== candidate.branch.hash || index === undefined) throw new Error("Branch tips changed during tracking read.");
      Object.assign(candidate.branch, current.pairs[index]);
    }
    logInfo("graph branch tracking batched", { repoRoot: this.repoRoot, branches: candidates.length,
      tracked: tracked.length, bases: bases.length, elapsedMs: Date.now() - started });
    return { branches: candidates.map(candidate => candidate.branch), invalidRefs: [] };
  }
}

/** @param branches 직전의 새 snapshot @returns 이력 차이 누적 작업량이 큰 소수 upstream 목록일 때만 true */
function shouldBatch(branches: readonly LocalBranchStatus[]): boolean {
  const tracked = branches.filter(branch => branch.upstream && !branch.gone);
  return tracked.length >= MIN_TRACKED_BRANCHES && new Set(tracked.map(branch => branch.upstream)).size <= MAX_BASES &&
    tracked.reduce((total, branch) => total + branch.ahead + branch.behind, 0) >= MIN_TRACKING_DISTANCE;
}

/**
 * @param refs 실제 upstream이 존재하는 추적 브랜치의 full ref @returns argv와 Windows quote 확장도 제한한 조회 묶음
 * 추적하지 않는 브랜치를 제외해 그 브랜치의 길거나 불완전한 독립 이력을 계산하지 않는다.
 */
function refArgumentBatches(refs: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [], bytes = 0;
  for (const ref of refs) {
    const size = Buffer.byteLength(ref) + (ref.match(/"/g)?.length ?? 0) + 3;
    if (size > MAX_REF_ARGUMENT_BYTES) throw new Error("A branch reference exceeds the batch argument limit.");
    if (batch.length && bytes + size > MAX_REF_ARGUMENT_BYTES) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(ref); bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** @param output 추적 계산을 생략한 for-each-ref 행 @returns 정렬을 보존한 새 UI 행과 full ref */
function parseCandidates(output: string): BranchCandidate[] {
  return output.split("\n").filter(Boolean).map(line => {
    const [head, name, hash, upstream, upstreamRef, fullRef, dateIso, subject] = line.split(FS);
    if (!name || !OID.test(hash ?? "") || !fullRef?.startsWith("refs/heads/") || dateIso === undefined) {
      throw new Error("Could not read branch tracking metadata.");
    }
    return { fullRef, upstreamRef, branch: { name, hash, upstream: upstream || undefined,
      current: head === "*", ahead: 0, behind: 0, gone: false, dateIso, subject: subject ?? "" } };
  });
}

/** @param output object를 열지 않은 full ref/OID 레코드 @returns 현재 upstream의 존재와 고정한 tip */
function parseRefTips(output: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of output.split("\n").filter(Boolean)) {
    const [ref, hash] = line.split(FS);
    if (!ref?.startsWith("refs/") || !OID.test(hash ?? "")) throw new Error("Could not read branch tracking references.");
    result.set(ref, hash);
  }
  return result;
}

/** @param output full ref/tip/기준점별 두 숫자 @param bases 포맷에 지정한 기준점 수 @returns 검증한 Git 이력 counts */
function parseTrackingCounts(output: string, bases: number): Map<string, TrackingCounts> {
  const result = new Map<string, TrackingCounts>();
  for (const line of output.split("\n").filter(Boolean)) {
    const [ref, hash, ...rawPairs] = line.split(FS);
    if (!ref?.startsWith("refs/heads/") || !OID.test(hash ?? "") || rawPairs.length !== bases) throw new Error("Could not read branch tracking counts.");
    const pairs = rawPairs.map(pair => {
      if (!/^\d+ \d+$/.test(pair)) throw new Error("Could not read branch tracking counts.");
      const [ahead, behind] = pair.split(" ").map(Number);
      if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) throw new Error("Could not read branch tracking counts.");
      return { ahead, behind };
    });
    result.set(ref, { hash, pairs });
  }
  return result;
}
