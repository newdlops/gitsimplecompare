import { lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { GitMonitorSnapshot } from "./idleGitCleanup";

interface StoredInspection {
  schema: 1; uid: number; at: number; retryAt: number; failures: number; snapshot: GitMonitorSnapshot;
}

/**
 * 같은 사용자의 여러 Extension Host가 OS 프로세스/소켓 관찰을 한 번만 실행하게 한다.
 * - 공유 파일은 후보 관찰 전용이다. 실제 종료의 사용/소유권 판정에는 사용하지 않는다.
 * - PID가 살아 있는 lease는 만료 시간만으로 훔치지 않아 느린 검사도 중복되지 않는다.
 */
export class SharedMonitorInspection {
  private pending?: Promise<GitMonitorSnapshot>;
  private readonly uid = process.getuid?.() ?? -1;

  /**
   * @param directory 사용자 전용 0700 임시 디렉터리. 모든 창에 같은 경로를 전달한다.
   * @param load 창별 보호/소유권을 포함하지 않는 실제 OS 관찰
   * @param now 완료 캐시와 재시도 시각을 평가하는 시계
   */
  constructor(private readonly directory: string, private readonly load: () => Promise<GitMonitorSnapshot>, private readonly now = Date.now) {}

  /** 동일 창의 진행 중 소비자도 합치되 각 호출에 복사본을 반환한다. */
  async read(): Promise<GitMonitorSnapshot> {
    const pending = this.pending ??= this.readOnce().finally(() => { if (this.pending === pending) this.pending = undefined; });
    return structuredClone(await pending);
  }

  /** 완료 파일을 먼저 확인하고 atomic mkdir lease를 획득한 창만 비용 큰 관찰을 수행한다. */
  private async readOnce(): Promise<GitMonitorSnapshot> {
    const deadline = Date.now() + 30_000;
    let previous: StoredInspection | undefined;
    const token = `${process.pid}-${randomUUID()}.json`;
    const lease = path.join(this.directory, "lease"), owner = path.join(lease, token);
    try {
      await this.prepareDirectory();
      for (;;) {
        previous = await this.readStored();
        if (previous && this.now() >= previous.at && this.now() < previous.retryAt) {
          return { ...previous.snapshot, diagnostic: { ...previous.snapshot.diagnostic,
            source: previous.snapshot.complete ? "shared" : "backoff", retryAfterMs: previous.retryAt - this.now() } };
        }
        try {
          await mkdir(lease, { mode: 0o700 });
          await writeFile(owner, "owned", { flag: "wx", mode: 0o600 });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await this.reclaimDeadLease(lease);
          if (Date.now() >= deadline) return unavailable("shared-inspection-busy");
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      try {
        // 다른 창이 완료 파일을 쓴 직후 lease를 넘겨준 경우 중복 조회를 시작하지 않는다.
        const current = await this.readStored();
        if (current && this.now() >= current.at && this.now() < current.retryAt) return { ...current.snapshot,
          diagnostic: { ...current.snapshot.diagnostic, source: current.snapshot.complete ? "shared" : "backoff", retryAfterMs: current.retryAt - this.now() } };
        const at = this.now();
        const snapshot = await this.load();
        const failures = snapshot.complete ? 0 : Math.min(4, (previous?.failures ?? 0) + 1);
        const retryAt = snapshot.complete ? at + 15_000 : this.now() + 60_000 * 2 ** (failures - 1);
        const value: StoredInspection = { schema: 1, uid: this.uid, at, retryAt, failures, snapshot };
        const temporary = path.join(this.directory, `${token}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
          await rename(temporary, path.join(this.directory, "snapshot.json"));
        } finally { await unlink(temporary).catch(() => undefined); }
        return { ...snapshot, diagnostic: { ...snapshot.diagnostic, source: "fresh", retryAfterMs: Math.max(0, retryAt - this.now()) } };
      } finally {
        // 자신의 token만 제거한다. 다른 창이 새로 획득한 lease는 재귀 삭제하지 않는다.
        await unlink(owner).catch(() => undefined);
        await rmdir(lease).catch(() => undefined);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { ...unavailable("shared-inspection-storage-unavailable"), diagnostic: { stage: "shared-inspection", code: code && /^[A-Z0-9_]+$/.test(code) ? code : "INSPECTION_ERROR" } };
    }
  }

  /** 공유 경로가 본인 전용 일반 디렉터리인지 확인하며 symlink·다른 사용자·열린 권한은 거부한다. */
  private async prepareDirectory(): Promise<void> {
    await mkdir(this.directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.uid !== this.uid || (info.mode & 0o077)) throw new Error("Private inspection directory unavailable.");
  }

  /** 완료 전 쓰기·이전 schema·손상 데이터는 캐시 부재로 처리하여 새 관찰로 복구한다. */
  private async readStored(): Promise<StoredInspection | undefined> {
    try {
      const file = path.join(this.directory, "snapshot.json"), info = await lstat(file);
      if (!info.isFile() || info.uid !== this.uid || (info.mode & 0o077) || info.size > 2 * 1024 * 1024) return undefined;
      const value = JSON.parse(await readFile(file, "utf8")) as StoredInspection;
      if (value.schema !== 1 || value.uid !== this.uid || !Number.isFinite(value.at) || !Number.isFinite(value.retryAt)
        || !Number.isInteger(value.failures) || value.failures < 0 || value.failures > 4 || !validSnapshot(value.snapshot)) return undefined;
      return value;
    } catch { return undefined; }
  }

  /** 죽은 PID의 고유 token을 지운 호출만 빈 lease를 제거하여 동시 stale 회수 경쟁을 막는다. */
  private async reclaimDeadLease(lease: string): Promise<void> {
    try {
      const info = await lstat(lease);
      if (!info.isDirectory() || info.uid !== this.uid || (info.mode & 0o077)) throw new Error("Invalid inspection lease.");
      const names = await readdir(lease);
      if (!names.length) {
        // mkdir 직후 token을 쓰는 창과 경쟁하지 않는다. 비정상 종료로 남은 빈 directory만 회수한다.
        if (Date.now() - info.mtimeMs > 30_000) await rmdir(lease);
        return;
      }
      if (names.length !== 1) return;
      const pid = Number(/^(\d+)-[^/]+\.json$/.exec(names[0])?.[1]);
      if (!Number.isInteger(pid) || pid <= 0 || running(pid)) return;
      await unlink(path.join(lease, names[0]));
      await rmdir(lease);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
}

/** kill(0)은 종료하지 않으며 접근 불가 PID는 살아 있는 소유자로 보수적으로 보호한다. */
function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** 필수 식별 데이터 없는 공유 JSON을 OS 관찰로 취급하지 않는다. */
function validSnapshot(value: GitMonitorSnapshot): boolean {
  return !!value && typeof value.complete === "boolean" && Array.isArray(value.monitors) && value.monitors.every(item => {
    const id = item?.identity;
    return id && [id.pid, id.ppid, id.pgid, id.uid].every(Number.isInteger) && typeof id.started === "string" && typeof id.executable === "string"
      && typeof item.repoRoot === "string" && typeof item.socket === "string" && typeof item.socketIdentity === "string";
  }) && (value.observedCode === undefined || Array.isArray(value.observedCode));
}

/** 공유 경계가 불완전하면 감시자 후보를 반환하지 않아 정리를 보류한다. */
function unavailable(reason: string): GitMonitorSnapshot { return { complete: false, monitors: [], reason }; }
