// PR preview 의 Commits 탭과 staged PR 모의를 위한 commit/file diff 모델.
// - 기존 PR 은 GitHub commit API 를 사용하고, staged preview 는 로컬 git diff 로 synthetic commit 을 만든다.
import { CommitFileChange } from "../graph/graphTypes";
import { parseNameStatusZ, parseNumstat } from "./diffParse";
import { runGh } from "./ghCli";
import { runGit } from "./gitExec";
import { splitRepositoryName } from "./githubRepository";
import {
  normalizePreviewStatus,
  PullRequestPreviewFile,
} from "./pullRequestPreviewFiles";

/** PR preview Commits 탭에서 클릭 가능한 commit 한 건 */
export interface PullRequestPreviewCommit {
  hash: string;
  shortHash: string;
  title: string;
  author?: string;
  dateIso?: string;
  files: PullRequestPreviewFile[];
  synthetic?: boolean;
}

interface PreviewPullRequestRef {
  number?: number;
  commitHashes?: string[];
}

interface GhCommitDetail {
  sha?: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
  };
  files?: Array<{
    filename?: string;
    previous_filename?: string;
    status?: string;
    additions?: number;
    deletions?: number;
    patch?: string;
  }>;
}

/**
 * 기존 GitHub PR 의 commit 목록을 파일 patch 와 함께 읽는다.
 * @param cwd gh 실행 경로
 * @param repository owner/name 저장소 이름
 * @param pr 기존 PR 정보
 * @returns commit 별 changed files 데이터
 */
export async function fetchExistingPullRequestCommits(
  cwd: string,
  repository: string | undefined,
  pr: PreviewPullRequestRef | undefined
): Promise<PullRequestPreviewCommit[]> {
  if (!repository || !pr?.commitHashes?.length) {
    return [];
  }
  const [owner, name] = splitRepositoryName(repository);
  return Promise.all(
    pr.commitHashes.map((hash) => readGithubCommit(cwd, owner, name, hash))
  );
}

/**
 * target branch 기준 로컬 HEAD 커밋과 staged synthetic commit 으로 PR preview 를 만든다.
 * @param repoRoot git 저장소 루트
 * @param targetBranch PR 대상 브랜치
 * @param stagedFiles staged 변경 파일
 * @returns 전체 PR files 와 commit 별 files
 */
export async function buildLocalPullRequestPreview(
  repoRoot: string,
  targetBranch: string,
  stagedFiles: CommitFileChange[]
): Promise<{ files: PullRequestPreviewFile[]; commits: PullRequestPreviewCommit[] }> {
  const [baseFiles, commitHashes, stagedPatch] = await Promise.all([
    readRangeFiles(repoRoot, targetBranch),
    readLocalCommitHashes(repoRoot, targetBranch),
    runGit(["diff", "--cached", "--patch", "-M", "--unified=80"], repoRoot).catch(() => ""),
  ]);
  const commits = await Promise.all(commitHashes.map((hash) => readLocalCommit(repoRoot, hash)));
  let stagedSyntheticFiles: PullRequestPreviewFile[] = [];
  if (stagedFiles.length) {
    stagedSyntheticFiles = applyPatches(stagedPreviewFiles(stagedFiles), stagedPatch);
    commits.push({
      hash: "__gsc_staged_preview_commit__",
      shortHash: "staged",
      title: "Staged changes",
      author: "Working Tree",
      files: stagedSyntheticFiles,
      synthetic: true,
    });
  }
  return { files: mergePreviewFiles(baseFiles, stagedSyntheticFiles), commits };
}

/**
 * preview file 배열에서 표시용 stat 문자열을 만든다.
 * @param files preview changed files
 * @returns GitHub diff stat 에 가까운 요약 문자열
 */
export function previewStat(files: PullRequestPreviewFile[]): string {
  const additions = files.reduce((sum, file) => sum + (file.additions || 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions || 0), 0);
  return `${files.length} files changed, ${additions} additions, ${deletions} deletions`;
}

/**
 * commit preview 를 기존 문자열 commit 목록 형태로 변환한다.
 * @param commits commit preview 배열
 * @returns `shortHash title` 배열
 */
export function commitLabels(commits: PullRequestPreviewCommit[]): string[] {
  return commits.map((commit) => `${commit.shortHash} ${commit.title}`.trim());
}

/** GitHub commit API 한 건을 preview commit 으로 변환한다. */
async function readGithubCommit(
  cwd: string,
  owner: string,
  name: string,
  hash: string
): Promise<PullRequestPreviewCommit> {
  const out = await runGh(["api", `repos/${owner}/${name}/commits/${hash}`], cwd).catch(() => "");
  if (!out) {
    return fallbackCommit(hash);
  }
  const parsed = JSON.parse(out) as GhCommitDetail;
  const fullHash = parsed.sha || hash;
  return {
    hash: fullHash,
    shortHash: fullHash.slice(0, 7),
    title: firstLine(parsed.commit?.message) || fullHash.slice(0, 12),
    author: parsed.commit?.author?.name,
    dateIso: parsed.commit?.author?.date,
    files: (parsed.files || []).map((file) => ({
      status: normalizePreviewStatus(file.status),
      path: file.filename || "",
      oldPath: file.previous_filename,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      patch: file.patch,
      comments: [],
    })),
  };
}

/** target..HEAD 커밋 해시 목록을 오래된 순서부터 읽는다. */
async function readLocalCommitHashes(repoRoot: string, targetBranch: string): Promise<string[]> {
  const out = await runGit(["log", "--reverse", "--format=%H", `${targetBranch}..HEAD`], repoRoot).catch(() => "");
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** 로컬 commit 한 건을 파일 patch 와 함께 읽는다. */
async function readLocalCommit(repoRoot: string, hash: string): Promise<PullRequestPreviewCommit> {
  const [meta, files] = await Promise.all([
    runGit(["show", "-s", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI", hash], repoRoot),
    readCommitFiles(repoRoot, hash),
  ]);
  const [fullHash, shortHash, title, author, dateIso] = meta.trim().split("\x1f");
  return { hash: fullHash || hash, shortHash: shortHash || hash.slice(0, 7), title: title || hash, author, dateIso, files };
}

/** commit 하나의 변경 파일과 patch 를 읽는다. */
async function readCommitFiles(repoRoot: string, hash: string): Promise<PullRequestPreviewFile[]> {
  const [nameStatus, numstat, patch] = await Promise.all([
    runGit(["diff-tree", "--no-commit-id", "--name-status", "-z", "-M", "-r", hash], repoRoot).catch(() => ""),
    runGit(["diff-tree", "--no-commit-id", "--numstat", "-M", "-r", hash], repoRoot).catch(() => ""),
    runGit(["show", "--format=", "--patch", "-M", "--unified=80", hash], repoRoot).catch(() => ""),
  ]);
  return filesFromDiff(nameStatus, numstat, patch);
}

/** target branch 기준 PR 전체 변경 파일을 읽는다. */
async function readRangeFiles(repoRoot: string, targetBranch: string): Promise<PullRequestPreviewFile[]> {
  const [nameStatus, numstat, patch] = await Promise.all([
    runGit(["diff", "--name-status", "-z", "-M", `${targetBranch}...HEAD`], repoRoot).catch(() => ""),
    runGit(["diff", "--numstat", "-M", `${targetBranch}...HEAD`], repoRoot).catch(() => ""),
    runGit(["diff", "--patch", "-M", "--unified=80", `${targetBranch}...HEAD`], repoRoot).catch(() => ""),
  ]);
  return filesFromDiff(nameStatus, numstat, patch);
}

/** name-status/numstat/patch 출력을 preview file 배열로 합친다. */
function filesFromDiff(nameStatus: string, numstat: string, patch: string): PullRequestPreviewFile[] {
  const counts = parseNumstat(numstat);
  const patches = patchByPath(patch);
  return parseNameStatusZ(nameStatus).map((file) => ({
    status: file.status,
    path: file.path,
    oldPath: file.oldPath,
    additions: counts.get(file.path)?.additions ?? 0,
    deletions: counts.get(file.path)?.deletions ?? 0,
    patch: patches.get(file.path),
    comments: [],
  }));
}

/** staged 변경 파일에 patch 본문을 붙인다. */
function applyPatches(files: PullRequestPreviewFile[], patch: string): PullRequestPreviewFile[] {
  const patches = patchByPath(patch);
  return files.map((file) => ({ ...file, patch: patches.get(file.path) }));
}

/** staged 파일을 preview file 형태로 바꾼다. */
function stagedPreviewFiles(files: CommitFileChange[]): PullRequestPreviewFile[] {
  return files.map((file) => ({ ...file, comments: [] }));
}

/** diff --git 블록을 현재 파일 path 기준 patch 맵으로 나눈다. */
function patchByPath(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  let current = "";
  let lines: string[] = [];
  for (const line of raw.split("\n")) {
    const next = pathFromDiffHeader(line);
    if (next) {
      if (current && lines.length) {
        map.set(current, lines.join("\n"));
      }
      current = next;
      lines = [line];
    } else if (current) {
      lines.push(line);
    }
  }
  if (current && lines.length) {
    map.set(current, lines.join("\n"));
  }
  return map;
}

/** diff --git header 에서 b/ 경로를 추출한다. */
function pathFromDiffHeader(line: string): string {
  const match = /^diff --git a\/.+ b\/(.+)$/.exec(line);
  return match ? unquotePath(match[1]) : "";
}

/** git 이 quote 한 단순 경로 표기를 사람이 보는 경로로 되돌린다. */
function unquotePath(path: string): string {
  return path.replace(/^"|"$/g, "").replace(/\\"/g, "\"");
}

/** 같은 path 의 파일 항목을 하나로 합친다. */
function mergePreviewFiles(...groups: PullRequestPreviewFile[][]): PullRequestPreviewFile[] {
  const byPath = new Map<string, PullRequestPreviewFile>();
  for (const file of groups.flat()) {
    const previous = byPath.get(file.path);
    byPath.set(file.path, previous ? mergeFile(previous, file) : file);
  }
  return Array.from(byPath.values());
}

/** 같은 파일의 누적 diff 정보를 합친다. */
function mergeFile(a: PullRequestPreviewFile, b: PullRequestPreviewFile): PullRequestPreviewFile {
  return {
    ...a,
    status: b.status || a.status,
    additions: (a.additions || 0) + (b.additions || 0),
    deletions: (a.deletions || 0) + (b.deletions || 0),
    patch: [a.patch, b.patch].filter(Boolean).join("\n"),
    comments: [...(a.comments || []), ...(b.comments || [])],
  };
}

/** commit message 의 첫 줄만 반환한다. */
function firstLine(message: string | undefined): string {
  return (message || "").split("\n")[0]?.trim() || "";
}

/** GitHub commit 조회 실패 시 최소 commit 표시를 만든다. */
function fallbackCommit(hash: string): PullRequestPreviewCommit {
  return { hash, shortHash: hash.slice(0, 7), title: hash.slice(0, 12), files: [] };
}
