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
      loadingPullRequests: ko ? "PR을 불러오는 중…" : "Loading pull requests…",
      loadingPrDetails: ko ? "나머지 커밋과 댓글을 불러오는 중…" : "Loading remaining commits and comments…",
      loadingPrCommits: ko ? "PR 커밋을 불러오는 중…" : "Loading pull request commits…",
      retryPullRequests: ko ? "PR 다시 불러오기" : "Retry loading pull requests",
      retryPrDetails: ko ? "변경 파일 다시 불러오기" : "Retry loading changed files",
      openPullRequest: "Open pull request #{0} in browser",
    };
  }, korean);
  await page.addStyleTag({ content: `html,body{--vscode-disabledForeground:#777;--vscode-button-secondaryForeground:#ddd;--vscode-button-secondaryBackground:#3a3d41;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#ccc;--vscode-editor-font-family:Menlo,monospace;--vscode-gitDecoration-addedResourceForeground:#81b88b;--vscode-gitDecoration-deletedResourceForeground:#f14c4c;--vscode-gitDecoration-modifiedResourceForeground:#e2c08d;--vscode-gitDecoration-renamedResourceForeground:#73c991}` });
  for (const file of ["graphPr.css", "graphPrFiles.css", "graphControls.css"]) await page.addStyleTag({ path: join(process.cwd(), "media/graph", file) });
  for (const file of ["graphPrActions.js", "graphPrSearch.js", "graphPrMatching.js", "graphPrFiles.js", "graphPrViewState.js", "graphPr.js"]) {
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
