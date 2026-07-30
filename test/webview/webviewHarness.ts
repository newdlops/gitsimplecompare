import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { pullRequestPreviewScript } from "../../src/webview/pullRequestPreviewScript";
import { pullRequestPreviewStyles } from "../../src/webview/pullRequestPreviewStyles";
import type { PullRequestPreviewI18n } from "../../src/webview/pullRequestPreviewI18n";
import type { WebviewFixture } from "../helpers/webviewFixture";

const root = process.cwd();
const media = (...parts: string[]) => path.join(root, "media", ...parts);
const previewI18n: PullRequestPreviewI18n = { title:"Pull request preview",refresh:"Refresh staged PR preview",generate:"Generate AI pull request message",configure:"Configure AI CLI",copy:"Copy pull request message",create:"Create Pull Request on GitHub",openGitHub:"Open pull request on GitHub",loading:"Loading…",ready:"Ready to create pull request",busy:"Publishing Pull Request to GitHub…",existing:"A Pull Request already exists for this source branch",selectTarget:"Select a target branch before creating a Pull Request",selectLocalSource:"Select a local source branch before creating a Pull Request",missingMessage:"Enter a Pull Request title before publishing",noChanges:"No changes to publish as a Pull Request",updating:"Wait for the Pull Request preview to finish updating",composer:"Pull request message",titleLabel:"Title",descriptionOptional:"Description (optional)",titleRequired:"A title is required to create a pull request.",unableToUpdate:"Unable to update preview.",retryPreview:"Retry preview",generating:"Generating AI pull request message…",generateNeedsTarget:"Select a target branch before generating a PR message",generateNeedsChanges:"Stage changes before generating an AI pull request message",copyUnavailable:"No pull request message to copy",selectTargetState:"Select target",draft:"Draft",noChangesState:"No changes",repository:"Repository",changed:"Changed files",staged:"Staged",diffSummary:"Diff summary",additions:"Additions",deletions:"Deletions",changedFiles:"Changed files",filesChanged:"Files changed",commits:"Commits",conversation:"Conversation",localDraft:"Local draft",noDescription:"No pull request description was provided.",showFile:"Show {0} file",viewedLocal:"Viewed locally",unviewedLocal:"Not viewed locally",markViewedLocal:"Mark file as viewed locally",markUnviewedLocal:"Mark file as not viewed locally",sourceBranch:"Source branch",targetBranch:"Target branch",sourceRole:"Source",targetRole:"Target",changeSourceBranch:"Change source branch",changeTargetBranch:"Change target branch",selectTargetBranch:"Select target branch",showBranchOptions:"Show {0} branch options",hideBranchOptions:"Hide {0} branch options",noMatchingBranches:"No matching branches",sections:"Pull request sections",showSection:"Show {0}",noChangedFiles:"No changed files.",noCommits:"No commits ahead of target.",selectTargetToInspectCommitFiles:"Select a target branch to inspect commit files.",loadingCommitFiles:"Loading commit files…",selectCommitToInspectChangedFiles:"Select a commit to inspect changed files.",openEditableDiff:"Open editable diff",expandFileDiff:"Expand file diff for {0}",collapseFileDiff:"Collapse file diff for {0}",filesDisplayMode:"Files display mode",cardsMode:"Cards",cardsModeTooltip:"Show each file in a separate card",continuousMode:"Continuous",continuousModeTooltip:"Show files as one continuous diff stream",diffLayout:"Diff layout",unifiedMode:"Unified",unifiedModeTooltip:"Show a unified one-column diff",splitMode:"Split",splitModeTooltip:"Show a split two-column diff",changedFilesView:"Changed files view",showCommitFiles:"Show files changed in commit {0}",resizeChangedFilesInspector:"Resize changed files inspector",lineCountsUnavailable:"Line counts unavailable",diffUnavailable:"Diff snippet is unavailable for this file.",diffLinesTruncated:"{0} lines truncated",diffExpandUnchangedLines:"Expand {0} unchanged lines",diffShowMoreUnchangedLines:"Show {0} more unchanged lines ({1} hidden)",diffCollapseUnchangedLines:"Collapse {0} unchanged lines",diffCollapseUnchanged:"Collapse unchanged lines",diffLine:"line {0}",diffReview:"review",diffUnknownAuthor:"unknown" };

async function bridge(page: Page, i18nKey: string, labels: Record<string,string> = {}) { await page.evaluate(({i18nKey,labels}) => { const w:any=window; w.__gscFixtureMessages=[]; w.__gscFixtureState={}; w.acquireVsCodeApi=()=>({postMessage:(m:any)=>w.__gscFixtureMessages.push(structuredClone(m)),getState:()=>w.__gscFixtureState,setState:(v:any)=>{w.__gscFixtureState=v;}}); w[i18nKey]=new Proxy(labels,{get:(v,p)=>v[String(p)]||String(p)}); w.__gscMenu=[];w.__gscCommitMenu=[]; },{i18nKey,labels}); }
async function assets(page:Page, css:string[], js:string[]){ for(const file of css) await page.addStyleTag({path:media(...file.split("/"))}); for(const file of js) await page.addScriptTag({path:media(...file.split("/"))}); }
export async function dispatchWebviewMessage(page:Page,message:unknown){await page.evaluate(m=>window.dispatchEvent(new MessageEvent("message",{data:m})),message);}
export async function readPostedMessages(page:Page){return page.evaluate(()=> (window as any).__gscFixtureMessages);}
export async function readPersistedState(page:Page){return page.evaluate(()=> (window as any).__gscFixtureState);}
export async function mountChanges(page:Page,fixture:WebviewFixture){await page.setContent('<body class="gsc-surface"><div id="root"></div></body>');await bridge(page,"__gscI18n",{workingChanges:"Working Changes",noChanges:"No working tree changes.",commit:"Commit",commitPlaceholder:"Message",changes:"Changes",compareBranches:"Compare Branches"});await assets(page,["shared/reset.css","shared/tokens.css","shared/controls.css","shared/data-display.css","shared/feedback.css","shared/layout.css","shared/instantTooltip.css","codicons/codicon.css","changes/changes.css","changes/changesCompare.css","changes/changesCommitBox.css","changes/changesAiPlan.css","changes/changesHooks.css","changes/changesWorktrees.css","changes/changesInformationArchitecture.css"],["shared/a11y.js","shared/dom.js","shared/keyboard.js","shared/overlay.js","shared/persistedState.js","shared/requestState.js","shared/splitter.js","shared/virtualList.js","shared/instantTooltip.js","changes/changesWorkingOperation.js","changes/changesWorktrees.js","changes/changesCompare.js","changes/changesStashes.js","changes/changesInformationArchitecture.js","changes/changesMenu.js","changes/changesTreeSelection.js","changes/changesWorkingTreeActions.js","changes/changesHistory.js","changes/changesSectionLayout.js","changes/changesCommitBox.js","changes/changes.js","changes/changesAi.js","changes/changesAiPlan.js","changes/changesHooks.js","changes/changesHookPreflight.js"]);await dispatchWebviewMessage(page,{type:"render",payload:fixture.payload});}
export async function mountPullRequestPreview(page:Page,fixture:WebviewFixture,textOverrides:Partial<PullRequestPreviewI18n>={}){const text={...previewI18n,...textOverrides};const icon=(id:string,name:string,label:string)=>`<button id="${id}" class="gsc-icon-button" type="button" title="${label}" aria-label="${label}" data-tooltip="${label}"><span class="codicon codicon-${name}" aria-hidden="true"></span></button>`;await page.setContent(`<body class="gsc-surface"><header class="topbar"><div class="topbar-title"><span class="codicon codicon-git-pull-request" aria-hidden="true"></span><h1>Pull request preview</h1></div><div class="actions">${icon("refresh","refresh","Refresh staged PR preview")}${icon("generate-pr-message","comment-discussion-sparkle","Generate AI pull request message")}${icon("configure-ai-cli","settings-gear","Configure AI CLI")}${icon("copy-pr-message","copy","Copy pull request message")}<button id="publish-pr" class="gsc-button gsc-button--primary publish-button" type="button" title="Create Pull Request on GitHub" aria-label="Create Pull Request on GitHub" data-tooltip="Create Pull Request on GitHub" disabled><span class="codicon codicon-cloud-upload" aria-hidden="true"></span><span class="publish-label">Create Pull Request on GitHub</span></button><button id="open-pr" class="gsc-button gsc-button--primary" type="button" title="Open pull request on GitHub" aria-label="Open pull request on GitHub" data-tooltip="Open pull request on GitHub" hidden>Open pull request on GitHub</button></div></header><main id="content" aria-live="polite"><p class="placeholder">Loading…</p></main></body>`);await bridge(page,"__gscI18n");await assets(page,["codicons/codicon.css","shared/reset.css","shared/tokens.css","shared/controls.css","shared/data-display.css","shared/feedback.css","shared/layout.css","shared/instantTooltip.css"],["shared/a11y.js","shared/dom.js","shared/keyboard.js","shared/overlay.js","shared/persistedState.js","shared/requestState.js","shared/splitter.js","shared/virtualList.js","shared/instantTooltip.js"]);await page.addStyleTag({content:pullRequestPreviewStyles()});await page.addScriptTag({content:pullRequestPreviewScript(text)});await dispatchWebviewMessage(page,{type:"preview",preview:fixture.payload});}

/** 실제 Graph renderer를 최소 production DOM에 mount해 GraphData 재렌더 동작을 검증한다. */
export async function mountGraphRenderer(page: Page): Promise<void> {
  await page.setContent(
    `<body class="gsc-surface detail-open"><div id="app">` +
      `<main id="graph-pane"><div id="graph-toolbar">` +
        `<button id="refresh-graph" class="icon-button" type="button" title="Refresh graph" aria-label="Refresh graph" data-tooltip="Refresh graph"><span class="codicon codicon-refresh" aria-hidden="true"></span></button>` +
        `<span id="load-status" aria-live="polite"></span>` +
        `<button id="toggle-detail" class="icon-button" type="button" title="Toggle details" aria-label="Toggle details" data-tooltip="Toggle details"><span class="codicon codicon-layout-sidebar-right" aria-hidden="true"></span></button>` +
      `</div><div id="graph" tabindex="0"><div id="graph-content"></div></div></main>` +
      `<div id="main-splitter" class="splitter" role="separator" aria-orientation="vertical" tabindex="0" title="Resize commit details" aria-label="Resize commit details"></div>` +
      `<div id="detail"><p class="placeholder">Select a commit to see details.</p></div>` +
    `</div><div id="drawer-backdrop"></div></body>`
  );
  await bridge(page, "__gscI18n");
  await assets(
    page,
    ["codicons/codicon.css", "shared/reset.css", "shared/tokens.css", "shared/controls.css", "graph/graph.css", "graph/graphDetail.css"],
    ["graph/graphColors.js", "graph/graphSvgRender.js", "graph/graphDetailResize.js", "graph/graph.js"]
  );
  const font = (await readFile(media("codicons", "codicon.ttf"))).toString("base64");
  await page.addStyleTag({
    content:
      `@font-face{font-family:gsc-test-codicon;src:url(data:font/ttf;base64,${font}) format("truetype")}` +
      `.codicon[class*="codicon-"]{font-family:gsc-test-codicon!important}` +
      `html,body{--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;` +
      `--vscode-font-size:13px;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;` +
      `--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#252526;--vscode-panel-border:#454545;` +
      `--vscode-focusBorder:#007fd4;--vscode-icon-foreground:#c5c5c5;--vscode-toolbar-hoverBackground:#3a3d41;` +
      `--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#094771;` +
      `--vscode-list-activeSelectionForeground:#fff}`,
  });
}

/** 실제 Graph context menu를 두 commit row에 mount해 선택 행 기반 메시지를 검증한다. */
export async function mountGraphContextMenu(page: Page): Promise<void> {
  await page.setContent(
    `<body><main id="graph-content">` +
      `<div class="row" data-hash="current-row"><span class="subject">Current row</span></div>` +
      `<div class="row" data-hash="selected-row"><span class="subject">Selected row</span></div>` +
    `</main></body>`
  );
  await bridge(page, "__gscI18n");
  await page.evaluate(() => {
    const fixtureWindow = window as any;
    fixtureWindow.GscGraphPostMessage = (message: unknown) =>
      fixtureWindow.__gscFixtureMessages.push(structuredClone(message));
  });
  await assets(
    page,
    ["codicons/codicon.css", "graph/graph.css"],
    ["graph/graphContextMenu.js"]
  );
  const font = (await readFile(media("codicons", "codicon.ttf"))).toString("base64");
  await page.addStyleTag({
    content:
      `@font-face{font-family:gsc-test-codicon;src:url(data:font/ttf;base64,${font}) format("truetype")}` +
      `.codicon[class*="codicon-"]{font-family:gsc-test-codicon!important}` +
      `html,body{margin:0;--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;` +
      `--vscode-font-size:13px;--vscode-foreground:#cccccc;--vscode-editor-background:#1e1e1e;` +
      `--vscode-menu-background:#252526;--vscode-menu-foreground:#f0f0f0;` +
      `--vscode-menu-selectionBackground:#094771;--vscode-menu-selectionForeground:#ffffff;` +
      `--vscode-panel-border:#454545;background:var(--vscode-editor-background);color:var(--vscode-foreground);` +
      `font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}` +
      `#graph-content{position:relative;padding:16px;display:grid;gap:8px}` +
      `.row{position:relative;min-height:28px;padding:6px 10px;border-radius:4px;background:#252526}`,
  });
  await page.evaluate(() => {
    (window as any).GscGraphContextMenu.attach(
      document.getElementById("graph-content"),
      { canUndoCommit: () => false }
    );
  });
}

/** 실제 Graph Stack JS/CSS를 최소 production DOM에 mount해 action/message와 좁은 폭 상태를 검증한다. */
export async function mountPullRequestStackGraph(page: Page, snapshot: unknown): Promise<void> {
  await page.setContent(`<body><div id="app"><section id="graph-pane"><header id="graph-toolbar"><button id="graph-pr-stacks" class="icon-button" type="button"><span class="codicon codicon-layers" aria-hidden="true"></span></button></header><main id="graph-content"><svg width="100%" height="120"><circle class="node" data-hash="child" cx="40" cy="30" r="5"></circle><circle class="node" data-hash="local-base" cx="40" cy="90" r="5"></circle></svg><div class="row" data-hash="child"></div><div class="row" data-hash="local-base"></div></main></section><section id="detail"></section></div></body>`);
  await bridge(page, "__gscI18n");
  const font = (await readFile(media("codicons", "codicon.ttf"))).toString("base64");
  await page.addStyleTag({ content: `@font-face{font-family:codicon;src:url(data:font/ttf;base64,${font}) format("truetype")}html,body{--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#252526;--vscode-panel-border:#454545;--vscode-focusBorder:#007fd4;--vscode-icon-foreground:#c5c5c5;--vscode-button-background:#0e639c;--vscode-button-foreground:#ffffff;--vscode-toolbar-hoverBackground:#3a3d41;--vscode-list-hoverBackground:#2a2d2e;--vscode-editorWarning-foreground:#cca700;--vscode-charts-purple:#b180d7;background:var(--vscode-editor-background);color:var(--vscode-foreground)}#graph-pane{display:none!important}#detail{flex:1 1 auto;width:100%;min-width:0;max-width:none;border-left:0}` });
  await page.evaluate(() => { const w: any = window; w.GscGraphPostMessage = (message: unknown) => w.__gscFixtureMessages.push(structuredClone(message)); w.GscGraphDetailHost = { root: document.getElementById("detail"), show: () => document.body.classList.add("detail-open") }; w.GscPrStackI18n = { unavailable:"Unavailable", unavailableReason:"Unavailable: {0}", manageCount:"Manage pull request stacks ({0} layers)", showLayerFlow:"Show stack layer {0}: {1} ← {0}", stackDetails:"Pull request stack details", stacks:"Pull request stacks", localRepository:"Local repository", addLayer:"Add a new stack layer", layerDetails:"Pull request stack layer details", addChild:"Add a child layer above {0}", editParent:"Edit local Stack parent for {0}", deleteLocal:"Delete local Stack metadata for this connected Stack", githubOnly:"GitHub-only Stack relation. Local parent editing and deletion are unavailable.", localParent:"Local parent", publishedParent:"Published PR base", restackThenSync:"Local and published parents differ. Restack, then Submit / Sync to update the PR base.", restackDescendants:"Restack {0} and descendants", submitStack:"Submit or sync the stack containing {0}", advanceChildren:"Advance children after merged PR #{0}", parent:"Parent", localBranch:"Local branch", yes:"Yes", no:"No", pullRequest:"Pull request", notSubmitted:"Not submitted", restack:"Restack", restackRequired:"Required — parent moved", upToDate:"Up to date", worktree:"Worktree", childLayers:"Child layers", topLayer:"This is the top layer.", base:"base", local:"LOCAL", remote:"REMOTE", noLayers:"No stack layers yet. Add one from a parent branch to start.", addFirstLayer:"Add the first stack layer", showAll:"Show all pull request stacks", openPullRequest:"Open pull request #{0} in browser", previewPullRequest:"Preview staged pull request", showChild:"Show child layer {0}", showLayer:"Show stack layer {0}" }; });
  await assets(page, ["codicons/codicon.css", "graph/graph.css", "graph/graphDetail.css", "graph/graphPrStacks.css"], ["graph/graphPrStacks.js"]);
  await page.addStyleTag({ content: `@font-face{font-family:gsc-test-codicon;src:url(data:font/ttf;base64,${font}) format("truetype")}.codicon[class*="codicon-"]{font-family:gsc-test-codicon!important}#app{display:block}#graph-pane{display:block!important;position:absolute;top:0;right:0;z-index:4;min-width:0;height:var(--toolbar-height)}#graph-toolbar{height:var(--toolbar-height);padding:0 8px}#graph-content{display:none}#detail,.pr-stack-detail-shell{background:var(--vscode-editor-background);color:var(--vscode-foreground)}#detail{position:fixed;inset:0;display:flex;width:auto;min-width:0;max-width:none;border-left:0}@media(max-width:760px){#detail{inset:0!important;width:auto!important;transform:none!important}}` });
  await dispatchWebviewMessage(page, { type: "pullRequestStackSnapshot", snapshot });
}
