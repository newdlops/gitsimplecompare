import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { withGitConfigOverrides } from "./gitExec";
import { registerStatusIndex } from "./statusIndexOwnership";
import { awaitStatusRead, runColdStatusRead } from "./coldStatusScan";
import type { StatusIndexWarmCache } from "./statusIndexWarmCache";

type Logger = (event: string, fields: Record<string, unknown>) => void;
interface WarmupTask { key: string; controller: AbortController; completion: Promise<void> }
export interface StatusIndexWarmupSource {
  key: string; bytes: Buffer; mtimeMs: number;
  /** 원본 index의 경로·stage 의미가 유지된 경우에만 완료 값을 게시한다. */
  isCurrent: (signal: AbortSignal) => Promise<boolean>;
}

/**
 * 첫 전체 결과 뒤에만 별도 소유 index로 디렉터리 캐시를 준비한다.
 * - 화면 조회와 같은 index를 쓰지 않아 optional lock과 stat 갱신이 서로 경쟁하지 않는다.
 * - stage 변경·dispose는 진행 중 실행을 취소하고 실제 close 뒤에 임시 파일을 지운다.
 */
export class StatusIndexWarmup {
  private sourceKey?: string;
  private task?: WarmupTask;
  private completed?: { key: string; index?: string; directory?: string; cached?: boolean };
  private retryAfter = 0;
  private cleanup: Promise<void> = Promise.resolve();

  /** 저장소 루트·OUTPUT·선택적 세션 간 캐시만 주입해 VS Code 없이 재사용한다. */
  constructor(private readonly root: string, private readonly log: Logger, private readonly cache?: StatusIndexWarmCache) {}

  /** stage가 바뀌면 이전 작업을 중단하되 새 화면 조회는 close를 기다리지 않는다. */
  setSource(key: string | undefined): void {
    if (this.sourceKey === key) return;
    const completed = this.completed;
    this.sourceKey = key; this.completed = undefined; this.retryAfter = 0; this.task?.controller.abort();
    if (completed?.directory) this.cleanup = this.cleanup.then(() => rm(completed.directory!, { recursive: true, force: true })).catch(() => undefined);
  }

  /**
   * 같은 stage의 완료 값만 foreground 직전에 읽고 소유 임시 파일을 회수한다.
   * @returns 바이트가 있으면 복원하고, 빈 객체면 일반 Git 캐시 경로로 복구한다. undefined는 아직 준비 중이다.
   */
  async take(key: string | undefined): Promise<{ bytes?: Buffer } | undefined> {
    if (!key || this.completed?.key !== key) return undefined;
    const completed = this.completed; this.completed = undefined;
    try {
      if (completed.cached) return { bytes: (await this.cache?.load(this.root, key))?.bytes };
      return completed.index ? { bytes: await readFile(completed.index) } : {};
    } catch { return {}; }
    finally { if (completed.directory) await rm(completed.directory, { recursive: true, force: true }); }
  }

  /**
   * 첫 결과가 끝난 뒤 예약하고 저장소당 하나만 실행한다. 실패 재시도는 30초 간격으로 제한한다.
   * @param source 실제 index 경로와 stage 의미에 바인딩된 사본 및 완료 시점의 검증 함수
   */
  schedule(source: StatusIndexWarmupSource): void {
    this.setSource(source.key);
    if (this.completed?.key === source.key || (this.task?.key === source.key && !this.task.controller.signal.aborted)
      || Date.now() < this.retryAfter) return;
    this.retryAfter = Date.now() + 30000;
    const previous = this.task, controller = new AbortController();
    previous?.controller.abort();
    const task: WarmupTask = { key: source.key, controller, completion: Promise.resolve() };
    task.completion = (previous?.completion ?? Promise.resolve()).then(() => this.build(source, controller.signal))
      .catch(error => {
        if (!controller.signal.aborted) this.emit("private status index warmup failed", { repoRoot: this.root, reason: error instanceof Error ? error.name : "warmup-failed" });
      }).finally(() => { if (this.task === task) this.task = undefined; });
    this.task = task;
  }

  /** 소유 중인 실행의 close와 임시 경로 정리가 끝난 뒤 반환한다. */
  async dispose(): Promise<void> {
    this.setSource(undefined); this.task?.controller.abort(); await this.task?.completion;
    await this.cleanup; this.task = undefined; this.completed = undefined;
  }

  /**
   * 화면 반영 기회를 먼저 준 뒤 낮은 우선순위의 단일 Git 조회로 UNTR 캐시를 완성한다.
   * @param source 검증된 stage 사본 @param signal 새 stage·세션 종료와 연결된 취소 신호
   */
  private async build(source: StatusIndexWarmupSource, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    await delay(100, undefined, { signal });
    signal.throwIfAborted();
    const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-status-warmup-")), index = path.join(directory, "index");
    const unregister = registerStatusIndex(index);
    let keepDirectory = false;
    try {
      await writeFile(index, source.bytes, { mode: 0o600 });
      // 대기 중인 다른 root가 큰 Buffer를 계속 보유하지 않게 소유 사본을 디스크로 옮긴다.
      source.bytes = Buffer.alloc(0);
      await utimes(index, source.mtimeMs / 1000, Math.floor(source.mtimeMs / 1000));
      signal.throwIfAborted();
      this.emit("private status index warmup started", { repoRoot: this.root });
      await runColdStatusRead(["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=normal"], this.root,
        { signal, env: withGitConfigOverrides({ GIT_INDEX_FILE: index }, { "core.untrackedCache": "true", "core.splitIndex": "false", "core.fsmonitor": "false" }), allowPrivateIndexWrites: true }, 100);
      signal.throwIfAborted();
      if (this.sourceKey !== source.key || !await awaitStatusRead(source.isCurrent(signal), signal)) {
        this.emit("private status index warmup discarded", { repoRoot: this.root, reason: "source-changed" }); return;
      }
      const size = (await stat(index)).size;
      if (size > 32 * 1024 * 1024) {
        this.completed = { key: source.key };
        this.emit("private status index warmup discarded", { repoRoot: this.root, reason: "index-too-large" }); return;
      }
      signal.throwIfAborted();
      const persisted = this.cache ? await this.cache.store(this.root, source.key, index) : false;
      signal.throwIfAborted();
      if (this.sourceKey !== source.key) return;
      keepDirectory = !persisted;
      this.completed = persisted ? { key: source.key, cached: true } : { key: source.key, index, directory };
      this.emit("private status index warmup completed", { repoRoot: this.root, bytes: size, persisted, elapsedMs: Date.now() - started });
    } finally { unregister(); if (!keepDirectory) await rm(directory, { recursive: true, force: true }); }
  }

  /** 관찰 콜백 실패는 정상 상태 조회·캐시 준비 수명에 영향을 주지 않게 한다. */
  private emit(event: string, fields: Record<string, unknown>): void { try { this.log(event, fields); } catch { /* 관찰 실패는 무시한다. */ } }
}
