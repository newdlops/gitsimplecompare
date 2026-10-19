// 충돌과 관련된 선행 PR 후보를 찾고 실제 최종 tree로 적용 순서를 검증한다.
import type { GhExecute } from "./ghRunner";
import { PullRequestDependencyGit } from "./pullRequestDependencyGit";
import { lookupPullRequestDependencies, lookupPullRequestDependencyDetails } from "./pullRequestDependencyLookup";
import type { PullRequestInfo } from "./pullRequestInfo";
import { readGitCommitCheckoutIdentity } from "./repositoryIdentity";
import { logError, logInfo } from "../ui/outputLog";
import type { PullRequestDependencyCandidate, PullRequestDependencyInput, PullRequestDependencyReason,
  PullRequestDependencyReport } from "./pullRequestDependencies";

/** 진단은 최대 4개 PR만 모의 적용하고, 네트워크·Git 전체를 하나의 취소 수명으로 묶는다. */
export class PullRequestDependencyService {
  constructor(public readonly repoRoot: string, private readonly execute?: GhExecute, private readonly timeoutMs = 15_000) {}

  /**
   * 실제 작업을 재생하지 않고 원래 HEAD와 PR snapshot으로 선행 후보·근거·확인 수준을 돌려준다.
   * @param input 선택된 PR, 이미 읽은 목록과 충돌 발생 전 HEAD @returns 부분 실패는 limitations에 기록한다.
   */
  async analyze(input: PullRequestDependencyInput): Promise<PullRequestDependencyReport> {
    const controller = new AbortController();
    const cancel = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new Error("PR prerequisite analysis timed out.")), this.timeoutMs);
    const started = Date.now();
    let partial: PullRequestDependencyReport | undefined;
    try { return await this.inspect(input, controller.signal, report => { partial = report; }); }
    catch (error) {
      if (!input.signal?.aborted && controller.signal.aborted && partial) {
        if (!partial.limitations.includes("simulation")) partial.limitations.push("simulation");
        logInfo("PR prerequisite inspection reached its deadline", { repoRoot: this.repoRoot, number: input.pr.number, candidates: partial.candidates.length });
        return partial;
      }
      throw error;
    }
    finally {
      clearTimeout(timer); input.signal?.removeEventListener("abort", cancel);
      logInfo("PR prerequisite analysis finished", { repoRoot: this.repoRoot, number: input.pr.number, elapsedMs: Date.now() - started });
    }
  }

  /** 원래 checkout을 읽고 후보 발견·세부 조회·tree 검증을 순서대로 조립한다. */
  private async inspect(input: PullRequestDependencyInput, signal: AbortSignal,
    onReport: (report: PullRequestDependencyReport) => void): Promise<PullRequestDependencyReport> {
    const checkout = await readGitCommitCheckoutIdentity(this.repoRoot, signal);
    const beforeHead = input.beforeHead || checkout.head;
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(beforeHead)) throw new Error("Invalid PR prerequisite target.");
    const report: PullRequestDependencyReport = { prNumber: input.pr.number, branch: input.branch || checkout.branch,
      beforeHead, conflicts: [], candidates: [], limitations: [] };
    onReport(report);
    const git = new PullRequestDependencyGit(this.repoRoot, { signal, readTimeoutMs: 8_000, maxBuffer: 2 * 1024 * 1024 });
    const source = await git.plan(input.pr);
    const baseline = source ? await git.merge(source, beforeHead) : undefined;
    if (!source) report.limitations.push("source");
    else if (!baseline) report.limitations.push("simulation");
    report.conflicts = baseline?.conflicts || [];
    const history = source ? await git.history(source, beforeHead, report.conflicts) : [];
    if (history.length === 12 || report.conflicts.length > 8) report.limitations.push("limit");
    const known = input.knownPullRequests || [];
    const candidates = new Map<number, PullRequestDependencyCandidate>();
    /** 같은 PR의 여러 근거를 합치고 자기 참조와 잘못된 번호를 제외한다. */
    const add = (pr: PullRequestInfo, reason: PullRequestDependencyReason, hash?: string) => {
      if (pr.number === input.pr.number || !Number.isSafeInteger(pr.number) || pr.number <= 0) return;
      let candidate = candidates.get(pr.number);
      if (!candidate) {
        candidate = { pr, reasons: [], sourceCommits: [], status: "unverified" };
        candidates.set(pr.number, candidate);
        if (report.candidates.length < 4) report.candidates.push(candidate);
      }
      if (!candidate.reasons.includes(reason)) candidate.reasons.push(reason);
      if (hash && !candidate.sourceCommits.includes(hash)) candidate.sourceCommits.push(hash);
    };
    for (const pr of known) if (pr.headRefName === input.pr.baseRefName) add(pr, "stack");
    const missing: string[] = [];
    for (const hash of history) {
      const matches = known.filter(pr => pr.mergeHash === hash || pr.headHash === hash || pr.commitHashes.includes(hash));
      if (!matches.length) missing.push(hash);
      for (const pr of matches) add(pr, "history", hash);
    }
    const declared: number[] = [];
    // 목록에 이미 있는 parent와 commit 연결은 네트워크 재조회 없이 재사용한다.
    if (missing.length || !candidates.size) {
      try {
        const lookup = await lookupPullRequestDependencies(this.repoRoot, input.pr, missing, signal, this.execute);
        for (const pr of lookup.parents) add(pr, "stack");
        for (const [hash, prs] of lookup.associated) for (const pr of prs) add(pr, "history", hash);
        declared.push(...lookup.declared);
        for (const number of declared) {
          const pr = known.find(pr => pr.number === number);
          if (pr) add(pr, "declared");
        }
      } catch (error) { this.recordLookupFailure(error, report, signal); }
    }
    const detailsNeeded = [...new Set([...declared.filter(number => !candidates.has(number)),
      ...[...candidates.values()].filter(candidate => candidate.pr.commitHashesComplete === false).map(candidate => candidate.pr.number)])];
    if (detailsNeeded.length) {
      try {
        const details = await lookupPullRequestDependencyDetails(this.repoRoot, detailsNeeded, signal, this.execute);
        for (const pr of details) {
          const previous = candidates.get(pr.number);
          if (previous) previous.pr = pr;
          if (declared.includes(pr.number)) add(pr, "declared");
        }
      } catch (error) { this.recordLookupFailure(error, report, signal); }
    }
    const sorted = [...candidates.values()].sort((a, b) =>
      Number(b.reasons.includes("declared")) - Number(a.reasons.includes("declared")) ||
      Number(b.reasons.includes("stack")) - Number(a.reasons.includes("stack")) ||
      history.indexOf(a.sourceCommits[0]) - history.indexOf(b.sourceCommits[0]));
    if (sorted.length > 4 || detailsNeeded.length > 4) report.limitations.push("limit");
    report.candidates = sorted.slice(0, 4);
    const targetTree = await git.tree(beforeHead);
    for (const candidate of report.candidates) {
      signal.throwIfAborted();
      const plan = await git.plan(candidate.pr, true);
      const merged = plan ? await git.merge(plan, beforeHead) : undefined;
      if (merged?.tree === targetTree) candidate.status = "present";
      else if (merged?.tree && source && baseline?.conflicts.length) {
        const simulated = await git.simulationCommit(merged.tree, beforeHead);
        const after = await git.merge(source, simulated);
        if (after) {
          candidate.remainingConflicts = after.conflicts.length;
          candidate.status = after.tree ? "resolves" : after.conflicts.length < baseline.conflicts.length ? "reduces" : "unchanged";
        }
      }
    }
    logInfo("PR prerequisite candidates inspected", { repoRoot: this.repoRoot, number: input.pr.number,
      beforeHead, conflictPaths: report.conflicts.slice(0, 8),
      candidates: report.candidates.map(candidate => ({ number: candidate.pr.number, title: candidate.pr.title,
        status: candidate.status, reasons: candidate.reasons, remainingConflicts: candidate.remainingConflicts })),
      limitations: report.limitations });
    return report;
  }

  /** 권한·오프라인 실패는 후보 없음과 구분하며 사용자 취소와 전체 시간 제한은 즉시 전파한다. */
  private recordLookupFailure(error: unknown, report: PullRequestDependencyReport, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (!report.limitations.includes("github")) report.limitations.push("github");
    logError("PR prerequisite metadata unavailable", error, { repoRoot: this.repoRoot, number: report.prNumber });
  }
}
