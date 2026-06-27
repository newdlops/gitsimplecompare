// rebase continue 가 실패하거나 멈춘 상태를 세부 진단하는 git 서비스.
// - unmerged index, rebase message 의 conflict 목록, unresolved 파일 marker, staged/unstaged 불일치를 분리해 읽는다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { detectOperation, type MergeOperation } from "./conflictService";
import { containsConflictMarkers } from "./conflictMarkers";
import { runGit } from "./gitExec";

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

const MAX_MARKER_SCAN_BYTES = 2 * 1024 * 1024;

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
  const [operation, unmergedFiles, statusOut, messageConflicts] = await Promise.all([
    detectOperation(repoRoot).catch(() => "none" as const),
    readUnmergedFiles(repoRoot),
    runGit(["status", "--porcelain=v1", "-z"], repoRoot).catch(() => ""),
    readRebaseMessageConflicts(repoRoot),
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
  const markerFiles = await findMarkerFiles(repoRoot, unmergedFiles);
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
 * git index 에 남은 unmerged path 를 읽는다.
 * @param repoRoot 저장소 루트
 */
async function readUnmergedFiles(repoRoot: string): Promise<string[]> {
  const out = await runGit(
    ["diff", "--name-only", "--diff-filter=U", "-z"],
    repoRoot
  ).catch(() => "");
  return unique(out.split("\0").filter(Boolean));
}

/**
 * rebase message 의 `# Conflicts:` 섹션에서 파일 목록을 읽는다.
 * @param repoRoot 저장소 루트
 */
async function readRebaseMessageConflicts(repoRoot: string): Promise<string[]> {
  const contents = await Promise.all(
    ["rebase-merge/message", "rebase-apply/final-commit"].map((rel) =>
      readGitPath(repoRoot, rel)
    )
  );
  return unique(contents.flatMap(parseConflictSection));
}

/**
 * git metadata 상대 경로를 읽는다. 없으면 빈 문자열을 반환한다.
 * @param repoRoot 저장소 루트
 * @param rel      git metadata 상대 경로
 */
async function readGitPath(repoRoot: string, rel: string): Promise<string> {
  const raw = (await runGit(["rev-parse", "--git-path", rel], repoRoot).catch(() => "")).trim();
  if (!raw) {
    return "";
  }
  return fs.readFile(path.resolve(repoRoot, raw), "utf8").catch(() => "");
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

/**
 * 아직 unmerged 인 후보 파일 본문에 conflict marker 줄이 남아 있는지 찾는다.
 * @param repoRoot 저장소 루트
 * @param files    검사할 저장소 상대 경로 목록
 */
async function findMarkerFiles(repoRoot: string, files: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const file of files) {
    if (!isSafeRelativePath(file)) {
      continue;
    }
    const abs = path.resolve(repoRoot, file);
    const stat = await fs.stat(abs).catch(() => undefined);
    if (!stat?.isFile() || stat.size > MAX_MARKER_SCAN_BYTES) {
      continue;
    }
    const content = await fs.readFile(abs, "utf8").catch(() => undefined);
    if (!content || content.includes("\0")) {
      continue;
    }
    if (containsConflictMarkers(content)) {
      found.push(file);
    }
  }
  return unique(found);
}

/** 저장소 밖 경로 접근을 막기 위해 상대 경로 형태인지 확인한다. */
function isSafeRelativePath(file: string): boolean {
  return Boolean(file && !path.isAbsolute(file) && !file.split(/[\\/]/).includes(".."));
}

/** 순서를 유지한 중복 제거를 수행한다. */
function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
