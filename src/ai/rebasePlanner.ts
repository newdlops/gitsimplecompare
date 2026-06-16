// AI CLI 를 사용해 graph interactive rebase 계획을 제안하는 모듈.
// - 커밋 수가 많을 때 한 번에 보내지 않고 여러 세션으로 나눠 토큰 사용량과 실패 범위를 줄인다.
import * as vscode from "vscode";
import type {
  RebaseAction,
  RebaseCommitFile,
} from "../git/rebaseService";
import { logInfo } from "../ui/outputLog";
import { readAiCliConfig } from "./cliConfig";
import { runAiCliPrompt } from "./cliRunner";

/** AI rebase 요청에 포함할 커밋 한 건 */
export interface AiRebasePlanCommit {
  hash: string;
  subject: string;
  body?: string;
  action?: RebaseAction;
  message?: string;
  files: RebaseCommitFile[];
}

/** AI rebase 요청 전체 컨텍스트 */
export interface AiRebasePlanRequest {
  branch: string;
  base?: string;
  root?: boolean;
  onto?: string;
  commits: AiRebasePlanCommit[];
}

/** AI 가 제안한 커밋별 rebase 항목 */
export interface AiRebasePlanSuggestion {
  hash: string;
  action: RebaseAction;
  message?: string;
  module?: string;
  reason?: string;
}

/** 여러 AI 세션 결과를 합친 최종 rebase 제안 */
export interface AiRebasePlanResult {
  items: AiRebasePlanSuggestion[];
  sessionCount: number;
}

/** 한 AI CLI 호출에 넣을 최대 커밋 수 */
const COMMITS_PER_SESSION = 10;
/** 경고를 띄울 전체 커밋 수 */
const LARGE_REBASE_COMMIT_WARNING = 20;
/** 경고를 띄울 전체 파일 변경 수 */
const LARGE_REBASE_FILE_WARNING = 160;
/** AI 응답이 과도하게 길 때 파싱 전에 자를 최대 길이 */
const MAX_RESPONSE_CHARS = 30000;

/**
 * AI rebase 가 큰 요청인지 판단해 사용자 경고 문구를 만든다.
 * @param request 현재 graph rebase 계획
 * @returns 경고가 필요하면 메시지, 아니면 undefined
 */
export function aiRebaseUsageWarning(
  request: AiRebasePlanRequest
): string | undefined {
  const commits = request.commits.length;
  const files = request.commits.reduce((sum, commit) => sum + commit.files.length, 0);
  const sessions = chunkCommits(request.commits).length;
  if (commits < LARGE_REBASE_COMMIT_WARNING && files < LARGE_REBASE_FILE_WARNING && sessions <= 1) {
    return undefined;
  }
  return vscode.l10n.t(
    "AI rebase will send {0} commit(s) and {1} file summaries across {2} AI session(s). This may use many tokens.",
    commits,
    files,
    sessions
  );
}

/**
 * AI CLI 로 rebase 계획을 생성한다.
 * @param request 현재 graph rebase 계획
 * @param repoRoot git 저장소 루트
 * @param token 취소 토큰
 * @returns 세션별 응답을 합친 rebase 제안
 */
export async function generateAiRebasePlan(
  request: AiRebasePlanRequest,
  repoRoot: string,
  token: vscode.CancellationToken
): Promise<AiRebasePlanResult> {
  const chunks = chunkCommits(request.commits);
  logInfo("AI rebase plan requested", {
    repoRoot,
    branch: request.branch,
    commits: request.commits.length,
    sessions: chunks.length,
  });
  const items: AiRebasePlanSuggestion[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const response = await runAiCliPrompt(
      rebasePrompt(request, chunks[index], index + 1, chunks.length),
      repoRoot,
      token
    );
    items.push(...normalizeSessionResult(chunks[index], response.text));
  }
  logInfo("AI rebase plan completed", {
    repoRoot,
    branch: request.branch,
    commits: request.commits.length,
    sessions: chunks.length,
  });
  return { items, sessionCount: chunks.length };
}

/**
 * 커밋 목록을 세션 크기별로 나눈다.
 * @param commits rebase 대상 커밋 목록
 */
function chunkCommits(commits: AiRebasePlanCommit[]): AiRebasePlanCommit[][] {
  const chunks: AiRebasePlanCommit[][] = [];
  for (let index = 0; index < commits.length; index += COMMITS_PER_SESSION) {
    chunks.push(commits.slice(index, index + COMMITS_PER_SESSION));
  }
  return chunks;
}

/**
 * AI rebase planner 프롬프트를 만든다.
 * @param request 전체 rebase 컨텍스트
 * @param commits 현재 세션에 보낼 커밋 목록
 * @param session 현재 세션 번호
 * @param totalSessions 전체 세션 수
 */
function rebasePrompt(
  request: AiRebasePlanRequest,
  commits: AiRebasePlanCommit[],
  session: number,
  totalSessions: number
): string {
  const config = readAiCliConfig();
  return [
    "Plan an interactive git rebase for the commits in this session.",
    "Return strict JSON only with this shape:",
    '{"items":[{"hash":"...","action":"pick|reword|squash|fixup|drop","message":"optional full commit message","module":"optional module label","reason":"short reason"}]}',
    "Rules:",
    "- Only use hashes from this session. Do not invent commits.",
    "- The order of items is the proposed todo order for this session.",
    "- Reorder only when it improves module grouping or logical history.",
    "- Use reword when the commit message should be improved.",
    "- Use squash/fixup only for adjacent commits that clearly belong together.",
    "- Do not drop commits unless they are clearly redundant.",
    "- module should be a concise file-area label such as src/git, media/graph, docs, or tests.",
    "- Keep commit message subject under 72 characters.",
    `- Write messages in ${config.responseLanguage}.`,
    "- Do not run commands or modify files. Use only the supplied context.",
    ...instructionLines(config.commonInstructions),
    "",
    `Branch: ${request.branch}`,
    `Base: ${request.root ? "root" : request.base || "unknown"}`,
    `Onto: ${request.onto || "(none)"}`,
    `Session: ${session} of ${totalSessions}`,
    "",
    "Commits:",
    commits.map(commitText).join("\n\n"),
  ].join("\n");
}

/**
 * 커밋 한 건을 프롬프트에 넣을 요약 텍스트로 만든다.
 * @param commit rebase 대상 커밋
 */
function commitText(commit: AiRebasePlanCommit): string {
  const message = commit.body ? `${commit.subject}\n${commit.body}` : commit.subject;
  return [
    `Hash: ${commit.hash}`,
    `Current action: ${commit.action || "pick"}`,
    `Current message:\n${message || "(empty)"}`,
    "Files:",
    commit.files.length ? commit.files.map(fileText).join("\n") : "(none)",
  ].join("\n");
}

/** 파일 변경 한 건을 프롬프트용 한 줄로 만든다. */
function fileText(file: RebaseCommitFile): string {
  const renamed = file.oldPath ? ` from ${file.oldPath}` : "";
  return `- ${file.status} ${file.path}${renamed} (+${file.additions}/-${file.deletions})`;
}

/**
 * AI 응답을 현재 세션 커밋 목록에 맞게 검증하고 누락 커밋은 pick 으로 보정한다.
 * @param commits 현재 세션 커밋 목록
 * @param raw AI CLI 응답 원문
 */
function normalizeSessionResult(
  commits: AiRebasePlanCommit[],
  raw: string
): AiRebasePlanSuggestion[] {
  const known = new Map(commits.map((commit) => [commit.hash, commit]));
  const parsed = parseItems(raw);
  const seen = new Set<string>();
  const result: AiRebasePlanSuggestion[] = [];
  for (const item of parsed) {
    const hash = String(item.hash || "");
    if (!known.has(hash) || seen.has(hash)) {
      continue;
    }
    seen.add(hash);
    result.push(normalizeItem(hash, item));
  }
  for (const commit of commits) {
    if (!seen.has(commit.hash)) {
      result.push({ hash: commit.hash, action: "pick" });
    }
  }
  return fixLeadingAutosquash(result);
}

/** 응답 JSON 에서 items 배열을 읽는다. */
function parseItems(raw: string): Array<Record<string, unknown>> {
  const json = jsonObjectText(stripFence(raw.slice(0, MAX_RESPONSE_CHARS)));
  if (!json) {
    throw new Error(vscode.l10n.t("AI CLI did not return a rebase plan."));
  }
  const parsed = JSON.parse(json) as { items?: Array<Record<string, unknown>> };
  return Array.isArray(parsed.items) ? parsed.items : [];
}

/** AI item 한 건을 지원 action/message/module 형태로 보정한다. */
function normalizeItem(hash: string, item: Record<string, unknown>): AiRebasePlanSuggestion {
  const message = String(item.message || "").trim();
  let action = normalizeAction(String(item.action || "pick"));
  if (message && action === "pick") {
    action = "reword";
  }
  return {
    hash,
    action,
    message: message || undefined,
    module: stringValue(item.module),
    reason: stringValue(item.reason),
  };
}

/** 첫 항목은 squash/fixup 대상이 없으므로 pick/reword 로 보정한다. */
function fixLeadingAutosquash(items: AiRebasePlanSuggestion[]): AiRebasePlanSuggestion[] {
  if (items[0]?.action === "squash" || items[0]?.action === "fixup") {
    items[0] = {
      ...items[0],
      action: items[0].message ? "reword" : "pick",
    };
  }
  return items;
}

/** 문자열 필드를 공백 제거 후 optional 값으로 반환한다. */
function stringValue(value: unknown): string | undefined {
  const text = String(value || "").trim();
  return text || undefined;
}

/** action 문자열을 지원 값으로 보정한다. */
function normalizeAction(value: string): RebaseAction {
  if (value === "reword" || value === "edit" || value === "squash" || value === "fixup" || value === "drop") {
    return value;
  }
  return "pick";
}

/** 사용자 설정 추가 지시문을 프롬프트 Rules 줄로 바꾼다. */
function instructionLines(value: string): string[] {
  return value.trim()
    ? value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => `- ${line}`)
    : [];
}

/** markdown code fence 로 감싼 응답이면 내부 텍스트만 반환한다. */
function stripFence(value: string): string {
  const text = value.trim();
  const match = /^```(?:json|text)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match ? match[1].trim() : text;
}

/** 응답에서 JSON 객체로 보이는 부분만 잘라낸다. */
function jsonObjectText(value: string): string | undefined {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start >= 0 && end > start ? value.slice(start, end + 1) : undefined;
}
