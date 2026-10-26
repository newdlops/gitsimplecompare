import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit, withGitConfigOverrides } from "./gitExec";
import { isGitLifecycleError } from "./gitError";
import { runGitStatus } from "./gitStatusExec";
import { registerStatusIndex } from "./statusIndexOwnership";
import type { StatusIndexWarmCache } from "./statusIndexWarmCache";
import { restoreStatusIndexMetadata, statusIndexStagingIdentity, StatusIndexSource } from "./statusIndexStagingIdentity";
import { parseWorkingTreeV2, workingTreeSnapshot, type ParsedWorkingTree, type WorkingTreeSnapshot, type WorkingTreeSummary } from "./workingTreeStatusFormat";
import { COLD_STATUS_MIN_ENTRIES, readColdStatus } from "./coldStatusScan";
import { StatusIndexWarmup } from "./statusIndexWarmup";
import { RepositoryIndexPathReader } from "./repositoryIndexPath";
import { transitionStatusIndex } from "./statusIndexTransition";
import { forgetWorkingTreeChangeHints, rememberWorkingTreeChangeHints } from "./workingTreeChangeHints";

/** 실제 index를 복사하되 모든 상태 캐시 쓰기를 확장 소유 디렉터리로만 보내는 저장소별 캐시다. */
export class PrivateStatusIndex {
  private directory?: string;
  private index?: string;
  private fingerprint?: string;
  private warmFingerprint?: string;
  private unregister?: () => void;
  private publishedAt = 0;
  private cold = false;
  private readonly warmup: StatusIndexWarmup;
  private readonly sourcePath: RepositoryIndexPathReader;
  private sourceIdentity?: string;

  /** 저장 공간이 주입되면 세션을 넘겨 Git의 검증 가능한 전용 index만 재사용한다. */
  constructor(private readonly root: string, private readonly log: (event: string, fields: Record<string, unknown>) => void,
    private readonly warmCache?: StatusIndexWarmCache) {
    this.warmup = new StatusIndexWarmup(root, log, warmCache); this.sourcePath = new RepositoryIndexPathReader(root, runGit, log);
  }

  /**
   * normal 상태의 미추적 디렉터리만 추가 열거해 전체 파일 결과를 보존한다.
   * @param signal 소비자가 모두 해제되면 실제 status/열거까지 취소하는 신호
   * @param useCache false이면 authoritative all 상태를 읽는다.
   * @returns 실제 index를 변경하지 않은 상태 스냅샷
   */
  async read(signal: AbortSignal, useCache = true): Promise<WorkingTreeSnapshot> {
    const parsed = await this.readParsed(signal, useCache, false);
    if (useCache) rememberWorkingTreeChangeHints(this.root, parsed.entries); else forgetWorkingTreeChangeHints(this.root);
    return workingTreeSnapshot(this.root, parsed);
  }

  /**
   * Graph에 필요한 HEAD·변경 존재만 읽고 미추적 디렉터리의 파일별 열거·별도 warmup은 시작하지 않는다.
   * @param signal 공유 조회의 취소 신호 @param useCache 전용 index 사용 여부
   * @returns 같은 Native status가 확인한 HEAD와 staged·unstaged·untracked 변경 존재
   */
  async readSummary(signal: AbortSignal, useCache = true): Promise<WorkingTreeSummary> {
    const parsed = await this.readParsed(signal, useCache, true);
    if (useCache) rememberWorkingTreeChangeHints(this.root, parsed.entries); else forgetWorkingTreeChangeHints(this.root);
    return { head: parsed.head, hasChanges: parsed.entries.length > 0 };
  }

  /**
   * 전체 목록과 요약의 전용 index·metadata 검증을 공유한다. 호출부의 공유 실행기가 동시 접근을 직렬화한다.
   * @param signal Native 조회와 보조 파일 읽기의 취소 신호 @param useCache 전용 index 사용 여부
   * @param summary true이면 디렉터리 내 개별 미추적 파일을 열거하지 않고 변경 존재만 보존한다.
   * @returns 검증된 Native porcelain 의미. 전체 요청은 모든 경로를 포함하며 요약 요청은 공개 목록으로 노출하지 않는다.
   */
  private async readParsed(signal: AbortSignal, useCache: boolean, summary: boolean): Promise<ParsedWorkingTree> {
    if (signal.aborted) throw new DOMException("Git read cancelled.", "AbortError");
    if (!useCache || process.env.GIT_INDEX_FILE || process.env.GIT_DIR || process.env.GIT_WORK_TREE
      || await stat(path.join(this.root, ".gitmodules")).then(() => true, () => false)) {
      this.warmup.setSource(undefined); return this.authoritative(signal, summary);
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const sourcePath = await this.sourcePath.read(signal);
        // private index와 실제 저장소의 연결을 증명하지 못하면 원본 Git status에 맡긴다.
        if (!sourcePath.identity) {
          this.log("private status index path unavailable", { repoRoot: this.root, reason: "unprovenRepositoryMetadata" });
          throw new Error("Repository metadata is unavailable for the private status index.");
        }
        const source = sourcePath.file;
        const before = await indexIdentity(source, signal);
        await this.prepare(before, signal, sourcePath.identity);
        const env = withGitConfigOverrides({ GIT_INDEX_FILE: this.index! }, { "core.untrackedCache": "true", "core.splitIndex": "false" });
        const initial = !summary && this.cold ? await readColdStatus(this.root, env, signal, this.log) : undefined;
        const parsed = initial ?? parseWorkingTreeV2(await runGitStatus(["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=normal", ...(summary ? ["--no-renames"] : [])], this.root,
          { signal, env, allowPrivateIndexWrites: true }));
        if (!initial) this.cold = false;
        const directories = initial || summary ? [] : parsed.entries.filter(entry => entry.xy === "??" && entry.path.endsWith("/")).map(entry => entry.path);
        if (!initial && !summary) parsed.entries = parsed.entries.filter(entry => !(entry.xy === "??" && entry.path.endsWith("/")));
        // 이미 무효가 된 status에 비싼 전체 미추적 파일 열거를 덧붙이지 않는다.
        // 열거 중 변경도 마지막 경계에서 다시 검사하므로 이른 검사로 최종 검증을 대체하지 않는다.
        if (directories.length && !await this.sourcePath.unchangedForStatus(sourcePath, signal)) {
          this.fingerprint = undefined;
          this.log("private status index invalidated", { repoRoot: this.root, reason: "real-index-or-metadata-changed-during-read",
            phase: "beforeUntrackedExpansion", metadataChanged: true });
          continue;
        }
        const files = new Set<string>();
        for (const batch of pathBatches(directories)) {
          const output = await runGit(["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", ...batch], this.root, { signal, env: { GIT_INDEX_FILE: this.index!, GIT_OPTIONAL_LOCKS: "0" } });
          for (const file of output.split("\0")) if (file) files.add(file);
        }
        for (const file of files) parsed.entries.push({ xy: "??", path: file });
        const indexUnchanged = before.key === (await indexIdentity(source, signal)).key;
        const bindingUnchanged = indexUnchanged && await this.sourcePath.unchangedForStatus(sourcePath, signal);
        if (indexUnchanged && bindingUnchanged) {
          if (initial && !signal.aborted && this.warmFingerprint && before.bytes && before.mtime !== undefined) {
            const key = this.warmFingerprint;
            this.warmup.schedule({ key, bytes: before.bytes, mtimeMs: before.mtime,
              isCurrent: async warmupSignal => {
                const current = await indexIdentity(source, warmupSignal);
                return !!current.bytes && statusIndexStagingIdentity(current.bytes) === key.slice(-64);
              } });
          }
          // 최초 완료와 원본 변경 때는 게시하고 반복 조회는 디스크 쓰기를 30초에 한 번으로 제한한다.
          if (!initial && this.warmCache && this.warmFingerprint && !signal.aborted && Date.now() - this.publishedAt >= 30000) {
            this.publishedAt = Date.now(); await this.warmCache.store(this.root, this.warmFingerprint!, this.index!);
          }
          return parsed;
        }
        this.fingerprint = undefined;
        this.log("private status index invalidated", { repoRoot: this.root, reason: "real-index-or-metadata-changed-during-read",
          indexChanged: !indexUnchanged, metadataChecked: indexUnchanged,
          ...(indexUnchanged ? { metadataChanged: !bindingUnchanged } : {}) });
      }
    } catch (error) {
      if (signal.aborted || isGitLifecycleError(error)) { await this.dispose(); throw error; }
      this.log("private status index fallback", { repoRoot: this.root, reason: error instanceof Error ? error.name : "cache-failed" });
      await this.dispose();
    }
    return this.authoritative(signal, summary);
  }

  /** 실행 close 뒤에 호출하며 생성한 디렉터리만 삭제한다. */
  async dispose(): Promise<void> {
    forgetWorkingTreeChangeHints(this.root);
    await this.warmup.dispose(); this.cold = false;
    this.sourcePath.clear(); this.sourceIdentity = undefined;
    const directory = this.directory;
    this.unregister?.(); this.unregister = undefined; this.directory = undefined; this.index = undefined; this.fingerprint = undefined; this.warmFingerprint = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  /** 호출자 index와 미지원 구성에서도 Git의 authoritative 조회로 복구하며, 전체 요청의 파일은 모두 유지한다. */
  private async authoritative(signal: AbortSignal, summary: boolean): Promise<ParsedWorkingTree> {
    const raw = await runGitStatus(["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z",
      `--untracked-files=${summary ? "normal" : "all"}`, ...(summary ? ["--no-renames"] : [])], this.root, { signal });
    return parseWorkingTreeV2(raw);
  }

  /** 원본 사본·취소 수명·검증한 저장소 identity를 받아 현재 stage와 stat에 맞는 전용 index를 준비한다. */
  private async prepare(source: IndexIdentity, signal: AbortSignal, sourceIdentity: string): Promise<void> {
    if (!this.directory) {
      this.directory = await mkdtemp(path.join(os.tmpdir(), "gsc-status-index-"));
      this.index = path.join(this.directory, "index"); this.unregister = registerStatusIndex(this.index);
    }
    const unchanged = this.fingerprint === source.key;
    const large = !!source.bytes && source.bytes.length >= 12 && source.bytes.readUInt32BE(8) >= COLD_STATUS_MIN_ENTRIES;
    const inspection = !unchanged && large && source.bytes ? StatusIndexSource.inspect(source.bytes) : undefined;
    const info = inspection?.info;
    const staging = info?.identity ?? (!unchanged && this.warmCache && source.bytes ? statusIndexStagingIdentity(source.bytes) : undefined);
    const warmFingerprint = unchanged ? this.warmFingerprint : staging ? `staging-v1:${source.file}:${staging}` : undefined;
    const previous = this.warmFingerprint;
    const canTransition = !unchanged && !!this.fingerprint && large && !!info && info.directoryCount >= 256 && !info.hasUntrackedCache
      && !!previous && !!warmFingerprint && previous !== warmFingerprint
      && previous.slice(0, -64) === warmFingerprint.slice(0, -64) && this.sourceIdentity === sourceIdentity;
    // 완료된 이전 warmup은 버리기 전에 가져온다. 실행 중 준비는 기다리지 않고 기존 정책대로 취소한다.
    const previousWarmup = canTransition ? await this.warmup.take(previous) : undefined;
    this.warmup.setSource(warmFingerprint);
    const completedWarmup = await this.warmup.take(warmFingerprint);
    if (completedWarmup) {
      const restored = completedWarmup.bytes && source.bytes ? inspection
        ? inspection.restoreMetadata(completedWarmup.bytes) : restoreStatusIndexMetadata(completedWarmup.bytes, source.bytes) : undefined;
      this.cold = false;
      if (restored) {
        await writeFile(this.index!, restored, { mode: 0o600 });
        this.fingerprint = source.key; this.warmFingerprint = warmFingerprint; this.publishedAt = Date.now();
        this.log("private status index warmup applied", { repoRoot: this.root });
      }
    }
    if (this.fingerprint === source.key) {
      // private status가 mtime을 늦췄어도 다음 조회의 racy-clean 경계는 실제 index보다 늦어지지 않는다.
      if (source.mtime !== undefined) await utimes(this.index!, source.mtime / 1000, Math.floor(source.mtime / 1000));
      this.sourceIdentity = sourceIdentity;
      return;
    }
    // stat·UNTR·FSMN 갱신만으로 다시 전체 탐색하지 않되 stage/파일 의미 변경은 반드시 분리한다.
    const retained = !!this.fingerprint && !!warmFingerprint && previous === warmFingerprint && this.sourceIdentity === sourceIdentity && inspection
      ? inspection.restoreMetadata(await readFile(this.index!, { signal }), true) : undefined;
    this.warmFingerprint = warmFingerprint;
    const warmed = !retained && this.warmFingerprint ? await this.warmCache?.load(this.root, this.warmFingerprint) : undefined;
    const transitioned = !retained && !warmed && canTransition && source.bytes
      ? await transitionStatusIndex(this.root, this.index!, source.bytes, previous!.slice(-64), signal, this.log, previousWarmup?.bytes, inspection) : undefined;
    const bytes = retained ?? (warmed && source.bytes ? (inspection ? inspection.restoreMetadata(warmed.bytes)
      : restoreStatusIndexMetadata(warmed.bytes, source.bytes)) ?? source.bytes : transitioned ?? source.bytes);
    this.cold = !completedWarmup && !!info && info.directoryCount >= 256 && !info.hasUntrackedCache && !retained && !warmed && !transitioned;
    if (bytes) {
      await writeFile(this.index!, bytes, { mode: 0o600 });
      // 새 사본의 mtime이 늦으면 racy-clean 파일의 수정을 놓치므로 원본보다 이른 시각을 보존한다.
      const mtime = source.mtime!;
      await utimes(this.index!, mtime / 1000, Math.floor(mtime / 1000));
    }
    else await rm(this.index!, { force: true });
    this.fingerprint = source.key;
    this.sourceIdentity = sourceIdentity;
    if (!retained) this.publishedAt = 0;
    else this.log("private status index metadata refreshed", { repoRoot: this.root, sourceInspectionReused: true });
  }
}

interface IndexIdentity { key: string; file: string; bytes?: Buffer; mtime?: number }
/** stat 전후와 내용 hash를 대조해 같은 이름의 index 교체와 도중 쓰기를 검출한다. */
async function indexIdentity(file: string, signal?: AbortSignal): Promise<IndexIdentity> {
  try {
    signal?.throwIfAborted();
    const before = await stat(file);
    signal?.throwIfAborted();
    const bytes = await readFile(file, { signal });
    signal?.throwIfAborted();
    const after = await stat(file);
    signal?.throwIfAborted();
    const metadata = (info: typeof before) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (metadata(before) !== metadata(after)) throw new Error("Index changed while reading.");
    return { key: `${file}:${metadata(after)}:${createHash("sha256").update(bytes).digest("hex")}`, file, bytes, mtime: after.mtimeMs };
  } catch (error) {
    signal?.throwIfAborted();
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
