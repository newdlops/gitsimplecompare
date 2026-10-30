import { type Page } from "@playwright/test";
import { join } from "node:path";
import { mountGraphRenderer } from "./webviewHarness";

/** 실제 Graph 상세 host·테마·PR JS/CSS로 목록과 상세의 점진적 표시를 재현한다. */
export async function mountList(page: Page, korean: boolean) {
  await mountGraphRenderer(page);
  await page.evaluate(ko => {
    const w: any = window;
    const button = document.createElement("button"); button.id = "graph-pr-list"; button.className = "icon-button";
    button.title = "Show pull requests"; button.setAttribute("aria-label", "Show pull requests");
    button.innerHTML = '<span class="codicon codicon-git-pull-request" aria-hidden="true"></span>';
    document.querySelector("#graph-toolbar")!.append(button);
    w.GscGraphPostMessage = (message: unknown) => w.__gscFixtureMessages.push(structuredClone(message));
    w.GscPrStackI18n = {
      locale: ko ? "ko" : "en",
      prOpen: ko ? "열림" : "Open", prDraft: ko ? "초안" : "Draft", prMerged: ko ? "병합됨" : "Merged", prClosed: ko ? "닫힘" : "Closed",
      prUpdated: ko ? "{0} 갱신" : "Updated {0}", reviewRequired: ko ? "리뷰 필요" : "Review required",
      reviewShowAll: ko ? "불러온 리뷰어 {0}명 모두 보기" : "Show all {0} loaded reviewers",
      reviewShowLess: ko ? "리뷰어 접기" : "Show fewer reviewers", reviewLess: ko ? "접기" : "Show less",
      reviewPartial: ko ? "일부 리뷰어만 표시됨" : "Partial reviewer list",
      prAuthor: ko ? "작성자" : "Author", prReviewers: ko ? "리뷰어" : "Reviewers",
      reviewLoading: ko ? "리뷰어를 불러오는 중…" : "Loading reviewers…",
      reviewNone: ko ? "리뷰어 없음" : "No reviewers", reviewUnavailable: ko ? "리뷰어 정보 없음" : "Reviewers unavailable",
      reviewApproved: ko ? "승인됨" : "Approved", reviewChanges: ko ? "변경 요청" : "Changes requested", reviewAwaiting: ko ? "리뷰 대기" : "Awaiting review",
      loadingPullRequests: ko ? "PR을 불러오는 중…" : "Loading pull requests…",
      loadingPrDetails: ko ? "나머지 커밋과 댓글을 불러오는 중…" : "Loading remaining commits and comments…",
      loadingPrCommits: ko ? "PR 커밋을 불러오는 중…" : "Loading pull request commits…",
      jumpToPrRow: ko ? "그래프의 PR #{0} 행으로 이동" : "Jump to pull request #{0} row in the graph",
      loadingPrJump: ko ? "그래프에서 PR #{0}을 찾는 중…" : "Locating pull request #{0} in the graph…",
      commitNotAvailableInGraph: ko ? "현재 그래프에서 커밋을 찾지 못했습니다. 소스 브랜치를 가져오거나 브랜치 필터를 조정한 뒤 다시 시도하세요." : "Could not locate the commit in the current graph. Fetch the source branch or adjust branch filters, then try again.",
      retryPullRequests: ko ? "PR 다시 불러오기" : "Retry loading pull requests",
      retryPrDetails: ko ? "변경 파일 다시 불러오기" : "Retry loading changed files",
      loadingPrFiles: ko ? "변경 파일을 불러오는 중 ({0}/{1})…" : "Loading changed files ({0} of {1})…",
      loadingPrFileComments: ko ? "파일 댓글을 불러오는 중…" : "Loading file comments…",
      prFileCommentsUnavailable: ko ? "파일 댓글을 불러오지 못했습니다." : "File comments could not be loaded.",
      retryPrDetailsAll: ko ? "PR 상세 다시 불러오기" : "Retry loading pull request details",
      loadingGraphCommit: ko ? "그래프에서 커밋 {0}을 찾는 중…" : "Locating commit {0} in the graph…",
      openPullRequest: "Open pull request #{0} in browser",
    };
  }, korean);
  await page.addStyleTag({ content: `html,body{--vscode-disabledForeground:#777;--vscode-button-secondaryForeground:#ddd;--vscode-button-secondaryBackground:#3a3d41;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#ccc;--vscode-editor-font-family:var(--vscode-font-family);--vscode-gitDecoration-addedResourceForeground:#81b88b;--vscode-gitDecoration-deletedResourceForeground:#f14c4c;--vscode-gitDecoration-modifiedResourceForeground:#e2c08d;--vscode-gitDecoration-renamedResourceForeground:#73c991}` });
  for (const file of ["graphPr.css", "graphPrFiles.css", "graphControls.css"]) await page.addStyleTag({ path: join(process.cwd(), "media/graph", file) });
  for (const file of ["graphPrActions.js", "graphPrSearch.js", "graphPrMatching.js", "graphPrFiles.js", "graphPrViewState.js", "graphPrPeople.js", "graphPr.js"]) {
    await page.addScriptTag({ path: join(process.cwd(), "media/graph", file) });
  }
}

/** 긴 제목·branch를 포함한 첫 목록으로 좁은 drawer의 overflow와 배경 페이지 완료를 검증한다. */
export function overview(complete: boolean) {
  return { available: true, repository: "owner/repo", detailsLoading: !complete, hasMore: false,
    pullRequests: [{ number: 42, title: "Speed up large pull request loading while preserving complete commit snapshots",
      state: "OPEN", author: "contributor", headRefName: "feature/large-pull-request-loading", baseRefName: "main",
      headHash: "head", fileCount: 105, commitHashes: complete ? ["first", "middle", "head"] : ["first", "head"],
      commitHashesComplete: complete, commentCount: complete ? 12 : 5, commentCountComplete: complete }] };
}
