import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { statusIndexStagingIdentity } from "./statusIndexStagingIdentity";

interface CacheHeader { version: 1; sourceKey: string; digest: string; mtimeMs: number }
export interface WarmStatusIndex { bytes: Buffer; mtimeMs: number }
export interface WarmCacheLimits { maxFiles: number; maxBytes: number; maxEntryBytes: number; maxAgeMs: number }
type Logger = (event: string, fields: Record<string, unknown>) => void;
const DEFAULTS: WarmCacheLimits = { maxFiles: 32, maxBytes: 128 * 1024 * 1024, maxEntryBytes: 32 * 1024 * 1024, maxAgeMs: 7 * 86400 * 1000 };
const MAX_HEADER_BYTES = 32768;
const TEMPORARY_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * 조회 결과 대신 Git의 전용 index만 원자적으로 보존해 새 Host의 전체 탐색을 줄인다.
 * - 실제 index 식별자와 캐시 내용 hash가 모두 일치해야 복원한다.
 * - 자식 Git에는 이 파일을 직접 넘기지 않고 세션별 임시 사본만 전달한다.
 * - 다른 창의 동시 게시와 손상은 캐시 miss로 복구하며 사용자 Git 파일은 수정하지 않는다.
 */
export class StatusIndexWarmCache {
  private pruning: Promise<void> = Promise.resolve();

  /**
   * @param directory 확장 global storage 아래 캐시 전용 디렉터리
   * @param log 복원·손상·크기 제한을 OUTPUT으로 전달할 주입 함수
   * @param limits 저장 파일 수·전체/단일 크기·수명의 상한. 검사에서 작은 값으로 검증한다.
   */
  constructor(private readonly directory: string, private readonly log: Logger = () => undefined,
    private readonly limits: WarmCacheLimits = DEFAULTS) {}

  /**
   * 실제 index가 같은 경우에만 이전 세션의 전용 index를 반환한다.
   * @param root 저장소/linked worktree 루트. 서로 다른 작업트리의 캐시를 분리한다.
   * @param sourceKey 호출자가 stat 전후와 원본 hash로 검증한 현재 index 식별자
   * @returns 검증된 바이트와 원래 mtime. 없거나 읽을 수 없으면 undefined로 정상 복구한다.
   */
  async load(root: string, sourceKey: string): Promise<WarmStatusIndex | undefined> {
    try {
      if (!await this.safeDirectory(false)) return undefined;
      const file = this.file(root), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || !this.sameUser(info.uid)
        || info.size > this.limits.maxEntryBytes + MAX_HEADER_BYTES + 4 || Date.now() - info.mtimeMs > this.limits.maxAgeMs) return undefined;
      const data = await readFile(file);
      if (data.length < 4) return undefined;
      const headerLength = data.readUInt32BE(0);
      if (!headerLength || headerLength > MAX_HEADER_BYTES || headerLength + 4 > data.length) return undefined;
      const header = JSON.parse(data.subarray(4, 4 + headerLength).toString()) as CacheHeader;
      const bytes = data.subarray(4 + headerLength);
      if (header.version !== 1 || !Number.isFinite(header.mtimeMs) || !this.validIndex(bytes)
        || createHash("sha256").update(bytes).digest("hex") !== header.digest || !this.matchesSource(header.sourceKey, sourceKey, bytes)) return undefined;
      this.emit("private status index cache restored", { repoRoot: root, bytes: bytes.length, identity: sourceKey.startsWith("staging-v1:") ? "staging" : "exact" });
      return { bytes, mtimeMs: header.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.failure(root, "restore", error);
      return undefined;
    }
  }

  /**
   * 완료된 Git 조회의 전용 index를 단일 파일로 게시하고 캐시의 전체 크기를 제한한다.
   * @param root 저장소 루트
   * @param sourceKey 결과 검증 직후의 실제 index 식별자
   * @param index Git 프로세스가 close된 세션 전용 index 경로
   * @returns 게시에 성공하면 true. 실패·과대 파일은 정상 조회 결과를 바꾸지 않는다.
   */
  async store(root: string, sourceKey: string, index: string): Promise<boolean> {
    let temporary: string | undefined;
    try {
      if (!await this.safeDirectory(true)) return false;
      const before = await stat(index);
      if (before.size > this.limits.maxEntryBytes) return false;
      const bytes = await readFile(index), after = await stat(index);
      if (!this.validIndex(bytes) || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size
        || (sourceKey.startsWith("staging-v1:") && (!this.sourcePath(sourceKey) || statusIndexStagingIdentity(bytes) !== sourceKey.slice(-64)))) return false;
      const header: CacheHeader = { version: 1, sourceKey, digest: createHash("sha256").update(bytes).digest("hex"), mtimeMs: after.mtimeMs };
      const encoded = Buffer.from(JSON.stringify(header));
      if (encoded.length > MAX_HEADER_BYTES || encoded.length + bytes.length + 4 > this.limits.maxBytes) return false;
      const length = Buffer.alloc(4); length.writeUInt32BE(encoded.length);
      const file = this.file(root);
      temporary = path.join(this.directory, `${path.basename(file)}.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(Buffer.concat([length, encoded])); await handle.writeFile(bytes); }
      finally { await handle.close(); }
      await rename(temporary, file); temporary = undefined;
      this.pruning = this.pruning.catch(() => undefined).then(() => this.prune(file));
      await this.pruning;
      return true;
    } catch (error) { this.failure(root, "store", error); return false; }
    finally { if (temporary) await rm(temporary, { force: true }).catch(() => undefined); }
  }

  /**
   * 우리 소유의 일반 디렉터리만 사용해 심볼릭 링크를 따라 쓰거나 정리하지 않는다.
   * @param create 새 확장 저장 공간이면 디렉터리를 생성할지 여부
   * @returns 현재 사용자 소유의 실제 디렉터리인지 여부
   */
  private async safeDirectory(create: boolean): Promise<boolean> {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    return info.isDirectory() && !info.isSymbolicLink() && this.sameUser(info.uid);
  }

  /** 동일 저장소에는 한 파일만 쓰며 루트 경로를 외부 파일명에 노출하지 않는다. */
  private file(root: string): string { return path.join(this.directory, `${createHash("sha256").update(path.resolve(root)).digest("hex")}.cache`); }

  /** index 형식의 최소 헤더와 지원 버전을 검사하고 과대 payload를 거부한다. */
  private validIndex(bytes: Buffer): boolean {
    return bytes.length >= 12 && bytes.length <= this.limits.maxEntryBytes && bytes.subarray(0, 4).toString() === "DIRC" && [2, 3, 4].includes(bytes.readUInt32BE(4));
  }

  /** POSIX는 현재 UID만 허용하며 UID가 없는 플랫폼은 확장 전용 저장 공간을 사용한다. */
  private sameUser(uid: number): boolean { return !process.getuid || uid === process.getuid(); }

  /**
   * 실제 stage 의미와 Git 경로가 같으면 stat-only 갱신과 이전 exact 캐시에서도 복원한다.
   * @param saved 캐시가 게시될 때 원본 index 식별자
   * @param current 지금 읽은 index의 exact 또는 staging 식별자
   * @param bytes 캐시 payload. 원본과 같은 stage/flags인지 다시 검증한다.
   * @returns 같은 repository index와 stage 의미에 바인딩된 payload인지 여부
   */
  private matchesSource(saved: string, current: string, bytes: Buffer): boolean {
    if (!current.startsWith("staging-v1:")) return saved === current;
    const identity = statusIndexStagingIdentity(bytes);
    const currentPath = this.sourcePath(current);
    if (!identity || identity !== current.slice(-64) || !currentPath || this.sourcePath(saved) !== currentPath) return false;
    return !saved.startsWith("staging-v1:") || identity === saved.slice(-64);
  }

  /**
   * opaque 식별자에서 실제 index 경로만 대조해 같은 root의 Git 디렉터리 교체를 구분한다.
   * @param key 현재 staging 식별자 또는 이전 stat/hash 식별자
   * @returns 검사한 형식의 경로. 알 수 없는 형식은 undefined이며 캐시 이행을 허용하지 않는다.
   */
  private sourcePath(key: string): string | undefined {
    if (key.startsWith("staging-v1:")) return /^staging-v1:(.+):[0-9a-f]{64}$/.exec(key)?.[1];
    return /^(.+):\d+:\d+:\d+:[\d.-]+:[\d.-]+:[0-9a-f]{64}$/.exec(key)?.[1];
  }

  /**
   * 오래된 캐시부터 제거해 파일 수와 전체 디스크 사용량을 제한한다.
   * @param protectedFile 방금 게시한 파일. 다른 저장소의 오래된 파일부터 회수한다.
   * @returns 정리가 끝난 뒤 완료. Git 프로세스·실제 index·무관한 파일은 접근하지 않는다.
   */
  private async prune(protectedFile: string): Promise<void> {
    if (!await this.safeDirectory(false)) return;
    const entries = await readdir(this.directory, { withFileTypes: true });
    const files: Array<{ file: string; size: number; mtime: number }> = [];
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const completed = /^[0-9a-f]{64}\.cache$/.test(entry.name);
      const temporary = /^[0-9a-f]{64}\.cache\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp$/.test(entry.name);
      if (!completed && !temporary) continue;
      const file = path.join(this.directory, entry.name);
      const info = await lstat(file).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink() || !this.sameUser(info.uid)) continue;
      if (temporary) {
        // 게시 중인 다른 Host의 파일은 보존하고 비정상 종료 후 한 시간 지난 우리 임시 파일만 회수한다.
        if (Date.now() - info.mtimeMs > TEMPORARY_MAX_AGE_MS) { await rm(file, { force: true }); removed++; }
      } else files.push({ file, size: info.size, mtime: info.mtimeMs });
    }
    files.sort((one, two) => one.mtime - two.mtime);
    let count = files.length, bytes = files.reduce((sum, item) => sum + item.size, 0);
    for (const item of files) {
      if (item.file === protectedFile) continue;
      if (count <= this.limits.maxFiles && bytes <= this.limits.maxBytes && Date.now() - item.mtime <= this.limits.maxAgeMs) continue;
      await rm(item.file, { force: true }); count--; bytes -= item.size; removed++;
    }
    if (removed) this.emit("private status index cache pruned", { removed, files: count, bytes });
  }

  /** 민감한 경로·index 내용 없이 저장 공간 오류만 기록하고 정상 Git 결과를 보호한다. */
  private failure(root: string, operation: string, error: unknown): void {
    this.emit("private status index cache unavailable", { repoRoot: root, operation, reason: error instanceof Error ? error.name : "storage-error" });
  }

  /** OUTPUT 채널이 dispose됐거나 기록에 실패해도 캐시와 정상 Git 조회 결과를 보호한다. */
  private emit(event: string, fields: Record<string, unknown>): void { try { this.log(event, fields); } catch { /* 조회 결과 유지 */ } }
}
