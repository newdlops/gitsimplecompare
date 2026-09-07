// Git 중단/skip의 복귀 경로와 겹치는 ignored 파일만 찾아 보존 범위에 포함한다.
import { lstat, readFile } from "node:fs/promises";
import * as path from "node:path";
import { assertConflictRelativePath } from "./conflictPathSafety";
import { runGit } from "./gitExec";

/**
 * 복귀 커밋에서 바뀌는 경로를 조사하므로 node_modules 등 ignored 트리 전체를 순회하지 않는다.
 * @param repoRoot 작업트리 루트
 * @param gitDir 현재 worktree의 Git metadata 디렉터리
 * @param action abort/skip/undo. skip은 재적용할 중간 커밋의 경로도 포함한다.
 * @param targets Undo처럼 호출자가 이미 고정한 복귀 commit OID 목록
 * @returns 덮어쓸 수 있는 현재 파일/심볼릭 링크의 저장소 상대 경로
 */
export async function recoveryOverwritePaths(
  repoRoot: string, gitDir: string, action: string, targets?: string[]
): Promise<string[]> {
  const refs = targets ?? await recoveryTargets(gitDir, action);
  const names = new Set<string>();
  for (const target of new Set(refs)) {
    if (!/^[a-f0-9]{7,64}$/.test(target)) throw new Error("Cannot verify the Git recovery target. The operation was left unchanged.");
    const ref = target.length < 40 ? (await runGit(["rev-parse", "--verify", `${target}^{commit}`], repoRoot)).trim() : target;
    const changed = await runGit(["diff", "--name-only", "--no-renames", "-z", "HEAD", ref, "--"], repoRoot);
    for (const name of changed.split("\0")) if (name) names.add(name);
    if (action === "skip") {
      const replayed = await runGit(["log", "--format=", "--name-only", "--no-renames", "-m", "-z", `HEAD..${ref}`, "--"], repoRoot);
      for (const name of replayed.split("\0")) if (name) names.add(name);
    }
  }
  const paths = new Set<string>();
  for (const name of names) {
    const leaf = await recoveryLeaf(repoRoot, name);
    if (leaf) paths.add(leaf);
  }
  return [...paths];
}

/** Git이 사용하는 실제 복귀 marker만 읽고 오래된 ORIG_HEAD를 다른 작업에 적용하지 않는다. */
async function recoveryTargets(gitDir: string, action: string): Promise<string[]> {
  for (const directory of ["rebase-merge", "rebase-apply", "sequencer"]) {
    const original = await optionalMarker(path.join(gitDir, directory, directory === "sequencer" ? "head" : "orig-head"));
    if (!original) continue;
    const targets = [original];
    if (directory === "sequencer" && action === "skip") {
      const todo = await optionalMarker(path.join(gitDir, directory, "todo"));
      for (const line of todo?.split("\n") ?? []) {
        const hash = line.match(/^(?:pick|revert) ([a-f0-9]{7,64})(?: |$)/)?.[1];
        if (hash) targets.push(hash);
      }
    }
    return targets;
  }
  if (await optionalMarker(path.join(gitDir, "MERGE_HEAD"))) {
    const original = await optionalMarker(path.join(gitDir, "ORIG_HEAD"));
    if (!original) throw new Error("Cannot read the merge recovery target. The operation was left unchanged.");
    return [original];
  }
  return [];
}

/** 파일 부재만 정상으로 처리하고 권한·I/O 오류는 안전한 중단을 위해 전파한다. */
async function optionalMarker(file: string): Promise<string | undefined> {
  try { return (await readFile(file, "utf8")).trim() || undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/**
 * 부모 symlink를 따라가지 않고 Git이 교체할 실제 leaf를 찾는다.
 * @returns 경로가 없으면 undefined. 디렉터리 전체가 파일로 교체될 때는 보존 없이 진행하지 않는다.
 */
async function recoveryLeaf(repoRoot: string, relative: string): Promise<string | undefined> {
  assertConflictRelativePath(repoRoot, relative);
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.slice(0, i + 1).join("/");
    let info;
    try { info = await lstat(path.join(repoRoot, prefix)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (!info.isDirectory()) return prefix;
    if (i === parts.length - 1) {
      throw new Error(`Cannot safely preserve directory '${relative}' before Git recovery. Move or preserve it separately before retrying.`);
    }
  }
  return undefined;
}
