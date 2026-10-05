import path from "node:path";
import { FileHistoryService, type FileHistoryEntry } from "./fileHistoryService";
import { readFileHistoryContext, type FileHistoryContext } from "./fileHistoryContext";
import { SharedGitRead } from "./sharedGitRead";
import { PriorityReadQueue } from "../utils/priorityReadQueue";
import { FileHistoryDiskStorage } from "./fileHistoryStorage";

/** UI와 무관하게 조회/보존을 대체할 수 있는 이력 서비스 경계다. */
export interface FileHistoryReader {
  context(root: string, file: string, signal: AbortSignal): Promise<FileHistoryContext>;
  history(root: string, file: string, revision: string, signal: AbortSignal, onProgress?: (entries: FileHistoryEntry[]) => void): Promise<FileHistoryEntry[]>;
  dates(root: string, entries: FileHistoryEntry[], signal: AbortSignal): Promise<FileHistoryEntry[]>;
}

/** 검증한 같은 HEAD/config의 전체 이력만 세션을 넘어 보존하는 선택적인 저장소다. */
export interface FileHistoryStorage {
  load(root: string, file: string, version: string): Promise<{ commits: FileHistoryEntry[]; loadedAt: number } | undefined>;
  store(root: string, file: string, version: string, commits: FileHistoryEntry[], loadedAt: number): Promise<void>;
}
export interface FileHistorySnapshot { repoRoot: string; path: string; commits: FileHistoryEntry[]; loadedAt: number; source: "git" | "memory" | "disk"; loading?: boolean }
interface Ready { context: FileHistoryContext; commits: FileHistoryEntry[]; loadedAt: number; bytes: number }
interface State { root: string; file: string; at: number; ready?: Ready; force: boolean; read: SharedGitRead<FileHistorySnapshot>; listeners: Set<(snapshot: FileHistorySnapshot) => void> }
/** 취소는 소비자별이고 progress는 표시 전용이다. force만 완성 캐시를 우회한다. */
export interface FileHistoryReadOptions { signal?: AbortSignal; force?: boolean; onProgress?: (snapshot: FileHistorySnapshot) => void }
const production: FileHistoryReader = {
  context: readFileHistoryContext,
  history: (root, file, revision, signal, onProgress) => new FileHistoryService(root).listFileHistory(file, 60, { revision, signal, onProgress }),
  dates: (root, entries, signal) => new FileHistoryService(root).refreshRelativeDates(entries, signal),
};

/**
 * 파일별 조회 공유·취소·HEAD 검증·유한 캐시를 소유하는 VS Code 비의존 서비스다.
 * 실제 log는 두 개까지만 겹치며, 취소한 이전 실행의 close 뒤 같은 파일의 새 세대를 시작한다.
 */
export class FileHistoryReadCache {
  private readonly states = new Map<string, State>();
  private readonly queue = new PriorityReadQueue(2);
  private disposed = false;

  /** reader·정책·OUTPUT·저장 공간은 조립 경계에서 주입하며 테스트도 같은 실제 수명을 실행한다. */
  constructor(private readonly reader: FileHistoryReader = production,
    private readonly cancelUnused: (root: string) => boolean = () => true,
    private readonly log: (event: string, fields: Record<string, unknown>) => void = () => undefined,
    private readonly storage?: FileHistoryStorage) {}

  /**
   * context는 매번 확인하고 불변 이력이 같으면 전체 rename 탐색 대신 상대 시각만 읽는다.
   * @param options force는 명시 전체 재조회다. 일반 새로고침은 HEAD/config로 최신 여부를 판정한다.
   * @returns 호출자별 독립 snapshot. 마지막 취소 소비자는 실제 Git도 해제한다.
   */
  async read(root: string, file: string, options: FileHistoryReadOptions = {}): Promise<FileHistorySnapshot> {
    if (this.disposed) throw new DOMException("File history reader was disposed.", "AbortError");
    this.prune();
    const key = `${path.resolve(root)}\0${file}`;
    let state = this.states.get(key);
    if (!state) {
      const next = { root, file, at: Date.now(), force: false, read: undefined!, listeners: new Set() } as State;
      next.read = new SharedGitRead(signal => this.queue.run(() => this.load(next, signal), signal), snapshot => structuredClone(snapshot), () => this.cancelUnused(root));
      state = next; this.states.set(key, state);
    }
    if (options.force) state.force = true;
    state.at = Date.now();
    const listener = (snapshot: FileHistorySnapshot) => { if (!options.signal?.aborted) options.onProgress?.(structuredClone(snapshot)); };
    if (options.onProgress) state.listeners.add(listener);
    try { return await state.read.read({ signal: options.signal, force: options.force, maxCacheAgeMs: 0 }); }
    finally { state.listeners.delete(listener); this.prune(); }
  }

  /** Host 수명 종료에서 모든 소비자를 해제하고 실제 close까지 기다린다. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const states = [...this.states.values()]; this.states.clear();
    await Promise.all(states.map(state => state.read.dispose()));
  }

  /** 검증한 불변 이력만 보관하고 조회 중 HEAD/config가 바뀌면 최신 상태로 한 번 다시 읽는다. */
  private async load(state: State, signal: AbortSignal): Promise<FileHistorySnapshot> {
    const force = state.force; if (force) state.force = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const context = await this.reader.context(state.root, state.file, signal);
      signal.throwIfAborted();
      const ready = !force && state.ready?.context.key === context.key ? state.ready : undefined;
      const stored = !force && !ready ? await this.storage?.load(state.root, state.file, context.key).catch(() => undefined) : undefined;
      signal.throwIfAborted();
      const cached = ready ?? stored;
      const source = ready ? "memory" : stored ? "disk" : "git";
      const progress = (commits: FileHistoryEntry[]) => {
        if (signal.aborted) return;
        const snapshot: FileHistorySnapshot = { repoRoot: state.root, path: state.file, commits, source: "git", loadedAt: Date.now(), loading: true };
        for (const listener of state.listeners) { try { listener(snapshot); } catch { /* 표시 실패는 조회와 분리한다. */ } }
        if (commits.length) this.emit("file history first commits ready", { repoRoot: state.root, path: state.file, commits: commits.length });
      };
      if (!cached) progress([]);
      const commits = cached ? await this.reader.dates(state.root, cached.commits, signal)
        : await this.reader.history(state.root, state.file, context.revision, signal, progress);
      const after = await this.reader.context(state.root, state.file, signal);
      signal.throwIfAborted();
      if (context.key !== after.key) {
        this.emit("file history context changed", { repoRoot: state.root, attempt }); continue;
      }
      const loadedAt = cached?.loadedAt ?? Date.now();
      const bytes = Buffer.byteLength(JSON.stringify(commits));
      state.ready = bytes <= 1024 * 1024 ? { context, commits: structuredClone(commits), loadedAt, bytes } : undefined;
      if (!cached) await this.storage?.store(state.root, state.file, context.key, commits, loadedAt).catch(() => undefined);
      signal.throwIfAborted();
      this.emit("file history snapshot ready", { repoRoot: state.root, source, commits: commits.length });
      return { repoRoot: state.root, path: state.file, commits, loadedAt, source };
    }
    throw new Error("Git history changed while reading. Refresh to try again.");
  }

  /** 완료 캐시는 40개·4MiB·30분으로 제한하고 아직 표시할 소비자가 있는 조회는 보호한다. */
  private prune(): void {
    let bytes = [...this.states.values()].reduce((sum, state) => sum + (state.ready?.bytes ?? 0), 0);
    for (const [key, state] of [...this.states].sort((a, b) => a[1].at - b[1].at)) {
      if (!state.read.hasConsumers() && (this.states.size > 40 || bytes > 4 * 1024 * 1024 || Date.now() - state.at > 30 * 60_000)) {
        this.states.delete(key); bytes -= state.ready?.bytes ?? 0; void state.read.dispose();
      }
    }
  }

  /** 관찰 채널 폐기로 정상 Git 성공이나 캐시 사용을 바꾸지 않는다. */
  private emit(event: string, fields: Record<string, unknown>): void { try { this.log(event, fields); } catch { /* 조회 결과 유지 */ } }
}

let shared = new FileHistoryReadCache();

/** 사용자별 정책·OUTPUT·저장 공간을 주입하고 이전 Host의 소비자 정리를 새 수명에 연결한다. */
export function beginFileHistoryReadLifetime(cancelUnused: (root: string) => boolean,
  log: (event: string, fields: Record<string, unknown>) => void, directory?: string, reader: FileHistoryReader = production): () => Promise<void> {
  const previous = shared.dispose();
  shared = new FileHistoryReadCache(reader, cancelUnused, log, directory ? new FileHistoryDiskStorage(directory) : undefined);
  const owned = shared;
  return async () => { await Promise.all([previous, owned.dispose()]); };
}

/** 명령·다른 조회 소비자는 같은 파일별 Git 수명을 공유하면서 독립 signal을 사용한다. */
export function readFileHistorySnapshot(root: string, file: string, options?: FileHistoryReadOptions): Promise<FileHistorySnapshot> {
  return shared.read(root, file, options);
}
