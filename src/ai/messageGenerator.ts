// AI CLI 를 사용해 커밋/PR 메시지를 생성한다.
// - git diff 수집과 웹뷰 렌더링에서 분리해, 여러 UI에서 같은 생성 로직을 재사용할 수 있게 한다.
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import type {
  AiChangeFile,
  AiCommitMessageContext,
} from "../git/aiMessageContext";
import type { StagedPullRequestPreview } from "../git/pullRequestService";
import { readAiCliConfig } from "./cliConfig";
import { runAiCliPrompt } from "./cliRunner";
import { commitMessageGuidelines } from "./commitMessageGuidance";
import { logInfo } from "../ui/outputLog";

/** AI가 생성한 PR 제목/본문 묶음. */
export interface GeneratedPullRequestMessage {
  title: string;
  body: string;
}

const MAX_PR_PATCH_CHARS = 26000;
const MAX_MODEL_RESPONSE_CHARS = 12000;

/**
 * 변경 컨텍스트를 바탕으로 커밋 메시지를 생성한다.
 * @param context git diff/status 로 만든 커밋 메시지 컨텍스트
 * @param token VS Code 취소 토큰
 * @returns 커밋 입력창에 넣을 메시지
 */
export async function generateAiCommitMessage(
  context: AiCommitMessageContext,
  token: vscode.CancellationToken
): Promise<string> {
  logInfo("AI commit message generation requested", {
    repoRoot: context.repoRoot,
    branch: context.branch,
    scope: context.scope,
    files: context.files.length,
  });
  const response = await runAiCliPrompt(
    commitPrompt(context),
    context.repoRoot,
    token
  );
  logInfo("AI commit message generation completed", {
    repoRoot: context.repoRoot,
    provider: response.provider,
  });
  const text = clippedResponse(response.text);
  const message = cleanPlainText(text);
  if (!message) {
    throw new Error(vscode.l10n.t("AI CLI did not return a commit message."));
  }
  return message;
}

/**
 * PR preview 데이터를 바탕으로 PR 제목/본문을 생성한다.
 * @param preview staged PR preview 데이터
 * @param token VS Code 취소 토큰
 * @returns preview 화면에 반영할 PR 제목과 본문
 */
export async function generateAiPullRequestMessage(
  preview: StagedPullRequestPreview,
  repoRoot: string,
  token: vscode.CancellationToken
): Promise<GeneratedPullRequestMessage> {
  logInfo("AI pull request message generation requested", {
    repo: preview.repository,
    source: preview.sourceBranch,
    target: preview.targetBranch,
    files: preview.previewFiles.length,
    commits: preview.previewCommits.length,
  });
  const projectContext = await readProjectContext(repoRoot);
  const response = await runAiCliPrompt(
    pullRequestPrompt(preview, projectContext),
    repoRoot,
    token
  );
  logInfo("AI pull request message generation completed", {
    repo: preview.repository,
    provider: response.provider,
  });
  const text = clippedResponse(response.text);
  const parsed = parsePullRequestMessage(text);
  if (!parsed.title && !parsed.body) {
    throw new Error(
      vscode.l10n.t("AI CLI did not return a pull request message.")
    );
  }
  return {
    title: parsed.title || preview.title,
    body: parsed.body || preview.body,
  };
}

/**
 * 커밋 메시지 생성 프롬프트를 만든다.
 * @param context git 변경 컨텍스트
 * @returns 모델에 전달할 프롬프트
 */
function commitPrompt(context: AiCommitMessageContext): string {
  const config = readAiCliConfig();
  return [
    "Generate one git commit message for the change below.",
    "Rules:",
    "- Return only the commit message, no markdown fences.",
    ...commitMessageGuidelines(config.responseLanguage),
    "- Do not run commands or modify files. Use only the supplied context.",
    ...instructionLines(config.commonInstructions),
    ...instructionLines(config.commitInstructions),
    "",
    `Branch: ${context.branch}`,
    `Scope: ${context.scope}`,
    "",
    "Files:",
    fileList(context.files),
    "",
    "Status:",
    context.status.trim() || "(none)",
    "",
    "Diff:",
    context.diff.trim() || "(no textual diff)",
  ].join("\n");
}

/**
 * PR 제목/본문 생성 프롬프트를 만든다.
 * @param preview staged PR preview 데이터
 * @returns 모델에 전달할 프롬프트
 */
function pullRequestPrompt(
  preview: StagedPullRequestPreview,
  projectContext: string
): string {
  const config = readAiCliConfig();
  return [
    "Generate a pull request title and body from the preview below.",
    "Return strict JSON only with this shape:",
    '{"title":"...","body":"..."}',
    "Rules:",
    "- Title must be concise and under 80 characters.",
    "- Body must be GitHub markdown.",
    "- Body should include Summary, Changes, and Testing sections.",
    "- If testing is unknown, say Not run.",
    `- Write in ${config.responseLanguage}.`,
    "- Do not run commands or modify files. Use only the supplied context.",
    ...instructionLines(config.commonInstructions),
    ...instructionLines(config.pullRequestInstructions),
    "",
    `Repository: ${preview.repository || "unknown"}`,
    `Source: ${preview.sourceBranch}`,
    `Target: ${preview.targetBranch}`,
    `Current preview title: ${preview.title}`,
    "",
    "Project context:",
    projectContext || "(not available)",
    "",
    "Commits:",
    preview.previewCommits.length
      ? preview.previewCommits
          .slice(0, 30)
          .map((commit) => `- ${commit.shortHash}: ${commit.title}`)
          .join("\n")
      : "(none)",
    "",
    "Files:",
    fileList(preview.previewFiles),
    "",
    "Diff stat:",
    preview.stat.trim() || "(none)",
    "",
    "Patch excerpts:",
    prPatchText(preview),
  ].join("\n");
}

/**
 * PR 요약 품질을 높이기 위해 프로젝트의 짧은 맥락을 읽는다.
 * @param repoRoot git 저장소 루트
 */
async function readProjectContext(repoRoot: string): Promise<string> {
  const [packageText, readmeText, agentsText] = await Promise.all([
    readPackageSummary(repoRoot),
    readFirstExisting(repoRoot, ["README.md", "README.ko.md"], 5000),
    readFirstExisting(repoRoot, ["AGENTS.md", "CLAUDE.md"], 3500),
  ]);
  return [packageText, clipContext(readmeText), clipContext(agentsText)]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * package.json 에서 프로젝트 이름과 설명만 추린다.
 * @param repoRoot git 저장소 루트
 */
async function readPackageSummary(repoRoot: string): Promise<string> {
  const raw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8")
    .catch(() => "");
  if (!raw) {
    return "";
  }
  try {
    const parsed = JSON.parse(raw) as { name?: string; description?: string };
    return [
      parsed.name ? `Package: ${parsed.name}` : "",
      parsed.description ? `Description: ${parsed.description}` : "",
    ].filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

/**
 * 후보 파일 중 처음 존재하는 파일의 앞부분을 읽는다.
 * @param repoRoot git 저장소 루트
 * @param names 후보 파일명
 * @param maxChars 최대 문자 수
 */
async function readFirstExisting(
  repoRoot: string,
  names: string[],
  maxChars: number
): Promise<string> {
  for (const name of names) {
    const raw = await fs.readFile(path.join(repoRoot, name), "utf8")
      .catch(() => "");
    if (raw.trim()) {
      return `${name}:\n${raw.slice(0, maxChars)}`;
    }
  }
  return "";
}

/**
 * 프로젝트 맥락 텍스트를 프롬프트에 넣기 좋은 길이로 줄인다.
 * @param value 원문
 */
function clipContext(value: string): string {
  const text = value.trim();
  if (text.length <= 5000) {
    return text;
  }
  return `${text.slice(0, 5000)}\n[project context truncated]`;
}

/**
 * 사용자 설정 지시문을 프롬프트 Rules 항목에 추가할 줄 목록으로 바꾼다.
 * @param value 설정에서 읽은 추가 지시문
 */
function instructionLines(value: string): string[] {
  if (!value.trim()) {
    return [];
  }
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `- ${line}`);
}

/**
 * 파일 변경 목록을 프롬프트용 bullet list 로 만든다.
 * @param files 변경 파일 목록
 */
function fileList(files: AiChangeFile[]): string {
  if (!files.length) {
    return "(none)";
  }
  return files
    .slice(0, 80)
    .map((file) => {
      const stat =
        file.additions === undefined && file.deletions === undefined
          ? ""
          : ` (+${file.additions ?? 0}/-${file.deletions ?? 0})`;
      const renamed = file.oldPath ? ` from ${file.oldPath}` : "";
      return `- ${file.status} ${file.path}${renamed}${stat}`;
    })
    .join("\n");
}

/**
 * PR preview 파일들의 patch 일부를 프롬프트 한도에 맞춰 이어 붙인다.
 * @param preview staged PR preview 데이터
 */
function prPatchText(preview: StagedPullRequestPreview): string {
  let text = "";
  for (const file of preview.previewFiles.slice(0, 30)) {
    if (!file.patch) {
      continue;
    }
    const block = `\n### ${file.path}\n${file.patch}\n`;
    if (text.length + block.length > MAX_PR_PATCH_CHARS) {
      text += "\n[patch excerpts truncated]";
      break;
    }
    text += block;
  }
  return text.trim() || "(no textual patch excerpts)";
}

/**
 * 커밋 메시지 응답에서 불필요한 code fence/따옴표를 걷어낸다.
 * @param value 모델 원문 응답
 */
function cleanPlainText(value: string): string {
  return stripFence(value)
    .replace(/^["']|["']$/g, "")
    .trim();
}

/**
 * CLI 응답이 비정상적으로 긴 경우 기존 응답 한도에 맞춰 자른다.
 * @param value CLI 원문 응답
 */
function clippedResponse(value: string): string {
  if (value.length <= MAX_MODEL_RESPONSE_CHARS) {
    return value;
  }
  return value.slice(0, MAX_MODEL_RESPONSE_CHARS);
}

/**
 * PR 메시지 응답을 JSON 우선으로 파싱하고, 실패하면 첫 줄/나머지 본문으로 해석한다.
 * @param value 모델 원문 응답
 */
function parsePullRequestMessage(value: string): GeneratedPullRequestMessage {
  const cleaned = stripFence(value).trim();
  const json = jsonObjectText(cleaned);
  if (json) {
    try {
      const parsed = JSON.parse(json) as Partial<GeneratedPullRequestMessage>;
      return {
        title: String(parsed.title || "").trim(),
        body: String(parsed.body || "").trim(),
      };
    } catch {
      // 아래 fallback 이 사람이 읽을 수 있는 응답을 최대한 살린다.
    }
  }
  const lines = cleaned.split(/\r?\n/).map((line) => line.trim());
  const title = lines.find(Boolean) || "";
  const body = lines.slice(lines.indexOf(title) + 1).join("\n").trim();
  return { title, body };
}

/**
 * markdown code fence 로 감싼 응답이면 내부 텍스트만 반환한다.
 * @param value 모델 원문 응답
 */
function stripFence(value: string): string {
  const text = value.trim();
  const match = /^```(?:json|markdown|md|text)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match ? match[1].trim() : text;
}

/**
 * 응답에서 JSON 객체로 보이는 부분만 잘라낸다.
 * @param value 모델 원문 응답
 */
function jsonObjectText(value: string): string | undefined {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start >= 0 && end > start ? value.slice(start, end + 1) : undefined;
}
