// PR preview Conversation 탭에 표시할 GitHub 대화 이력을 읽는 모듈.
// - 기존 PR 은 issue comments 를 가져오고, staged preview 는 PR 본문 초안을 timeline 첫 항목으로 보여준다.
import { runGh } from "./ghCli";
import { splitRepositoryName } from "./githubRepository";

/** Conversation 탭 timeline 한 항목 */
export interface PullRequestConversationItem {
  kind: "body" | "comment";
  author: string;
  body: string;
  createdAt?: string;
}

interface PreviewPullRequestRef {
  number?: number;
  author?: string;
}

interface GhIssueComment {
  body?: string;
  created_at?: string;
  user?: { login?: string };
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * PR conversation timeline 을 만든다.
 * @param cwd gh 실행 경로
 * @param repository owner/name 저장소 이름
 * @param pr 기존 PR 정보. 없으면 staged preview timeline 을 만든다.
 * @param body PR 본문 또는 staged preview 본문
 * @param fallbackAuthor staged preview 작성자 fallback
 * @returns conversation timeline 항목
 */
export async function buildPullRequestConversation(
  cwd: string,
  repository: string | undefined,
  pr: PreviewPullRequestRef | undefined,
  body: string,
  fallbackAuthor: string
): Promise<PullRequestConversationItem[]> {
  const opening: PullRequestConversationItem = {
    kind: "body",
    author: pr?.author || fallbackAuthor,
    body,
  };
  if (!repository || !pr?.number) {
    return [opening];
  }
  const [owner, name] = splitRepositoryName(repository);
  const comments = await readIssueComments(cwd, owner, name, pr.number);
  return [opening, ...comments.map(normalizeComment)];
}

/** GitHub issue comments API 를 페이지 단위로 읽는다. */
async function readIssueComments(
  cwd: string,
  owner: string,
  name: string,
  number: number
): Promise<GhIssueComment[]> {
  const all: GhIssueComment[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const out = await runGh([
      "api",
      `repos/${owner}/${name}/issues/${number}/comments?per_page=${PAGE_SIZE}&page=${page}`,
    ], cwd);
    const items = JSON.parse(out) as GhIssueComment[];
    all.push(...items);
    if (items.length < PAGE_SIZE) {
      break;
    }
  }
  return all;
}

/** GitHub issue comment 를 preview conversation 항목으로 바꾼다. */
function normalizeComment(comment: GhIssueComment): PullRequestConversationItem {
  return {
    kind: "comment",
    author: comment.user?.login || "unknown",
    body: comment.body || "",
    createdAt: comment.created_at,
  };
}
