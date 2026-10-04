import { sameProcess, type ProcessIdentity } from "./processIdentity";
import { type GitProcessLogger } from "./gitProcessRegistry";

/** OS 검사에서 저장소·소켓까지 확인한 감시 프로세스다. */
export interface GitMonitorProcess {
  identity: ProcessIdentity; repoRoot: string; socket: string; socketIdentity: string;
  owned: boolean; protectedReason?: string;
}
/** 한 시점의 보호 판단을 함께 담아 불완전한 OS 관찰을 유휴로 오인하지 않는다. */
export interface GitMonitorSnapshot { monitors: GitMonitorProcess[]; complete: boolean; reason?: string }
export interface IdleGitCandidate extends GitMonitorProcess { idleSince: number }
export interface GitCleanupResult { stopped: number; kept: number; failed: number }

/** 프로세스·활성 사용 관찰과 공식 stop만 OS 어댑터에서 제공한다. */
export interface IdleGitCleanupDeps {
  inspect(): Promise<GitMonitorSnapshot>;
  stop(candidate: IdleGitCandidate, canStop: () => boolean): Promise<void>;
  busy(root: string): boolean;
  lastUsed(root: string): number | undefined;
  log: GitProcessLogger;
  now?: () => number;
  enabled?: (root: string) => boolean;
}

/** 실제 사용과 PID 재검증에 기반해 유휴 감시자를 선택하고 종료하는 재사용 가능한 서비스다. */
export class IdleGitCleanup {
  private readonly idle = new Map<string, { at: number; identity: ProcessIdentity; socketIdentity: string }>();
  private revision = 0;
  private cleaning = false;
  constructor(private readonly deps: IdleGitCleanupDeps) {}

  /** 최초 관찰부터 연속으로 사용되지 않은 후보만 돌려준다. */
  async candidates(minutes: number, automatic = false): Promise<IdleGitCandidate[]> {
    const snapshot = await this.deps.inspect(), now = this.deps.now?.() ?? Date.now();
    if (!snapshot.complete) {
      this.reset();
      this.deps.log("git idle inspection skipped", { reason: snapshot.reason ?? "incomplete-process-mapping" });
      return [];
    }
    const result: IdleGitCandidate[] = [], seen = new Set<string>();
    for (const monitor of snapshot.monitors) {
      const key = this.key(monitor); seen.add(key);
      if (monitor.protectedReason || this.deps.busy(monitor.repoRoot)) {
        if (this.idle.delete(key)) this.deps.log("git monitor activity resumed", { repoRoot: monitor.repoRoot, pid: monitor.identity.pid, reason: monitor.protectedReason ?? "active-git" });
        continue;
      }
      const previous = this.idle.get(key);
      if (!previous || !sameProcess(previous.identity, monitor.identity) || previous.socketIdentity !== monitor.socketIdentity) {
        this.idle.set(key, { at: now, identity: monitor.identity, socketIdentity: monitor.socketIdentity });
        this.deps.log("git monitor inactivity observed", { repoRoot: monitor.repoRoot, pid: monitor.identity.pid });
      }
      const idleSince = Math.max(this.idle.get(key)!.at, this.deps.lastUsed(monitor.repoRoot) ?? 0);
      if (now - idleSince < Math.max(1, Math.min(1440, minutes)) * 60_000) continue;
      if (automatic && (!monitor.owned || this.deps.enabled?.(monitor.repoRoot) === false)) continue;
      result.push({ ...monitor, idleSince });
    }
    for (const key of this.idle.keys()) if (!seen.has(key)) this.idle.delete(key);
    return result;
  }

  /** UI 선택 이후 다시 조회해 사용 중이거나 교체된 프로세스를 보호한다. */
  async cleanup(selected: IdleGitCandidate[], minutes: number, automatic = false, signal?: AbortSignal): Promise<GitCleanupResult> {
    const result: GitCleanupResult = { stopped: 0, kept: 0, failed: 0 };
    if (this.cleaning) return { ...result, kept: selected.length };
    this.cleaning = true;
    const revision = this.revision;
    try {
    for (const candidate of selected) {
      if (signal?.aborted || (automatic && this.deps.enabled?.(candidate.repoRoot) === false)) { result.kept++; continue; }
      try {
        const current = (await this.candidates(minutes, automatic)).find(item => this.matches(candidate, item));
        if (!current || signal?.aborted || this.deps.busy(candidate.repoRoot)) {
          result.kept++;
          this.deps.log("git idle candidate preserved", { repoRoot: candidate.repoRoot, pid: candidate.identity.pid, reason: "activity-or-ownership-changed" });
          continue;
        }
        this.deps.log("git idle cleanup started", { repoRoot: current.repoRoot, pid: current.identity.pid, automatic });
        await this.deps.stop(current, () => !signal?.aborted && revision === this.revision
          && !this.deps.busy(current.repoRoot) && (!automatic || this.deps.enabled?.(current.repoRoot) !== false)
          && (this.deps.now?.() ?? Date.now()) - Math.max(current.idleSince, this.deps.lastUsed(current.repoRoot) ?? 0) >= Math.max(1, Math.min(1440, minutes)) * 60_000);
        this.idle.delete(this.key(current)); result.stopped++;
        this.deps.log("git idle cleanup close confirmed", { repoRoot: current.repoRoot, pid: current.identity.pid });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          result.kept++; this.deps.log("git idle candidate preserved", { repoRoot: candidate.repoRoot, pid: candidate.identity.pid, reason: "activity-or-cleanup-cancelled" }); continue;
        }
        result.failed++;
        this.deps.log("git idle cleanup failed", { repoRoot: candidate.repoRoot, pid: candidate.identity.pid, reason: error instanceof Error ? error.message : "stop-failed" });
      }
    }
    return result;
    } finally { this.cleaning = false; }
  }

  /** 사용 재개·설정 해제·dispose 때 오래된 유휴 판정을 폐기한다. */
  reset(): void { this.revision++; this.idle.clear(); }

  /** UI가 원본 PID가 아닌 동일한 실제 프로세스를 골랐는지 검증한다. */
  private matches(before: GitMonitorProcess, after: GitMonitorProcess): boolean {
    return sameProcess(before.identity, after.identity) && before.repoRoot === after.repoRoot && before.socket === after.socket && before.socketIdentity === after.socketIdentity;
  }

  /** 같은 저장소의 소켓 교체를 구분하기 위해 저장소와 소켓을 키로 사용한다. */
  private key(monitor: GitMonitorProcess): string { return `${monitor.repoRoot}\0${monitor.socket}`; }
}
