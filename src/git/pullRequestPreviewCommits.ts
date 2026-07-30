// PR preview 의 Commits 탭과 로컬 PR 모의를 위한 commit/file diff 모델.
// - 기존 PR 은 GitHub commit API 를 사용하고, 로컬 preview 는 staged diff 만 synthetic commit 으로 만든다.
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

/** 기존/로컬 PR preview 위에 합칠 staged 파일과 synthetic commit 묶음이다. */
export interface StagedPullRequestPreviewOverlay {
  files: PullRequestPreviewFile[];
  commit?: PullRequestPreviewCommit;
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

const COMMIT_DETAIL_CONCURRENCY = 4;
// 로컬 PR preview 는 웹뷰에서 변경 없는 라인을 접어 보여주므로,
// git diff 단계에서는 충분히 넓은 context 를 받아 반복 펼치기로 전체에 가깝게 확인할 수 있게 한다.
const FULL_DIFF_CONTEXT_LINES = "100000";

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
  return mapLimited(pr.commitHashes, COMMIT_DETAIL_CONCURRENCY, (hash) =>
    readGithubCommit(cwd, owner, name, hash)
  );
}

/**
 * target branch 기준 로컬 source 커밋과 staged synthetic commit 으로 PR preview 를 만든다.
 * @param repoRoot git 저장소 루트
 * @param targetBranch PR 대상 브랜치
 * @param sourceRef PR 출발 브랜치/커밋
 * @param stagedFiles staged 변경 파일
 * @returns 전체 PR files 와 commit 별 files
 */
export async function buildLocalPullRequestPreview(
  repoRoot: string,
  targetBranch: string,
  sourceRef: string,
  stagedFiles: CommitFileChange[]
): Promise<{ files: PullRequestPreviewFile[]; commits: PullRequestPreviewCommit[] }> {
  const [indexedFiles, commits, stagedOverlay] = await Promise.all([
    stagedFiles.length
      ? buildIndexedPullRequestPreviewFiles(repoRoot, targetBranch, sourceRef)
      : Promise.resolve(undefined),
    readLocalCommitSummaries(repoRoot, targetBranch, sourceRef),
    buildStagedPullRequestPreviewOverlay(repoRoot, stagedFiles),
  ]);
  if (stagedOverlay.commit) {
    commits.push(stagedOverlay.commit);
  }
  const files = indexedFiles
    ?? await readRangeFiles(repoRoot, targetBranch, sourceRef);
  return { files, commits };
}

/**
 * 현재 index와 HEAD 사이의 staged delta를 preview 파일과 synthetic commit으로 만든다.
 * - 기존 GitHub PR preview도 같은 overlay를 사용해 Quick Edit 저장 결과를 새로고침 즉시 보여 준다.
 * @param repoRoot staged index를 읽을 저장소 루트
 * @param stagedFiles 이미 name-status/numstat을 붙인 staged 파일 목록
 * @returns 기존 preview에 합칠 staged 파일과 선택 synthetic commit
 */
export async function buildStagedPullRequestPreviewOverlay(
  repoRoot: string,
  stagedFiles: CommitFileChange[]
): Promise<StagedPullRequestPreviewOverlay> {
  if (!stagedFiles.length) {
    return { files: [] };
  }
  const stagedPatch = await runGit([
    "diff",
    "--cached",
    "--patch",
    "-M",
    `--unified=${FULL_DIFF_CONTEXT_LINES}`,
  ], repoRoot).catch(() => "");
  const files = applyPatches(stagedPreviewFiles(stagedFiles), stagedPatch);
  return {
    files,
    commit: {
      hash: "__gsc_staged_preview_commit__",
      shortHash: "staged",
      title: "Staged changes",
      author: "Working Tree",
      files,
      synthetic: true,
    },
  };
}

/**
 * GitHub 또는 로컬 PR preview에 staged overlay를 합치면서 기존 review comment를 보존한다.
 * @param files 기존 PR 전체 changed files
 * @param commits 기존 PR commit 목록
 * @param overlay 현재 index에서 만든 staged delta
 * @param indexedFiles merge-base에서 index까지 다시 계산한 최종 PR files
 * @returns 파일/commit 양쪽에 같은 staged 결과가 붙은 새 배열
 */
export function applyStagedPullRequestPreviewOverlay(
  files: PullRequestPreviewFile[],
  commits: PullRequestPreviewCommit[],
  overlay: StagedPullRequestPreviewOverlay,
  indexedFiles?: PullRequestPreviewFile[]
): { files: PullRequestPreviewFile[]; commits: PullRequestPreviewCommit[] } {
  return {
    files: indexedFiles === undefined
      ? [...files]
      : preservePreviewComments(indexedFiles, files),
    commits: overlay.commit ? [...commits, overlay.commit] : [...commits],
  };
}

/**
 * 로컬 commit 한 건의 changed files 를 lazy load 한다.
 * @param repoRoot git 저장소 루트
 * @param hash 파일 변경을 읽을 commit hash
 * @returns commit 의 파일 변경/patch 목록
 */
export async function fetchLocalCommitPreviewFiles(
  repoRoot: string,
  hash: string
): Promise<PullRequestPreviewFile[]> {
  if (!hash || hash === "__gsc_staged_preview_commit__") {
    return [];
  }
  return readLocalCommitFiles(repoRoot, hash);
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

/** target..HEAD 커밋 메타 목록을 오래된 순서부터 한 번에 읽는다. */
async function readLocalCommitSummaries(
  repoRoot: string,
  targetBranch: string,
  sourceRef: string
): Promise<PullRequestPreviewCommit[]> {
  const out = await runGit([
    "log",
    "--reverse",
    "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI",
    `${targetBranch}..${sourceRef}`,
  ], repoRoot).catch(() => "");
  return out.split("\n")
    .map(commitSummary)
    .filter((commit): commit is PullRequestPreviewCommit => Boolean(commit));
}

/** git log 한 줄을 commit preview 메타로 변환한다. */
function commitSummary(line: string): PullRequestPreviewCommit | undefined {
  const [fullHash, shortHash, title, author, dateIso] = line.trim().split("\x1f");
  if (!fullHash) {
    return undefined;
  }
  return {
    hash: fullHash,
    shortHash: shortHash || fullHash.slice(0, 7),
    title: title || fullHash.slice(0, 12),
    author,
    dateIso,
    files: [],
  };
}

/** 로컬 commit 한 건의 파일 patch 를 읽는다. */
async function readLocalCommitFiles(repoRoot: string, hash: string): Promise<PullRequestPreviewFile[]> {
  const out = await runGit([
    "show",
    "--format=",
    "--patch",
    "--no-ext-diff",
    "-M",
    `--unified=${FULL_DIFF_CONTEXT_LINES}`,
    hash,
  ], repoRoot).catch(() => "");
  if (!out) {
    return [];
  }
  return filesFromPatch(out.replace(/^\n/, ""));
}

/** target branch 기준 PR 전체 변경 파일을 읽는다. */
async function readRangeFiles(repoRoot: string, targetBranch: string, sourceRef: string): Promise<PullRequestPreviewFile[]> {
  const [nameStatus, numstat, patch] = await Promise.all([
    runGit(["diff", "--name-status", "-z", "-M", `${targetBranch}...${sourceRef}`], repoRoot).catch(() => ""),
    runGit(["diff", "--numstat", "-z", "-M", `${targetBranch}...${sourceRef}`], repoRoot).catch(() => ""),
    runGit(["diff", "--patch", "-M", `--unified=${FULL_DIFF_CONTEXT_LINES}`, `${targetBranch}...${sourceRef}`], repoRoot).catch(() => ""),
  ]);
  return filesFromDiff(nameStatus, numstat, patch);
}

/**
 * PR merge-base와 현재 index를 직접 비교해 commit 변경과 staged 변경이 합성된 최종 파일 diff를 만든다.
 * - 같은 파일의 연속 patch 문자열을 붙이지 않으므로 Quick Edit 결과가 원래 라인 번호에 반영된다.
 * @param repoRoot index와 refs를 읽을 저장소 루트
 * @param targetRef PR target branch/ref
 * @param sourceRef 현재 index가 기반한 source branch/ref
 * @returns 최종 파일 목록, merge-base를 찾지 못하면 안전한 fallback을 위한 undefined
 */
export async function buildIndexedPullRequestPreviewFiles(
  repoRoot: string,
  targetRef: string,
  sourceRef: string
): Promise<PullRequestPreviewFile[] | undefined> {
  const mergeBase = await runGit(
    ["merge-base", targetRef, sourceRef],
    repoRoot
  ).then((value) => value.trim(), () => "");
  if (!mergeBase) {
    return undefined;
  }
  const [nameStatus, numstat, patch] = await Promise.all([
    runGit(
      ["diff", "--cached", "--name-status", "-z", "-M", mergeBase, "--"],
      repoRoot
    ),
    runGit(
      ["diff", "--cached", "--numstat", "-z", "-M", mergeBase, "--"],
      repoRoot
    ),
    runGit([
      "diff",
      "--cached",
      "--patch",
      "-M",
      `--unified=${FULL_DIFF_CONTEXT_LINES}`,
      mergeBase,
      "--",
    ], repoRoot),
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

/** patch 본문만으로 commit changed file 목록과 증감 라인을 만든다. */
function filesFromPatch(patch: string): PullRequestPreviewFile[] {
  return splitPatchBlocks(patch).map((block) => {
    const path = pathFromDiffHeader(block[0] || "");
    const status = patchStatus(block);
    const rename = renamePaths(block);
    return {
      status,
      path: rename.to || path,
      oldPath: rename.from,
      additions: block.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
      deletions: block.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
      patch: block.join("\n"),
      comments: [],
    };
  }).filter((file) => file.path);
}

/** git patch 를 diff --git 블록 단위로 나눈다. */
function splitPatchBlocks(patch: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current.length) {
        blocks.push(current);
      }
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) {
    blocks.push(current);
  }
  return blocks;
}

/** patch header 로 파일 상태를 추정한다. */
function patchStatus(block: string[]): PullRequestPreviewFile["status"] {
  if (block.some((line) => line.startsWith("new file mode"))) {
    return "A";
  }
  if (block.some((line) => line.startsWith("deleted file mode"))) {
    return "D";
  }
  if (block.some((line) => line.startsWith("rename from "))) {
    return "R";
  }
  return "M";
}

/** rename patch 의 이전/새 경로를 읽는다. */
function renamePaths(block: string[]): { from?: string; to?: string } {
  const from = block.find((line) => line.startsWith("rename from "))?.slice("rename from ".length);
  const to = block.find((line) => line.startsWith("rename to "))?.slice("rename to ".length);
  return { from, to };
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

/**
 * 최종 index diff의 patch·통계·라인 좌표는 그대로 두고 기존 GitHub review comment만 path별로 복원한다.
 * @param indexedFiles merge-base에서 index까지 다시 계산한 최종 파일 목록
 * @param serverFiles GitHub가 제공한 기존 PR 파일과 comment
 * @returns 최종 patch에 기존 comment 배열을 붙인 새 파일 목록
 */
function preservePreviewComments(
  indexedFiles: PullRequestPreviewFile[],
  serverFiles: PullRequestPreviewFile[]
): PullRequestPreviewFile[] {
  const commentsByPath = new Map(
    serverFiles.map((file) => [file.path, file.comments || []] as const)
  );
  return indexedFiles.map((file) => ({
    ...file,
    comments: commentsByPath.get(file.path) || [],
  }));
}

/** commit message 의 첫 줄만 반환한다. */
function firstLine(message: string | undefined): string {
  return (message || "").split("\n")[0]?.trim() || "";
}

/** GitHub commit 조회 실패 시 최소 commit 표시를 만든다. */
function fallbackCommit(hash: string): PullRequestPreviewCommit {
  return { hash, shortHash: hash.slice(0, 7), title: hash.slice(0, 12), files: [] };
}

/**
 * 입력 배열을 제한된 동시성으로 변환한다.
 * @param values 처리할 값 목록
 * @param concurrency 동시에 실행할 작업 수
 * @param mapper 값 하나를 결과로 바꾸는 비동기 함수
 * @returns 입력 순서를 유지한 결과 배열
 */
async function mapLimited<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) {
        return;
      }
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
