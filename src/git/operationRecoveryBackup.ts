// Git 중단/skip에서 폐기할 index와 작업 파일을 Git metadata 아래에 원본 바이트로 보존한다.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { readConflictWorkingLeaf } from "./conflictWorktreeCas";
import { runGit, runGitBufferWithInput, runGitWithInput } from "./gitExec";
import { resolveSafeConflictWorkingPath } from "./conflictPathSafety";
import { recoveryOverwritePaths } from "./operationRecoveryPaths";
import { logInfo } from "../ui/outputLog";
import { mapWithConcurrency } from "../utils/mapWithConcurrency";

/** 복구 파일 I/O는 제한된 worker로 처리하고 blob batch는 크기와 개수를 함께 제한한다. */
const RECOVERY_CONCURRENCY = 4;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_BLOBS = 128;
interface RecoveryBlob { oid: string; size: number }

/**
 * 충돌 해결/스테이징/추적되지 않은 파일의 원문과 index blob을 별도 디렉터리에 보존한다.
 * @param repoRoot 작업트리 루트
 * @param gitDir 현재 worktree의 실제 Git metadata 경로
 * @param action 복구 자료를 만든 이유
 * @returns 자료가 있으면 복구 manifest의 디렉터리. 보존 실패 시 Git 중단 명령도 실행하지 않는다.
 */
export async function preserveOperationEdits(repoRoot: string, gitDir: string, action: string, targets?: string[]): Promise<string | undefined> {
  const started = Date.now();
  logInfo("git operation edits preservation started", { repoRoot, action });
  const [changed, staged, untracked, index, overwritten] = await Promise.all([
    runGit(["diff", "HEAD", "--name-only", "-z"], repoRoot),
    runGit(["diff", "--cached", "--name-only", "-z"], repoRoot),
    runGit(["ls-files", "--others", "--exclude-standard", "-z"], repoRoot),
    runGit(["ls-files", "--stage", "-z"], repoRoot),
    recoveryOverwritePaths(repoRoot, gitDir, action, targets),
  ]);
  const files = [...new Set([...`${changed}\0${staged}\0${untracked}`.split("\0").filter(Boolean), ...overwritten])];
  if (!files.length) {
    logInfo("git operation edits preservation skipped", { repoRoot, action, reason: "no-files", elapsedMs: Date.now() - started });
    return undefined;
  }
  const scanMs = Date.now() - started;
  logInfo("git operation edits preservation selected", { repoRoot, action, files: files.length, scanMs });
  const directory = path.join(gitDir, "gitsimplecompare", "operation-recovery", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const workingStarted = Date.now();
  const entries = await mapWithConcurrency(files, RECOVERY_CONCURRENCY, async (relative, number) => {
    const absolute = await resolveSafeConflictWorkingPath(repoRoot, relative).catch(error => {
      // 삭제된 부모 디렉터리는 absent leaf로 기록할 수 있지만 symlink/권한 오류는 허용하지 않는다.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(repoRoot, relative);
      throw error;
    });
    const leaf = await readConflictWorkingLeaf(absolute);
    if (leaf.kind === "nonfile") throw new Error(`Cannot safely preserve '${relative}' before ${action}.`);
    const dataFile = `${number}.data`;
    if (leaf.buffer) await writeFile(path.join(directory, dataFile), leaf.buffer, { mode: 0o600 });
    return { path: relative, kind: leaf.kind, mode: leaf.mode, dataFile: leaf.buffer ? dataFile : undefined };
  });
  const worktreeMs = Date.now() - workingStarted;
  const selected = new Set(files);
  const stages = index.split("\0").filter(entry => selected.has(entry.slice(entry.indexOf("\t") + 1)));
  const blobs = [...new Set(stages.map(entry => entry.split(" ")[1]).filter(Boolean))];
  const blobStarted = Date.now();
  const batches = await preserveIndexBlobs(repoRoot, directory, blobs);
  const blobMs = Date.now() - blobStarted;
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ repoRoot, action, files: entries, index: stages }, null, 2), { mode: 0o600 });
  logInfo("git operation edits preserved", {
    repoRoot, action, recoveryDirectory: directory, files: files.length, blobs: blobs.length,
    blobBatches: batches, scanMs, worktreeMs, blobMs, elapsedMs: Date.now() - started,
  });
  return directory;
}

/**
 * index의 실제 blob 크기를 한 번 조회한 뒤 제한된 batch로 원본을 보존한다.
 * - 파일마다 Git을 새로 실행하지 않고, 큰 blob 여러 개를 한꺼번에 메모리에 올리지 않는다.
 * - 모든 batch와 파일 저장이 끝나야 호출부가 manifest를 기록하고 Skip/Abort를 실행한다.
 * @param repoRoot 작업트리 루트 @param directory 이번 복구 자료 디렉터리
 * @param oids 중복을 제거한 index OID 목록 @returns 실행한 내용 조회 batch 수
 */
async function preserveIndexBlobs(repoRoot: string, directory: string, oids: string[]): Promise<number> {
  if (!oids.length) return 0;
  if (oids.some(oid => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))) {
    throw new Error("Cannot verify an index object before Git recovery.");
  }
  const env = { GIT_NO_REPLACE_OBJECTS: "1" };
  const metadata = await runGitWithInput(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    repoRoot, `${oids.join("\n")}\n`, { env });
  const lines = metadata.trimEnd().split("\n");
  if (lines.length !== oids.length) throw new Error("Incomplete index object metadata before Git recovery.");
  const blobs = lines.map((line, index): RecoveryBlob => {
    const [oid, type, rawSize] = line.split(" ");
    const size = Number(rawSize);
    if (oid !== oids[index] || type !== "blob" || !/^\d+$/.test(rawSize ?? "") || !Number.isSafeInteger(size)) {
      throw new Error(`Cannot read index blob ${oids[index]} before Git recovery.`);
    }
    return { oid, size };
  });
  let batch: RecoveryBlob[] = [], bytes = 0, count = 0;
  for (const blob of blobs) {
    if (batch.length && (batch.length >= MAX_BATCH_BLOBS || bytes + blob.size > MAX_BATCH_BYTES)) {
      await preserveBlobBatch(repoRoot, directory, batch);
      count++;
      batch = []; bytes = 0;
    }
    batch.push(blob); bytes += blob.size;
  }
  if (batch.length) {
    await preserveBlobBatch(repoRoot, directory, batch);
    count++;
  }
  return count;
}

/**
 * cat-file의 크기 기반 프레임을 검증하고 binary·빈 blob·줄바꿈을 그대로 저장한다.
 * @param repoRoot 조회할 저장소 @param directory 소유 복구 디렉터리
 * @param batch 앞서 확인한 실제 index OID와 크기. 오류가 나면 복구 명령을 허용하지 않는다.
 */
async function preserveBlobBatch(repoRoot: string, directory: string, batch: RecoveryBlob[]): Promise<void> {
  const raw = await runGitBufferWithInput(["cat-file", "--batch"], repoRoot,
    `${batch.map(blob => blob.oid).join("\n")}\n`, { env: { GIT_NO_REPLACE_OBJECTS: "1" } });
  let offset = 0;
  const contents = batch.map(blob => {
    const headerEnd = raw.indexOf(10, offset);
    const end = headerEnd + 1 + blob.size;
    if (headerEnd < 0 || raw.toString("ascii", offset, headerEnd) !== `${blob.oid} blob ${blob.size}` || end >= raw.length || raw[end] !== 10) {
      throw new Error(`Incomplete index blob ${blob.oid} before Git recovery.`);
    }
    const content = raw.subarray(headerEnd + 1, end);
    offset = end + 1;
    return { oid: blob.oid, content };
  });
  if (offset !== raw.length) throw new Error("Unexpected index blob output before Git recovery.");
  await mapWithConcurrency(contents, RECOVERY_CONCURRENCY, async ({ oid, content }) => {
    await writeFile(path.join(directory, `${oid}.blob`), content, { mode: 0o600 });
  });
}
