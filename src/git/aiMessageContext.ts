// AI 메시지 생성에 필요한 git 변경 컨텍스트 수집 모듈.
// - UI/명령 레이어가 git CLI 세부 인자를 알지 않도록 git/ 경계 안에 둔다.
import { FileChange } from "./gitTypes";
import { parseNameStatusZ, parseNumstat } from "./diffParse";
import { runGit } from "./gitExec";

/** AI 커밋 메시지 생성에 사용할 변경 범위. */
export type AiCommitScope = "staged";

/** AI 프롬프트에 넣을 파일 변경 요약. */
export interface AiChangeFile extends FileChange {
  additions?: number;
  deletions?: number;
}

/** 커밋 메시지 생성을 위한 git 컨텍스트. */
export interface AiCommitMessageContext {
  repoRoot: string;
  branch: string;
  scope: AiCommitScope;
  files: AiChangeFile[];
  diff: string;
  status: string;
}

const MAX_DIFF_CHARS = 24000;
const MAX_STATUS_CHARS = 6000;

/**
 * 현재 저장소 변경으로 커밋 메시지 생성 컨텍스트를 만든다.
 * - 커밋 메시지는 사용자가 의도적으로 stage 한 변경만 요약한다.
 * - staged 변경이 없으면 UI 비활성화 상태와 맞춰 오류를 반환한다.
 * @param repoRoot git 저장소 루트
 * @returns AI 프롬프트에 넣을 변경 컨텍스트
 */
export async function readCommitMessageContext(
  repoRoot: string
): Promise<AiCommitMessageContext> {
  const [branch, staged] = await Promise.all([
    currentBranch(repoRoot),
    readDiffFiles(repoRoot, ["diff", "--cached"]),
  ]);
  if (staged.length > 0) {
    const [diff, status] = await Promise.all([
      runGit(["diff", "--cached", "--patch", "-M", "--unified=30"], repoRoot)
        .catch(() => ""),
      runGit(["status", "--short"], repoRoot).catch(() => ""),
    ]);
    return commitContext(repoRoot, branch, "staged", staged, diff, status);
  }
  throw new Error("Stage changes before generating an AI commit message.");
}

/**
 * diff 계열 명령의 name-status/numstat 출력을 합쳐 파일 목록을 만든다.
 * @param repoRoot git 저장소 루트
 * @param baseArgs `git` 뒤에 붙일 diff 기본 인자
 */
async function readDiffFiles(
  repoRoot: string,
  baseArgs: string[]
): Promise<AiChangeFile[]> {
  const [nameStatus, numstat] = await Promise.all([
    runGit([...baseArgs, "--name-status", "-z", "-M"], repoRoot).catch(() => ""),
    runGit([...baseArgs, "--numstat", "-z", "-M"], repoRoot).catch(() => ""),
  ]);
  return withCounts(parseNameStatusZ(nameStatus), parseNumstat(numstat));
}

/**
 * 파일 변경 목록에 numstat 라인 수를 병합한다.
 * @param files name-status 또는 porcelain 에서 얻은 파일 목록
 * @param counts path 별 추가/삭제 라인 수
 */
function withCounts(
  files: FileChange[],
  counts: Map<string, { additions: number; deletions: number }>
): AiChangeFile[] {
  return files.map((file) => {
    const stat = counts.get(file.path);
    return { ...file, additions: stat?.additions, deletions: stat?.deletions };
  });
}

/**
 * 컨텍스트 객체를 만들고 비어 있는 변경은 오류로 알린다.
 * @param repoRoot git 저장소 루트
 * @param branch 현재 브랜치 이름
 * @param scope staged 또는 working 범위
 * @param files 변경 파일 목록
 * @param diff patch 본문
 * @param status git status 요약
 */
function commitContext(
  repoRoot: string,
  branch: string,
  scope: AiCommitScope,
  files: AiChangeFile[],
  diff: string,
  status: string
): AiCommitMessageContext {
  if (files.length === 0 && !diff.trim() && !status.trim()) {
    throw new Error("No changes are available for AI commit message generation.");
  }
  return {
    repoRoot,
    branch,
    scope,
    files,
    diff: clip(diff, MAX_DIFF_CHARS),
    status: clip(status, MAX_STATUS_CHARS),
  };
}

/**
 * 현재 브랜치 이름을 읽는다. detached HEAD 는 HEAD 로 표시한다.
 * @param repoRoot git 저장소 루트
 */
async function currentBranch(repoRoot: string): Promise<string> {
  const out = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)
    .catch(() => "HEAD");
  return out.trim() || "HEAD";
}

/**
 * 긴 텍스트를 프롬프트 한도 안으로 자른다.
 * @param text 원문
 * @param maxChars 최대 문자 수
 */
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}
