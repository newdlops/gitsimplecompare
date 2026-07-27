// pending Pull Request review에 file/line/range thread를 추가하는 GitHub GraphQL 서비스.
// - pending review 생성·재사용은 draft service에 위임하고, 이 모듈은 anchor validation과 thread mutation만 책임진다.
import type { GhRunner } from "./ghRunner";
import { DefaultGhRunner } from "./ghRunner";
import {
  normalizePullRequestReviewLocation,
  type NormalizedPullRequestReviewLocation,
  type PullRequestReviewLocation,
} from "./pullRequestReviewLocation";
import {
  PullRequestReviewDraftService,
  type PullRequestReviewDraftTarget,
} from "./pullRequestReviewDraftService";

const MAX_THREAD_BODY_LENGTH = 65_536;

/** 새 pending review thread에 필요한 composer 입력. */
export interface AddPullRequestReviewThreadRequest {
  /** thread markdown body */
  body: string;
  /** GitHub file/line/range anchor */
  location: PullRequestReviewLocation;
  /** 첫 pending review를 만들 때 쓸 summary body. 기존 pending이면 무시된다. */
  reviewBody: string;
}

/** successful mutation 뒤 UI가 local optimistic patch 대신 refresh할 수 있는 최소 thread 정보. */
export interface AddedPullRequestReviewThread {
  /** GitHub PullRequestReviewThread node id */
  id: string;
  /** 정규화된 file/line anchor */
  location: NormalizedPullRequestReviewLocation;
  /** pending review node id */
  reviewId: string;
}

/** AddPullRequestReviewThread GraphQL response 최소 형태. */
interface AddThreadResponse {
  data?: {
    addPullRequestReviewThread?: {
      thread?: { id?: string } | null;
    } | null;
  };
}

/** pending review thread reply mutation 응답의 최소 형태. */
interface AddThreadReplyResponse {
  data?: {
    addPullRequestReviewThreadReply?: {
      comment?: { id?: string } | null;
    } | null;
  };
}

/** 기존 review comment 수정 mutation 응답의 최소 형태. */
interface UpdateReviewCommentResponse {
  data?: { updatePullRequestReviewComment?: { pullRequestReviewComment?: { id?: string } | null } | null };
}

/** 기존 review comment 삭제 mutation 응답의 최소 형태. */
interface DeleteReviewCommentResponse {
  data?: { deletePullRequestReviewComment?: { pullRequestReviewComment?: { id?: string } | null } | null };
}

/** pending review create/reuse와 thread write를 하나의 PR serial action으로 묶는 서비스. */
export class PullRequestReviewMutationService {
  /** service가 직접 draft storage를 만들지 않아 모든 UI source가 같은 pending review를 사용한다. */
  public constructor(
    private readonly repoRoot: string,
    private readonly drafts: PullRequestReviewDraftService,
    private readonly runner: GhRunner = new DefaultGhRunner()
  ) {}

  /** pending review를 만들거나 재사용한 뒤 file/line/range thread를 추가한다. */
  public async addThread(
    target: PullRequestReviewDraftTarget,
    request: AddPullRequestReviewThreadRequest,
    signal?: AbortSignal
  ): Promise<AddedPullRequestReviewThread> {
    const body = normalizeBody(request.body);
    const location = normalizePullRequestReviewLocation(request.location);
    const pending = await this.drafts.ensurePending(target, request.reviewBody, signal);
    const response = await this.runner.runJson<AddThreadResponse>(
      buildAddThreadArgs(target, pending.id, body, location),
      this.repoRoot,
      { operation: "review.thread.add", signal }
    );
    const id = response.data?.addPullRequestReviewThread?.thread?.id?.trim();
    if (!id) throw new Error("GitHub did not return the new pull request review thread.");
    return { id, location, reviewId: pending.id };
  }

  /** 기존 thread에 답글을 pending review comment로 추가하고 새 comment id를 검증한다. */
  public async addReply(
    target: PullRequestReviewDraftTarget,
    threadId: string,
    body: string,
    reviewBody: string,
    signal?: AbortSignal
  ): Promise<{ id: string; reviewId: string }> {
    const normalizedBody = normalizeBody(body);
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) throw new Error("A pull request review thread is required before replying.");
    const pending = await this.drafts.ensurePending(target, reviewBody, signal);
    const response = await this.runner.runJson<AddThreadReplyResponse>(
      [
        "api", "graphql",
        "-F", `threadId=${normalizedThreadId}`,
        "-F", `reviewId=${pending.id}`,
        "-F", `body=${normalizedBody}`,
        "-f", "query=mutation($threadId: ID!, $reviewId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, pullRequestReviewId: $reviewId, body: $body }) { comment { id } } }",
      ],
      this.repoRoot,
      { operation: "review.thread.reply", signal }
    );
    const id = response.data?.addPullRequestReviewThreadReply?.comment?.id?.trim();
    if (!id) throw new Error("GitHub did not return the new pull request review reply.");
    return { id, reviewId: pending.id };
  }

  /** 현재 viewer가 작성한 review comment의 본문을 GitHub에 수정하고 반환 id를 검증한다. */
  public async updateComment(commentId: string, body: string, signal?: AbortSignal): Promise<void> {
    const id = commentId.trim();
    const normalizedBody = normalizeBody(body);
    if (!id) throw new Error("A pull request review comment is required before editing.");
    const response = await this.runner.runJson<UpdateReviewCommentResponse>(
      [
        "api", "graphql",
        "-F", `commentId=${id}`,
        "-F", `body=${normalizedBody}`,
        "-f", "query=mutation($commentId: ID!, $body: String!) { updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $commentId, body: $body }) { pullRequestReviewComment { id } } }",
      ],
      this.repoRoot,
      { operation: "review.comment.update", signal }
    );
    if (response.data?.updatePullRequestReviewComment?.pullRequestReviewComment?.id?.trim() !== id) {
      throw new Error("GitHub did not confirm the updated pull request review comment.");
    }
  }

  /** 현재 viewer가 작성한 review comment를 GitHub에서 삭제한다. */
  public async deleteComment(commentId: string, signal?: AbortSignal): Promise<void> {
    const id = commentId.trim();
    if (!id) throw new Error("A pull request review comment is required before deleting.");
    const response = await this.runner.runJson<DeleteReviewCommentResponse>(
      [
        "api", "graphql",
        "-F", `commentId=${id}`,
        "-f", "query=mutation($commentId: ID!) { deletePullRequestReviewComment(input: { id: $commentId }) { pullRequestReviewComment { id } } }",
      ],
      this.repoRoot,
      { operation: "review.comment.delete", signal }
    );
    if (response.data?.deletePullRequestReviewComment?.pullRequestReviewComment?.id?.trim() !== id) {
      throw new Error("GitHub did not confirm deletion of the pull request review comment.");
    }
  }
}

/** comment body를 trim validation만 거쳐 markdown whitespace 자체는 그대로 유지한다. */
function normalizeBody(body: string): string {
  if (!body.trim()) throw new Error("Write a review comment before adding it to the pending review.");
  if (body.length > MAX_THREAD_BODY_LENGTH) throw new Error("A pull request review comment cannot exceed 65,536 characters.");
  return body;
}

/** file/line/range 종류에 따라 GraphQL input의 optional location field를 정확히 조립한다. */
function buildAddThreadArgs(
  target: PullRequestReviewDraftTarget,
  reviewId: string,
  body: string,
  location: NormalizedPullRequestReviewLocation
): string[] {
  const fields = [
    "pullRequestId: $pullRequestId",
    "pullRequestReviewId: $reviewId",
    "body: $body",
    "path: $path",
    `subjectType: ${location.subjectType}`,
  ];
  const args = [
    "api", "graphql",
    "-F", `pullRequestId=${target.pullRequestId}`,
    "-F", `reviewId=${reviewId}`,
    "-F", `body=${body}`,
    "-F", `path=${location.path}`,
  ];
  if (location.subjectType === "LINE") {
    fields.push(`side: ${location.side}`, "line: $line");
    args.push("-F", `line=${location.line}`);
    if (location.startLine && location.startSide) {
      fields.push(`startSide: ${location.startSide}`, "startLine: $startLine");
      args.push("-F", `startLine=${location.startLine}`);
    }
  }
  const query = `mutation($pullRequestId: ID!, $reviewId: ID!, $body: String!, $path: String!, $line: Int, $startLine: Int) {
    addPullRequestReviewThread(input: { ${fields.join(", ")} }) { thread { id } }
  }`;
  return [...args, "-f", `query=${query}`];
}
