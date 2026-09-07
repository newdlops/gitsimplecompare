// Git 중단/skip에서 폐기할 index와 작업 파일을 Git metadata 아래에 원본 바이트로 보존한다.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { readConflictWorkingLeaf } from "./conflictWorktreeCas";
import { runGit, runGitBuffer } from "./gitExec";
import { resolveSafeConflictWorkingPath } from "./conflictPathSafety";
import { recoveryOverwritePaths } from "./operationRecoveryPaths";
import { logInfo } from "../ui/outputLog";

/**
 * 충돌 해결/스테이징/추적되지 않은 파일의 원문과 index blob을 별도 디렉터리에 보존한다.
 * @param repoRoot 작업트리 루트
 * @param gitDir 현재 worktree의 실제 Git metadata 경로
 * @param action 복구 자료를 만든 이유
 * @returns 자료가 있으면 복구 manifest의 디렉터리. 보존 실패 시 Git 중단 명령도 실행하지 않는다.
 */
export async function preserveOperationEdits(repoRoot: string, gitDir: string, action: string, targets?: string[]): Promise<string | undefined> {
  const [changed, staged, untracked, index, overwritten] = await Promise.all([
    runGit(["diff", "HEAD", "--name-only", "-z"], repoRoot),
    runGit(["diff", "--cached", "--name-only", "-z"], repoRoot),
    runGit(["ls-files", "--others", "--exclude-standard", "-z"], repoRoot),
    runGit(["ls-files", "--stage", "-z"], repoRoot),
    recoveryOverwritePaths(repoRoot, gitDir, action, targets),
  ]);
  const files = [...new Set([...`${changed}\0${staged}\0${untracked}`.split("\0").filter(Boolean), ...overwritten])];
  if (!files.length) return undefined;
  const directory = path.join(gitDir, "gitsimplecompare", "operation-recovery", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = [];
  for (const [number, relative] of files.entries()) {
    const absolute = await resolveSafeConflictWorkingPath(repoRoot, relative).catch(error => {
      // 삭제된 부모 디렉터리는 absent leaf로 기록할 수 있지만 symlink/권한 오류는 허용하지 않는다.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(repoRoot, relative);
      throw error;
    });
    const leaf = await readConflictWorkingLeaf(absolute);
    if (leaf.kind === "nonfile") throw new Error(`Cannot safely preserve '${relative}' before ${action}.`);
    const dataFile = `${number}.data`;
    if (leaf.buffer) await writeFile(path.join(directory, dataFile), leaf.buffer, { mode: 0o600 });
    entries.push({ path: relative, kind: leaf.kind, mode: leaf.mode, dataFile: leaf.buffer ? dataFile : undefined });
  }
  const selected = new Set(files);
  const stages = index.split("\0").filter(entry => selected.has(entry.slice(entry.indexOf("\t") + 1)));
  const blobs = new Set(stages.map(entry => entry.split(" ")[1]).filter(Boolean));
  for (const oid of blobs) {
    await writeFile(path.join(directory, `${oid}.blob`), await runGitBuffer(["cat-file", "blob", oid], repoRoot), { mode: 0o600 });
  }
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ repoRoot, action, files: entries, index: stages }, null, 2), { mode: 0o600 });
  logInfo("git operation edits preserved", { repoRoot, action, recoveryDirectory: directory, files: files.length });
  return directory;
}
