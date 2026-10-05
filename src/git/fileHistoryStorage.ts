import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { FileHistoryEntry } from "./fileHistoryService";
import type { FileHistoryStorage } from "./fileHistoryReadCache";

interface Envelope { schema: 1; version: string; loadedAt: number; digest: string; commits: FileHistoryEntry[] }
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 40;
const MAX_AGE_MS = 7 * 86400 * 1000;

/** 검증한 HEAD/config에만 묶인 전체 이력을 사용자별 확장 저장 공간에 유한하게 보존한다. */
export class FileHistoryDiskStorage implements FileHistoryStorage {
  private pruning: Promise<void> = Promise.resolve();
  /** directory는 다른 사용자 파일이 없는 확장 소유 history 디렉터리다. */
  constructor(private readonly directory: string) {}

  /**
   * key·내용 hash·schema·기본 필드를 확인한 결과만 복원하고 손상은 정상 cache miss로 처리한다.
   * @param root·file 저장소/파일 조합, version 실제 Git에서 읽은 불변 context
   * @returns 이전 완료 이력. 누락·오류·심볼릭 링크·과대 파일이면 undefined
   */
  async load(root: string, file: string, version: string): Promise<{ commits: FileHistoryEntry[]; loadedAt: number } | undefined> {
    try {
      if (!await this.safeDirectory(false)) return undefined;
      const saved = this.file(root, file), info = await lstat(saved);
      if (!info.isFile() || info.isSymbolicLink() || !this.sameUser(info.uid) || info.size > MAX_FILE_BYTES || Date.now() - info.mtimeMs > MAX_AGE_MS) return undefined;
      const bytes = await readFile(saved);
      if (bytes.length > MAX_FILE_BYTES) return undefined;
      const entry = JSON.parse(bytes.toString()) as Envelope;
      if (entry.schema !== 1 || entry.version !== version || !Number.isFinite(entry.loadedAt) || entry.loadedAt > Date.now() + 60_000
        || !validCommits(entry.commits) || digest(entry.commits) !== entry.digest) return undefined;
      return { commits: entry.commits.map(commit => ({ ...commit, oldPath: commit.oldPath, additions: commit.additions, deletions: commit.deletions })), loadedAt: entry.loadedAt };
    } catch { return undefined; }
  }

  /** 완성된 작은 이력을 원자적으로 게시하며 저장 실패가 정상 Git 조회를 변경하지 않게 한다. */
  async store(root: string, file: string, version: string, commits: FileHistoryEntry[], loadedAt: number): Promise<void> {
    let temporary: string | undefined;
    try {
      if (!validCommits(commits) || !await this.safeDirectory(true)) return;
      const bytes = Buffer.from(JSON.stringify({ schema: 1, version, loadedAt, digest: digest(commits), commits } satisfies Envelope));
      if (bytes.length > MAX_FILE_BYTES) return;
      const saved = this.file(root, file); temporary = `${saved}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
      await rename(temporary, saved); temporary = undefined;
      this.pruning = this.pruning.catch(() => undefined).then(() => this.prune(saved));
      await this.pruning;
    } catch { /* 보존 실패 시 다음 조회가 실제 Git으로 복구한다. */ }
    finally { if (temporary) await rm(temporary, { force: true }).catch(() => undefined); }
  }

  /** root·파일 경로를 외부 파일명에 노출하지 않는 저장 파일 이름을 만든다. */
  private file(root: string, file: string): string { return path.join(this.directory, `${createHash("sha256").update(`${path.resolve(root)}\0${file}`).digest("hex")}.history`); }

  /** 현재 사용자 소유의 실제 디렉터리만 사용하고 symlink를 따라 쓰지 않는다. */
  private async safeDirectory(create: boolean): Promise<boolean> {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    return info.isDirectory() && !info.isSymbolicLink() && this.sameUser(info.uid);
  }

  /** UID가 있는 플랫폼에서는 다른 사용자의 파일을 복원하거나 삭제하지 않는다. */
  private sameUser(uid: number): boolean { return !process.getuid || uid === process.getuid(); }

  /** 40개·8MiB·7일 상한과 비정상 종료 후 한 시간 지난 우리 게시 임시 파일만 정리한다. */
  private async prune(protectedFile: string): Promise<void> {
    if (!await this.safeDirectory(false)) return;
    const files: Array<{ file: string; size: number; at: number }> = [];
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const saved = /^[0-9a-f]{64}\.history$/.test(entry.name);
      const temporary = /^[0-9a-f]{64}\.history\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp$/.test(entry.name);
      if (!saved && !temporary) continue;
      const file = path.join(this.directory, entry.name), info = await lstat(file).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink() || !this.sameUser(info.uid)) continue;
      if (temporary) { if (Date.now() - info.mtimeMs > 3600_000) await rm(file, { force: true }); }
      else files.push({ file, size: info.size, at: info.mtimeMs });
    }
    files.sort((a, b) => a.at - b.at);
    let count = files.length, bytes = files.reduce((sum, file) => sum + file.size, 0);
    for (const entry of files) {
      if (entry.file === protectedFile) continue;
      if (count <= MAX_FILES && bytes <= MAX_TOTAL_BYTES && Date.now() - entry.at <= MAX_AGE_MS) continue;
      await rm(entry.file, { force: true }); count--; bytes -= entry.size;
    }
  }
}

/** 보존할 커밋의 내용 식별자를 계산하며 인증·환경·Git 설정은 저장하지 않는다. */
function digest(commits: FileHistoryEntry[]): string { return createHash("sha256").update(JSON.stringify(commits)).digest("hex"); }

/** cache의 JSON을 표시/Git diff에 넘기기 전에 커밋·경로·기본 필드의 전체 schema를 검증한다. */
function validCommits(value: unknown): value is FileHistoryEntry[] {
  return Array.isArray(value) && value.length <= 60 && value.every(entry => entry && typeof entry === "object"
    && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.hash) && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.baseRef)
    && ["shortHash", "title", "message", "author", "dateIso", "relativeDate", "path"].every(key => typeof entry[key] === "string")
    && /^[AMDRCTUXB]$/.test(entry.status) && (entry.oldPath === undefined || typeof entry.oldPath === "string")
    && [entry.additions, entry.deletions].every(count => count === undefined || Number.isSafeInteger(count) && count >= 0));
}
