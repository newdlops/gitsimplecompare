// rebase continue 가 실패하거나 멈춘 상태를 세부 진단하는 git 서비스.
// - unmerged index, rebase message 의 conflict 목록, unresolved 파일 marker, staged/unstaged 불일치를 분리해 읽는다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { detectOperationInGitDir, type MergeOperation } from "./conflictService";
import { runGit } from "./gitExec";
import { listUnmergedFiles } from "./unmergedFiles";
import { findRebaseMarkerFiles } from "./rebaseMarkerScanner";
import { logInfo } from "../ui/outputLog";

/** rebase continue 판단에 필요한 작업트리/메타데이터 진단 결과 */
export interface RebaseContinueDiagnostics {
  operation: MergeOperation;
  unmergedFiles: string[];
  rebaseMessageConflicts: string[];
  markerFiles: string[];
  stagedFiles: string[];
  unstagedFiles: string[];
}

interface StatusEntry {
  x: string;
  y: string;
  path: string;
}

/**
 * 현재 rebase continue 상태를 진단한다.
 * - marker 검사는 Git 이 아직 unmerged 로 보는 파일에만 한정한다.
 *   사용자가 resolved 로 stage 한 뒤에는 marker 본문을 더 이상 continue 차단 근거로 쓰지 않는다.
 * - rebase message 의 `# Conflicts:` 목록은 index conflict 가 사라진 뒤에도 사용자가 확인해야 할 힌트로 유지한다.
 * @param repoRoot 저장소 루트
 */
export async function readRebaseContinueDiagnostics(
  repoRoot: string
): Promise<RebaseContinueDiagnostics> {
  const started = Date.now();
  const directory = readDiagnosticsGitDirectory(repoRoot);
  const [operation, unmergedFiles, statusOut, messageConflicts] = await Promise.all([
    directory.then(gitDir => gitDir ? detectOperationInGitDir(gitDir) : "none" as const).catch(() => "none" as const),
    listUnmergedFiles(repoRoot).catch(() => []),
    runGit(["status", "--porcelain=v1", "-z", "--untracked-files=no"], repoRoot,
      { GIT_OPTIONAL_LOCKS: "0" }).catch(() => ""),
    directory.then(readRebaseMessageConflicts),
  ]);
  const statusEntries = parseStatusEntries(statusOut);
  const stagedFiles = unique(
    statusEntries
      .filter((entry) => isStagedStatus(entry))
      .map((entry) => entry.path)
  );
  const unstagedFiles = unique(
    statusEntries
      .filter((entry) => isUnstagedStatus(entry))
      .map((entry) => entry.path)
  );
  const markerFiles = await findRebaseMarkerFiles(repoRoot, unmergedFiles);
  logInfo("rebase continue diagnostics read", { repoRoot, operation, unmerged: unmergedFiles.length,
    markers: markerFiles.length, staged: stagedFiles.length, unstaged: unstagedFiles.length, elapsedMs: Date.now() - started });
  return {
    operation,
    unmergedFiles,
    rebaseMessageConflicts: messageConflicts,
    markerFiles,
    stagedFiles,
    unstagedFiles,
  };
}

/**
 * 이번 진단에서 공유할 Git directory를 실제 Git에서 읽고 경로 끝의 공백·줄바꿈을 보존한다.
 * @param repoRoot 진단할 저장소 또는 linked worktree 루트
 * @returns 명령 출력의 마지막 줄바꿈 하나만 제거한 절대 경로. Git 조회 실패/빈 출력은 undefined
 */
async function readDiagnosticsGitDirectory(repoRoot: string): Promise<string | undefined> {
  const raw = (await runGit(["rev-parse", "--absolute-git-dir"], repoRoot).catch(() => "")).replace(/\r?\n$/, "");
  return raw ? path.resolve(repoRoot, raw) : undefined;
}

/**
 * rebase message 의 `# Conflicts:` 섹션에서 파일 목록을 읽는다.
 * @param gitDir 이번 진단에서 확인한 worktree 전용 Git directory
 */
async function readRebaseMessageConflicts(gitDir: string | undefined): Promise<string[]> {
  if (!gitDir) return [];
  const contents = await Promise.all(
    ["rebase-merge/message", "rebase-apply/final-commit"].map((rel) =>
      fs.readFile(path.join(gitDir, rel), "utf8").catch(() => "")
    )
  );
  return unique(contents.flatMap(parseConflictSection));
}

/**
 * commit message 의 conflict 섹션을 path 목록으로 변환한다.
 * @param raw rebase message 원문
 */
function parseConflictSection(raw: string): string[] {
  const files: string[] = [];
  let inConflicts = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^# Conflicts:\s*$/.test(line)) {
      inConflicts = true;
      continue;
    }
    if (!inConflicts) {
      continue;
    }
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (!match) {
      if (!line.startsWith("#")) {
        break;
      }
      continue;
    }
    const value = match[1].trim();
    if (value && !value.endsWith(":")) {
      files.push(value);
    }
  }
  return files;
}

/**
 * porcelain -z status 를 간단한 XY/path 목록으로 파싱한다.
 * @param out `git status --porcelain=v1 -z` 출력
 */
function parseStatusEntries(out: string): StatusEntry[] {
  const parts = out.split("\0").filter(Boolean);
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) {
      continue;
    }
    const x = entry[0] || " ";
    const y = entry[1] || " ";
    const filePath = entry.slice(3);
    entries.push({ x, y, path: filePath });
    if (x === "R" || x === "C") {
      i++;
    }
  }
  return entries;
}

/** status X 컬럼이 index 변경을 뜻하는지 확인한다. */
function isStagedStatus(entry: StatusEntry): boolean {
  return entry.x !== " " && entry.x !== "?" && entry.x !== "!";
}

/** status Y 컬럼이 working tree 변경을 뜻하는지 확인한다. */
function isUnstagedStatus(entry: StatusEntry): boolean {
  return entry.y !== " " && entry.y !== "?" && entry.y !== "!";
}

/** 순서를 유지한 중복 제거를 수행한다. */
function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
