// AI 커밋 분할 계획에 전달할 Git 변경 컨텍스트와 변경 스냅샷을 수집한다.
// - 실제 index를 수정하지 않으며, 모든 Git 접근은 gitExec의 runGit을 통해 수행한다.
import type { CommitPlanContext } from "../ai/commitPlanModel";
import { detectOperation } from "./conflictService";
import { parseNameStatusZ, parseNumstat, parsePorcelainGroups } from "./diffParse";
import { runGit, runGitBuffer } from "./gitExec";
import {
  cleanupCommitPlanIndex,
  commitPlanGitEnvironment,
  copyRealIndexToSibling,
} from "./aiCommitPlanIndexEntries";
import {
  AiCommitPlanError,
  computeCommitPlanSnapshot,
  fingerprintIndexEntries,
} from "./aiCommitPlanSafety";

/** Changes 커밋 메뉴에서 AI 계획이 지원하는 실행 범위다. */
export type AiCommitPlanOperation = "commit" | "staged" | "all";

/** 다른 계층이 같은 컨텍스트 타입을 이 모듈에서 가져올 수 있도록 모델 타입을 다시 노출한다. */
export type { CommitPlanContext } from "../ai/commitPlanModel";

/** 컨텍스트 수집 중 선택된 diff와 파일 통계를 한 번에 보관하는 내부 묶음이다. */
interface DiffSnapshotData {
  files: CommitPlanContext["files"];
  diff: string;
  binaryDiff: Buffer;
}

/** porcelain 한 번의 결과와 path별 staged/unstaged 상태를 보관하는 내부 묶음이다. */
interface WorkingStatus {
  raw: string;
  stagedPaths: Set<string>;
  unstagedPaths: Set<string>;
  stagedCount: number;
}

/** diff 출력 형식을 제외한 공통 옵션이다. 외부 diff/textconv 영향을 차단해 스냅샷을 재현 가능하게 만든다. */
const CACHED_DIFF_ARGS = [
  "diff",
  "--cached",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--full-index",
  "-M",
] as const;

/** AI CLI에 전달할 텍스트 diff 전체 상한이다. snapshot용 binary diff에는 적용하지 않는다. */
const MAX_CONTEXT_DIFF_CHARS = 32000;

/** 변경 의도를 파악하는 데 필요한 hunk 주변 문맥 줄 수다. 전체 파일 문맥을 과도하게 보내지 않는다. */
const AI_DIFF_CONTEXT_LINES = 5;

/** Git porcelain v1에서 병합 충돌을 나타내는 XY 상태 조합이다. */
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * 현재 변경을 AI 커밋 분할 계획용 컨텍스트로 읽는다.
 * - `commit`은 기존 smart commit 정책과 같게 staged 변경이 있으면 staged만, 없으면 전체를 사용한다.
 * - 기존 commit이 있는 local branch에서만 동작하며 detached/unborn HEAD는 publish 대상을 고정할 수 없어 거부한다.
 * - `staged`는 실제 index의 부분 스테이징 결과를 그대로 보존하고, `all`은 임시 index에 작업트리 전체를
 *   올려 현재 HEAD와 비교하므로 미추적 파일도 포함한다.
 * @param repoRoot 컨텍스트를 읽을 Git 저장소 루트 절대 경로
 * @param operation commit/staged/all 중 사용자가 선택한 커밋 정책
 * @returns 파일별 상태와 diff, 실행 직전 재검증에 사용할 불변 스냅샷
 */
export async function readAiCommitPlanContext(
  repoRoot: string,
  operation: AiCommitPlanOperation = "commit"
): Promise<CommitPlanContext> {
  await assertNoActiveOperation(repoRoot);
  const [head, branch, status, indexFingerprint] = await Promise.all([
    readHead(repoRoot),
    readBranch(repoRoot),
    readWorkingStatus(repoRoot),
    readAiCommitPlanIndexFingerprint(repoRoot),
  ]);
  assertSupportedHead(head, branch);
  assertNoConflicts(status.raw);
  const scope = resolveScope(operation, status.stagedCount);
  const data = scope === "staged"
    ? await readStagedDiff(repoRoot, head, status)
    : await readAllDiff(repoRoot, head, status);
  if (data.files.length === 0) {
    throw new Error(
      scope === "staged"
        ? "There are no staged changes to plan."
        : "There are no changes to plan."
    );
  }
  await assertNoActiveOperation(repoRoot);
  return {
    repoRoot,
    branch,
    head,
    scope,
    files: data.files,
    diff: data.diff,
    snapshot: computeCommitPlanSnapshot(
      head,
      scope,
      data.binaryDiff,
      indexFingerprint
    ),
  };
}

/**
 * 실제 index의 mode/blob/stage/path와 assume-unchanged/skip-worktree tag를 fingerprint로 읽는다.
 * - all scope도 외부 stage/unstage를 계획 동시성 변경으로 감지할 수 있도록 snapshot과 실행 fence가 공유한다.
 * @param repoRoot Git 저장소 루트
 * @returns 실제 index 엔트리의 SHA-256 fingerprint
 */
export async function readAiCommitPlanIndexFingerprint(
  repoRoot: string
): Promise<string> {
  const raw = await runGitBuffer(
    ["ls-files", "--stage", "-v", "-z"],
    repoRoot
  );
  return fingerprintIndexEntries(raw);
}

/**
 * 현재 HEAD가 붙은 symbolic ref 전체 이름을 읽는다.
 * - OID가 같은 다른 branch checkout이나 detached 전환도 실행 fence가 구분하도록 별도로 보존한다.
 * @param repoRoot Git 저장소 루트
 * @returns `refs/heads/...` 전체 이름 또는 detached HEAD이면 undefined
 */
export async function readAiCommitPlanHeadRef(
  repoRoot: string
): Promise<string | undefined> {
  const raw = await runGit(["symbolic-ref", "--quiet", "HEAD"], repoRoot)
    .catch(() => "");
  return raw.trim() || undefined;
}

/**
 * 지정 index와 고정 HEAD 사이의 전체 binary patch를 snapshot용 원본 바이트로 읽는다.
 * - all source index에는 미추적 파일 blob도 들어 있으므로 그 전체 내용까지 patch에 포함된다.
 * - text로 분류된 파일에도 잘못된 UTF-8 바이트가 들어갈 수 있어 문자열 decoding을 금지한다.
 * @param repoRoot Git 저장소 루트
 * @param head 컨텍스트 수집 시작에 고정한 born HEAD OID
 * @param env 선택적 GIT_INDEX_FILE 환경. 없으면 실제 index를 읽는다.
 * @returns rename과 임의 파일 바이트를 보존한 전체 cached patch Buffer
 */
export async function readAiCommitPlanBinaryDiff(
  repoRoot: string,
  head: string,
  env?: Record<string, string>
): Promise<Buffer> {
  return runGitBuffer(
    [...CACHED_DIFF_ARGS, "--patch", "--binary", head],
    repoRoot,
    env ? { env } : undefined
  );
}

/**
 * 사용자가 선택한 operation과 staged 파일 존재 여부로 실제 AI 계획 범위를 결정한다.
 * @param operation commit/staged/all 커밋 정책
 * @param stagedCount 현재 index에 변경이 있는 파일 수
 * @returns staged 변경만 계획할지 전체 작업트리를 계획할지 나타내는 범위
 */
function resolveScope(
  operation: AiCommitPlanOperation,
  stagedCount: number
): CommitPlanContext["scope"] {
  if (operation === "staged") {
    return "staged";
  }
  if (operation === "all") {
    return "all";
  }
  return stagedCount > 0 ? "staged" : "all";
}

/**
 * merge/rebase/cherry-pick/revert가 진행 중이면 일반 다중 커밋 계획 생성을 거부한다.
 * @param repoRoot Git 저장소 루트
 */
async function assertNoActiveOperation(repoRoot: string): Promise<void> {
  const operation = await detectOperation(repoRoot);
  if (operation !== "none") {
    throw new AiCommitPlanError(
      "active-operation",
      `Finish or abort the active ${operation} operation before creating an AI commit plan.`
    );
  }
}

/**
 * private detached transaction의 기준 commit과 최종 exact local branch ref가 없는 HEAD를 거부한다.
 * @param head 현재 HEAD commit OID. unborn이면 undefined
 * @param branch symbolic local branch short name 또는 detached 표시 HEAD
 */
function assertSupportedHead(
  head: string | undefined,
  branch: string
): asserts head is string {
  if (!head || branch === "HEAD") {
    throw new AiCommitPlanError(
      "unsupported-head",
      "AI commit plans require an existing commit on a checked-out local branch."
    );
  }
}

/**
 * HEAD가 가리키는 커밋을 읽는다. undefined는 호출부의 born-branch 검증에서 명시적으로 거부된다.
 * @param repoRoot Git 저장소 루트
 * @returns HEAD 전체 해시 또는 아직 commit이 없으면 undefined
 */
async function readHead(repoRoot: string): Promise<string | undefined> {
  const value = await runGit(["rev-parse", "--verify", "HEAD"], repoRoot)
    .catch(() => "");
  return value.trim() || undefined;
}

/**
 * 현재 브랜치 표시 이름을 읽는다. detached HEAD에서는 고정 문자열 HEAD를 사용한다.
 * @param repoRoot Git 저장소 루트
 * @returns 브랜치 짧은 이름 또는 HEAD
 */
async function readBranch(repoRoot: string): Promise<string> {
  const value = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot)
    .catch(() => "HEAD");
  return value.trim() || "HEAD";
}

/**
 * staged/unstaged 플래그와 충돌 여부 판단에 쓸 porcelain 상태를 한 번 읽는다.
 * @param repoRoot Git 저장소 루트
 * @returns 원문, path 집합, staged 파일 수
 */
async function readWorkingStatus(repoRoot: string): Promise<WorkingStatus> {
  const raw = await runGit(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    repoRoot
  );
  const groups = parsePorcelainGroups(raw);
  return {
    raw,
    stagedPaths: new Set(groups.staged.map((file) => file.path)),
    unstagedPaths: new Set(groups.unstaged.map((file) => file.path)),
    stagedCount: groups.staged.length,
  };
}

/**
 * porcelain XY 코드를 검사해 해결되지 않은 충돌이 있으면 AI 계획 생성을 거부한다.
 * @param raw `git status --porcelain=v1 -z` 원문
 */
function assertNoConflicts(raw: string): void {
  const tokens = raw.split("\0").filter(Boolean);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    // rename/copy의 뒤 토큰은 상태 접두사가 없는 oldPath이므로 상태 행으로 오인하지 않는다.
    if (token.length < 3 || token[2] !== " ") {
      continue;
    }
    const code = token.slice(0, 2);
    if (CONFLICT_CODES.has(code) || code.includes("U")) {
      throw new Error("Resolve merge conflicts before creating an AI commit plan.");
    }
    if (code.includes("R") || code.includes("C")) {
      index++;
    }
  }
}

/**
 * 실제 index와 HEAD 사이의 staged 변경을 부분 스테이징 내용 그대로 읽는다.
 * @param repoRoot Git 저장소 루트
 * @param status staged/unstaged path 플래그
 * @returns AI 표시용 patch와 전체 binary patch 기반 파일 메타데이터
 */
async function readStagedDiff(
  repoRoot: string,
  head: string,
  status: WorkingStatus
): Promise<DiffSnapshotData> {
  return readCachedDiff(repoRoot, head, status);
}

/**
 * 실제 index snapshot을 sibling 임시 index로 복제한 뒤 작업트리 전체를 stage해 변경을 읽는다.
 * - 실제 index를 쓰지 않으면서 assume-unchanged/skip-worktree와 split-index 기준을 그대로 보존한다.
 * @param repoRoot Git 저장소 루트
 * @param status staged/unstaged path 플래그
 * @returns 미추적 파일까지 포함한 최종 작업트리 diff
 */
async function readAllDiff(
  repoRoot: string,
  head: string,
  status: WorkingStatus
): Promise<DiffSnapshotData> {
  const indexPath = await copyRealIndexToSibling(repoRoot);
  const env = commitPlanGitEnvironment({ GIT_INDEX_FILE: indexPath });
  try {
    await runGit(["add", "-A"], repoRoot, { env });
    return await readCachedDiff(repoRoot, head, status, env);
  } finally {
    cleanupCommitPlanIndex(indexPath);
  }
}

/**
 * 선택된 index가 담은 변경을 name-status/numstat/텍스트 patch/binary patch 네 형식으로 읽는다.
 * @param repoRoot Git 저장소 루트
 * @param status 실제 작업트리의 staged/unstaged path 플래그
 * @param env GIT_INDEX_FILE 같은 선택적 Git 환경 변수
 * @returns 파일 메타데이터와 AI용 diff, 정확한 스냅샷용 binary diff
 */
async function readCachedDiff(
  repoRoot: string,
  head: string,
  status: WorkingStatus,
  env?: Record<string, string>
): Promise<DiffSnapshotData> {
  const options = env ? { env } : undefined;
  const base = [...CACHED_DIFF_ARGS];
  const [nameStatus, numstat, diff, binaryDiff] = await Promise.all([
    runGit([...base, "--name-status", "-z", head], repoRoot, options),
    runGit([...base, "--numstat", "-z", head], repoRoot, options),
    runGit([
      ...base,
      "--patch",
      `--unified=${AI_DIFF_CONTEXT_LINES}`,
      head,
    ], repoRoot, options),
    readAiCommitPlanBinaryDiff(repoRoot, head, env),
  ]);
  const counts = parseNumstat(numstat);
  const files = parseNameStatusZ(nameStatus)
    .map((file) => {
      const stat = counts.get(file.path);
      return {
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        additions: stat?.additions,
        deletions: stat?.deletions,
        staged: status.stagedPaths.has(file.path),
        unstaged: status.unstagedPaths.has(file.path),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  return { files, diff: balancedDiffExcerpt(diff), binaryDiff };
}

/**
 * 큰 patch를 파일별로 비슷한 문자 예산을 나눠 잘라 앞쪽 파일만 프롬프트를 독식하지 않게 한다.
 * - 전체가 상한 이하면 원문을 그대로 보존한다.
 * - 상한을 넘으면 `diff --git` 블록 수로 남은 예산을 균등 배분하고, 잘린 블록과 전체 끝에
 *   명시적인 marker를 붙인다. 정확한 변경 감지는 별도 full binary diff snapshot이 담당한다.
 * @param raw AI 설명에 사용할 전체 textual patch
 * @returns 최대 약 32KB 안에서 모든 파일을 순서대로 대표하는 deterministic excerpt
 */
function balancedDiffExcerpt(raw: string): string {
  if (raw.length <= MAX_CONTEXT_DIFF_CHARS) {
    return raw;
  }
  const blocks = splitDiffBlocks(raw);
  if (blocks.length <= 1) {
    return `${raw.slice(0, MAX_CONTEXT_DIFF_CHARS)}\n[diff truncated]`;
  }
  const finalMarker = "\n[diff truncated; each file received a balanced excerpt]";
  let remaining = MAX_CONTEXT_DIFF_CHARS - finalMarker.length;
  const excerpts: string[] = [];
  for (let index = 0; index < blocks.length && remaining > 0; index++) {
    const blocksLeft = blocks.length - index;
    const separatorLength = excerpts.length > 0 ? 2 : 0;
    const budget = Math.max(1, Math.floor((remaining - separatorLength) / blocksLeft));
    const block = blocks[index];
    const marker = "\n[file diff truncated]";
    const excerpt = block.length <= budget
      ? block
      : budget > marker.length
        ? `${block.slice(0, budget - marker.length)}${marker}`
        : block.slice(0, budget);
    if (separatorLength) {
      remaining -= separatorLength;
    }
    excerpts.push(excerpt);
    remaining -= excerpt.length;
  }
  return `${excerpts.join("\n\n")}${finalMarker}`;
}

/**
 * unified diff를 파일별 `diff --git` 블록으로 나눈다.
 * @param raw 여러 파일을 포함할 수 있는 textual patch
 * @returns 원래 파일 순서를 유지하는 diff 블록 배열
 */
function splitDiffBlocks(raw: string): string[] {
  const starts: number[] = [];
  const pattern = /^diff --git /gm;
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    starts.push(match.index);
  }
  if (starts.length === 0) {
    return [raw];
  }
  return starts.map((start, index) =>
    raw.slice(start, starts[index + 1] ?? raw.length).replace(/\s+$/, "")
  );
}
