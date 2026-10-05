import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit, withGitConfigOverrides } from "./gitExec";
import { isGitLifecycleError } from "./gitError";
import { runGitStatus } from "./gitStatusExec";
import { registerStatusIndex } from "./statusIndexOwnership";
import type { StatusIndexWarmCache } from "./statusIndexWarmCache";
import { restoreStatusIndexMetadata, statusIndexStagingIdentity } from "./statusIndexStagingIdentity";
import { parseWorkingTreeV2, workingTreeSnapshot, type WorkingTreeSnapshot } from "./workingTreeStatusFormat";

/** 실제 index를 복사하되 모든 상태 캐시 쓰기를 확장 소유 디렉터리로만 보내는 저장소별 캐시다. */
export class PrivateStatusIndex {
  private directory?: string;
  private index?: string;
  private fingerprint?: string;
  private warmFingerprint?: string;
  private unregister?: () => void;
  private publishedAt = 0;

  /** 저장 공간이 주입되면 세션을 넘겨 Git의 검증 가능한 전용 index만 재사용한다. */
  constructor(private readonly root: string, private readonly log: (event: string, fields: Record<string, unknown>) => void,
    private readonly warmCache?: StatusIndexWarmCache) {}

  /**
   * normal 상태의 미추적 디렉터리만 추가 열거해 전체 파일 결과를 보존한다.
   * @param signal 소비자가 모두 해제되면 실제 status/열거까지 취소하는 신호
   * @param useCache false이면 authoritative all 상태를 읽는다.
   * @returns 실제 index를 변경하지 않은 상태 스냅샷
   */
  async read(signal: AbortSignal, useCache = true): Promise<WorkingTreeSnapshot> {
    if (signal.aborted) throw new DOMException("Git read cancelled.", "AbortError");
    if (!useCache || process.env.GIT_INDEX_FILE || process.env.GIT_DIR || process.env.GIT_WORK_TREE
      || await stat(path.join(this.root, ".gitmodules")).then(() => true, () => false)) return this.authoritative(signal);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const source = path.resolve(this.root, (await runGit(["rev-parse", "--git-path", "index"], this.root, { signal })).trim());
        const before = await indexIdentity(source);
        await this.prepare(before);
        const env = withGitConfigOverrides({ GIT_INDEX_FILE: this.index! }, { "core.untrackedCache": "true", "core.splitIndex": "false" });
        const raw = await runGitStatus(["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=normal"], this.root,
          { signal, env, allowPrivateIndexWrites: true });
        const parsed = parseWorkingTreeV2(raw);
        const directories = parsed.entries.filter(entry => entry.xy === "??" && entry.path.endsWith("/")).map(entry => entry.path);
        parsed.entries = parsed.entries.filter(entry => !(entry.xy === "??" && entry.path.endsWith("/")));
        const files = new Set<string>();
        for (const batch of pathBatches(directories)) {
          const output = await runGit(["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", ...batch], this.root, { signal, env: { GIT_INDEX_FILE: this.index!, GIT_OPTIONAL_LOCKS: "0" } });
          for (const file of output.split("\0")) if (file) files.add(file);
        }
        for (const file of files) parsed.entries.push({ xy: "??", path: file });
        if (before.key === (await indexIdentity(source)).key) {
          // 최초 완료와 원본 변경 때는 게시하고 반복 조회는 디스크 쓰기를 30초에 한 번으로 제한한다.
          if (this.warmCache && this.warmFingerprint && !signal.aborted && Date.now() - this.publishedAt >= 30000) {
            this.publishedAt = Date.now(); await this.warmCache.store(this.root, this.warmFingerprint!, this.index!);
          }
          return workingTreeSnapshot(this.root, parsed);
        }
        this.fingerprint = undefined;
        this.log("private status index invalidated", { repoRoot: this.root, reason: "real-index-changed-during-read" });
      }
    } catch (error) {
      if (signal.aborted || isGitLifecycleError(error)) { await this.dispose(); throw error; }
      this.log("private status index fallback", { repoRoot: this.root, reason: error instanceof Error ? error.name : "cache-failed" });
      await this.dispose();
    }
    return this.authoritative(signal);
  }

  /** 실행 close 뒤에 호출하며 생성한 디렉터리만 삭제한다. */
  async dispose(): Promise<void> {
    const directory = this.directory;
    this.unregister?.(); this.unregister = undefined; this.directory = undefined; this.index = undefined; this.fingerprint = undefined; this.warmFingerprint = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  /** 호출자 index와 미지원 구성에서도 항상 Git의 authoritative 전체 조회로 복구한다. */
  private async authoritative(signal: AbortSignal): Promise<WorkingTreeSnapshot> {
    const raw = await runGitStatus(["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=all"], this.root, { signal });
    return workingTreeSnapshot(this.root, parseWorkingTreeV2(raw));
  }

  /** 원본 index의 내용·metadata가 바뀔 때만 private 사본을 새로 준비한다. */
  private async prepare(source: IndexIdentity): Promise<void> {
    if (!this.directory) {
      this.directory = await mkdtemp(path.join(os.tmpdir(), "gsc-status-index-"));
      this.index = path.join(this.directory, "index"); this.unregister = registerStatusIndex(this.index);
    }
    if (this.fingerprint === source.key) {
      // private status가 mtime을 늦췄어도 다음 조회의 racy-clean 경계는 실제 index보다 늦어지지 않는다.
      if (source.mtime !== undefined) await utimes(this.index!, source.mtime / 1000, Math.floor(source.mtime / 1000));
      return;
    }
    // stat·UNTR·FSMN 갱신만으로 다시 전체 탐색하지 않되 stage/파일 의미 변경은 반드시 분리한다.
    const staging = this.warmCache && source.bytes ? statusIndexStagingIdentity(source.bytes) : undefined;
    this.warmFingerprint = staging ? `staging-v1:${source.file}:${staging}` : undefined;
    const warmed = this.warmFingerprint ? await this.warmCache?.load(this.root, this.warmFingerprint) : undefined;
    const bytes = warmed && source.bytes ? restoreStatusIndexMetadata(warmed.bytes, source.bytes) ?? source.bytes : source.bytes;
    if (bytes) {
      await writeFile(this.index!, bytes, { mode: 0o600 });
      // 새 사본의 mtime이 늦으면 racy-clean 파일의 수정을 놓치므로 원본보다 이른 시각을 보존한다.
      const mtime = source.mtime!;
      await utimes(this.index!, mtime / 1000, Math.floor(mtime / 1000));
    }
    else await rm(this.index!, { force: true });
    this.fingerprint = source.key;
    this.publishedAt = 0;
  }
}

interface IndexIdentity { key: string; file: string; bytes?: Buffer; mtime?: number }
/** stat 전후와 내용 hash를 대조해 같은 이름의 index 교체와 도중 쓰기를 검출한다. */
async function indexIdentity(file: string): Promise<IndexIdentity> {
  try {
    const before = await stat(file), bytes = await readFile(file), after = await stat(file);
    const metadata = (info: typeof before) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (metadata(before) !== metadata(after)) throw new Error("Index changed while reading.");
    return { key: `${file}:${metadata(after)}:${createHash("sha256").update(bytes).digest("hex")}`, file, bytes, mtime: after.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { key: `${file}:missing`, file };
    throw error;
  }
}

/** OS 인자 길이를 넘지 않으며 literal 디렉터리 집합을 소수의 Git 실행으로 묶는다. */
function pathBatches(paths: readonly string[]): string[][] {
  const result: string[][] = []; let batch: string[] = [], size = 0;
  for (const file of paths) {
    const length = Buffer.byteLength(file) + 1;
    if (batch.length && size + length > 16_000) { result.push(batch); batch = []; size = 0; }
    batch.push(file); size += length;
  }
  if (batch.length) result.push(batch);
  return result;
}
