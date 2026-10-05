import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { realpathSync } from "node:fs";
import { readProcessIdentities, sameProcess, type ProcessIdentity } from "./processIdentity";

/** 민감한 Git 인자 없이 프로세스 정리 상태를 기록하는 주입 경계다. */
export type GitProcessLogger = (event: string, detail: Record<string, unknown>) => void;
export interface OwnedGitProcess {
  id: number; repoRoot: string; command: string; pid?: number; startedAt: number;
  readOnly: boolean; monitor?: boolean; state: "running" | "stopping"; stoppingAt?: number;
}
interface ProcessRecord extends OwnedGitProcess {
  canonicalRoot?: string;
  child: ChildProcess; group: boolean; reason?: string; members?: ProcessIdentity[];
  killTimer?: ReturnType<typeof setTimeout>; stopping?: Promise<void>;
  directClosed?: boolean; completion: Promise<void>; complete: () => void;
}

/**
 * 우리 실행기의 자식만 기록하고 close 확인 뒤에만 회수하는 실행 수명 레지스트리.
 * - 살아 있는 조회나 쓰기는 유휴 정리 대상으로 내보내지 않는다.
 * - POSIX의 별도 그룹을 검증하고 종료 후 PID가 재사용되면 추가 신호를 보내지 않는다.
 */
export class GitProcessRegistry {
  private readonly records = new Map<number, ProcessRecord>();
  private readonly activity = new Map<string, number>();
  private nextId = 0;
  private logger?: GitProcessLogger;
  private readonly mutationListeners = new Set<(root: string) => void>();

  /** 저수준 쓰기 완료도 공유 상태 세대를 무효화하도록 UI 없는 관찰 경계를 제공한다. */
  onDidFinishWrite(listener: (root: string) => void): () => void {
    this.mutationListeners.add(listener); return () => { this.mutationListeners.delete(listener); };
  }

  /** OUTPUT 연결은 상위 계층이 주입하며 더 최근 등록을 오래된 dispose가 지우지 않는다. */
  setLogger(logger: GitProcessLogger): () => void {
    this.logger = logger;
    return () => { if (this.logger === logger) this.logger = undefined; };
  }

  /** 실제 spawn 결과와 조회 목적을 등록한다. child 객체가 소유권의 최초 근거다. */
  register(child: ChildProcess, repoRoot: string, command: string, readOnly: boolean, group: boolean, monitor = false): number {
    const root = path.resolve(repoRoot), id = ++this.nextId;
    let complete!: () => void;
    const completion = new Promise<void>(resolve => { complete = resolve; });
    this.activity.set(root, Date.now());
    let canonicalRoot: string | undefined;
    if (monitor) try { canonicalRoot = realpathSync.native(root); } catch { /* 경로 증거가 없으면 별칭 소유권을 추측하지 않는다. */ }
    this.records.set(id, { id, child, repoRoot: root, canonicalRoot, command, readOnly, group, monitor, pid: child.pid, startedAt: Date.now(), state: "running", completion, complete });
    return id;
  }

  /** 부모 close 이후에도 검증한 자식이 남으면 종료 타이머와 소유 기록을 유지한다. */
  async closed(id: number): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    record.directClosed = true;
    await record.stopping;
    await this.confirmClosed(record);
    return record.completion;
  }

  /** 모든 검증 가능한 소유 자식의 종료가 확인된 경우에만 실행 슬롯을 반환한다. */
  private finish(record: ProcessRecord): void {
    clearTimeout(record.killTimer);
    this.activity.set(record.repoRoot, Date.now());
    this.records.delete(record.id); record.complete();
    if (!record.readOnly && !record.monitor) for (const listener of this.mutationListeners) {
      try { listener(record.repoRoot); } catch { /* 상태 구독 오류는 Git 결과를 바꾸지 않는다. */ }
    }
    if (record.state === "stopping") this.log("git process close confirmed", { ...this.detail(record), reason: record.reason });
  }

  /** 종료 대기가 길어진 조회가 같은 위치에서 무한히 겹치지 않도록 후속 실행을 막는다. */
  hasBlockedRead(repoRoot: string): boolean {
    return [...this.records.values()].some(record => record.readOnly && record.repoRoot === path.resolve(repoRoot)
      && record.state === "stopping" && Date.now() - (record.stoppingAt ?? Date.now()) > 2000);
  }

  /** 필요 없어진 조회만 TERM→KILL로 종료한다. 진행 중 쓰기는 별도의 명시적 취소만 처리한다. */
  requestStop(id: number, reason: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || (!record.readOnly && !record.monitor)) return Promise.resolve();
    if (record.stopping) return record.stopping;
    record.state = "stopping"; record.stoppingAt = Date.now(); record.reason = reason;
    this.log("git owned process termination requested", { ...this.detail(record), reason });
    record.stopping = this.terminate(record);
    return record.stopping;
  }

  /** 수동 정리 화면에는 소비자가 이미 해제된 조회만 사본으로 반환한다. */
  idleReads(): OwnedGitProcess[] {
    return [...this.records.values()].filter(record => record.readOnly && record.state === "stopping")
      .map(({ id, repoRoot, command, pid, startedAt, readOnly, state, stoppingAt }) => ({ id, repoRoot, command, pid, startedAt, readOnly, state, stoppingAt }));
  }

  /** 진행 중 조회·쓰기가 해당 저장소 또는 하위 경로를 사용하는지 확인한다. */
  isBusy(repoRoot: string): boolean {
    return [...this.records.values()].some(record => !record.monitor && containsPath(this.knownCanonicalRoot(repoRoot), this.knownCanonicalRoot(record.repoRoot)));
  }

  /** 포그라운드로 직접 생성해 child 객체를 보유한 감시자만 자동 정리 소유권을 인정한다. */
  ownsMonitor(pid: number, repoRoot: string): boolean {
    return [...this.records.values()].some(record => record.monitor && record.pid === pid
      && (record.repoRoot === path.resolve(repoRoot) || record.canonicalRoot === path.resolve(repoRoot)) && this.leaderAlive(record));
  }

  /** 이미 소비자가 해제된 읽기에만 종료를 재시도하고 실제 close가 확인된 경우 true를 반환한다. */
  async cleanupRead(id: number): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || !record.readOnly || record.state !== "stopping") return false;
    await this.escalate(record);
    if (!this.records.has(id)) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([record.completion.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); })]); }
    finally { clearTimeout(timer); }
  }

  /** 마지막 실제 Git 사용 시각을 반환한다. 한 번도 사용하지 않은 저장소는 알 수 없음이다. */
  lastUsed(repoRoot: string): number | undefined {
    const root = this.knownCanonicalRoot(repoRoot);
    const times = [...this.activity].filter(([item]) => this.knownCanonicalRoot(item) === root).map(([, time]) => time);
    return times.length ? Math.max(...times) : undefined;
  }

  /** 직접 소유한 감시자의 최초 realpath 증거만 써 /var·symlink 별칭의 활동 기록을 합친다. */
  private knownCanonicalRoot(repoRoot: string): string {
    const root = path.resolve(repoRoot);
    return [...this.records.values()].find(record => record.monitor && record.repoRoot === root)?.canonicalRoot ?? root;
  }

  /** 최근 사용한 저장소 목록으로 자동 정리의 범위를 제한한다. */
  roots(): string[] { return [...this.activity.keys()]; }

  /** 확장 종료 때 소유 조회·감시자의 실제 close까지 기다리며 쓰기·hook은 보호한다. */
  async dispose(): Promise<void> {
    const owned = [...this.records.values()].filter(record => record.readOnly || record.monitor);
    await Promise.all(owned.map(async record => { await this.requestStop(record.id, "extension-dispose"); await record.completion; }));
  }

  /** 정상 Host exit의 동기 경계에서는 직접 소유한 살아 있는 child/group에만 TERM을 전달한다. */
  stopOnHostExit(): void {
    for (const record of this.records.values()) {
      if ((!record.readOnly && !record.monitor) || !this.leaderAlive(record)) continue;
      try { if (record.group && record.pid) process.kill(-record.pid, "SIGTERM"); else record.child.kill("SIGTERM"); }
      catch { /* OS가 이미 종료한 직접 자식에는 추가 신호를 보내지 않는다. */ }
    }
  }

  /** 최초 그룹 검증이 실패하면 소유한 child만 종료하고 불확실한 다른 PID는 보호한다. */
  private async terminate(record: ProcessRecord): Promise<void> {
    try {
      if (record.group && record.pid) {
        const inspectionStartedAt = Date.now();
        const processes = await readProcessIdentities({ processGroup: record.pid });
        this.log("git owned process group inspected", { ...this.detail(record), inspectionMs: Date.now() - inspectionStartedAt, processCount: processes.length });
        const leader = processes.find(item => item.pid === record.pid);
        if (this.leaderAlive(record) && leader?.pgid === record.pid && leader.uid === process.getuid?.()) {
          record.members = processes.filter(item => item.pgid === record.pid && item.uid === leader.uid);
          process.kill(-record.pid, "SIGTERM");
        } else if (this.leaderAlive(record)) record.child.kill("SIGTERM");
      } else if (this.leaderAlive(record)) record.child.kill("SIGTERM");
    } catch (error) {
      if (this.leaderAlive(record)) record.child.kill("SIGTERM");
      this.log("git process group termination fallback", { ...this.detail(record), reason: error instanceof Error ? error.name : "inspection-failed" });
    }
    if (!this.records.has(record.id)) return;
    record.killTimer = setTimeout(() => { record.killTimer = undefined; void this.escalate(record); }, 1000);
    record.killTimer.unref();
  }

  /** 1초 뒤에도 남은 최초 그룹 구성원만 시작 시각을 재대조해 강제 종료한다. */
  private async escalate(record: ProcessRecord): Promise<void> {
    if (!this.records.has(record.id)) return;
    try {
      if (record.members?.length) {
        // 기존 구성원 PID와 현재 그룹을 함께 읽어 TERM 이후 생성된 자식도 놓치지 않는다.
        const current = await readProcessIdentities({ pids: record.members.map(member => member.pid), processGroup: record.group ? record.pid : undefined });
        // 살아 있는 최초 구성원이 그룹 소유권을 입증할 때만 TERM 이후 생성된 같은 그룹 자식도 포함한다.
        if (record.group && record.members.some(member => sameProcess(member, current.find(item => item.pid === member.pid)))) {
          const known = new Set(record.members.map(item => item.pid));
          record.members.push(...current.filter(item => item.pgid === record.pid && item.uid === process.getuid?.() && !known.has(item.pid)));
        }
        for (const member of record.members) {
          if (!sameProcess(member, current.find(item => item.pid === member.pid))) continue;
          try { process.kill(member.pid, "SIGKILL"); } catch { /* 조회 뒤 자연 종료한 구성원이다. */ }
        }
      } else if (this.leaderAlive(record)) record.child.kill("SIGKILL");
      this.log("git owned process forced termination requested", this.detail(record));
    } catch {
      if (this.leaderAlive(record)) record.child.kill("SIGKILL");
      this.log("git descendant ownership unavailable", this.detail(record));
    }
    await this.confirmClosed(record);
  }

  /** PID 시작 시각이 같은 자식이 남은 동안에는 부모 close만으로 정리를 완료하지 않는다. */
  private async confirmClosed(record: ProcessRecord): Promise<void> {
    if (!record.directClosed || !this.records.has(record.id)) return;
    const descendants = record.members?.filter(item => item.pid !== record.pid) ?? [];
    if (!descendants.length) { this.finish(record); return; }
    try {
      const current = await readProcessIdentities({ pids: descendants.map(member => member.pid) });
      if (!descendants.some(member => sameProcess(member, current.find(item => item.pid === member.pid)))) { this.finish(record); return; }
    } catch { this.log("git descendant close inspection unavailable", this.detail(record)); }
    // 부모 stdio와 독립적인 자식까지 처리하며 관찰할 수 없는 PID에는 신호를 보내지 않는다.
    if (record.killTimer) return;
    record.killTimer = setTimeout(() => { record.killTimer = undefined; void this.escalate(record); }, 1000);
    record.killTimer.unref();
  }

  /** Node가 종료를 관찰한 child에는 PID 재사용 위험 때문에 다시 신호를 보내지 않는다. */
  private leaderAlive(record: ProcessRecord): boolean { return record.child.exitCode === null && record.child.signalCode === null && !!record.child.pid; }

  /** 로그에는 자격 증명이 들어갈 수 있는 인자·환경·출력을 포함하지 않는다. */
  private detail(record: ProcessRecord): Record<string, unknown> {
    return { repoRoot: record.repoRoot, pid: record.pid, command: record.command, elapsedMs: Date.now() - record.startedAt };
  }

  /** 관찰 실패가 Git 결과를 바꾸지 않도록 보호한다. */
  private log(event: string, detail: Record<string, unknown>): void { try { this.logger?.(event, detail); } catch { /* 관찰 오류는 무시한다. */ } }
}

/** 하위 경로 사용 여부를 문자열 접두사 충돌 없이 확인한다. */
export function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** 모든 Git 실행 방식과 정리 명령이 공유하는 유일한 소유 실행 기록이다. */
export const gitProcesses = new GitProcessRegistry();
