// PR preview 웹뷰 안에서 실행할 클라이언트 스크립트 조립 모듈.
// - 패널 생애주기 코드와 DOM 렌더링 스크립트를 분리해 파일 크기와 책임을 줄인다.
import { pullRequestPreviewBranchComboboxScript } from "./pullRequestPreviewBranchCombobox";
import { pullRequestPreviewComposerScript } from "./pullRequestPreviewComposer";
import { pullRequestPreviewDiffScript } from "./pullRequestPreviewDiffRenderer";
import { pullRequestPreviewMarkdownScript } from "./pullRequestPreviewMarkdown";
import { pullRequestPreviewTimelineScript } from "./pullRequestPreviewTimeline";
import type { PullRequestPreviewI18n } from "./pullRequestPreviewI18n";

/** extension에서 번역해 웹뷰 게시 버튼에 주입하는 동적 상태 문자열이다. */
/**
 * preview 페이지 클라이언트 스크립트를 반환한다.
 * @returns 웹뷰 script 태그 안에 삽입할 JavaScript 문자열
 */
export function pullRequestPreviewScript(text: PullRequestPreviewI18n): string {
  const publishText = webviewJson(text);
  return `
    const publishText = ${publishText};
    const vscode = acquireVsCodeApi();
    const content = document.getElementById("content");
    const openPr = document.getElementById("open-pr");
    const generatePrMessage = document.getElementById("generate-pr-message");
    const configureAiCli = document.getElementById("configure-ai-cli");
    const copyPrMessage = document.getElementById("copy-pr-message");
    const publishPr = document.getElementById("publish-pr");
    // staged Preview는 로컬 변경을 게시 전에 확인하며, 기존 PR은 외부 GitHub URL로 연다.
    const savedState = vscode.getState?.() || {};
    let activeTab = ['conversation', 'commits', 'files'].includes(savedState.activeTab) ? savedState.activeTab : 'conversation';
    let activeCommitHash = '';
    let collapsedFiles = new Set();
    let expandedDiffContexts = new Map();
    let filesReviewMode = savedState.filesReviewMode === 'cards' ? 'cards' : 'continuous';
    let diffLayoutMode = savedState.diffLayoutMode === 'split' ? 'split' : 'unified';
    let latestPreview = null;
    const localViewed = new Set(Array.isArray(savedState.localViewed) ? savedState.localViewed : []);
    /** {0} placeholder를 production webview에서도 안전하게 대체한다. */
    function template(format, ...values) { return String(format || '').replace(/\\{(\\d+)\\}/g, (_, index) => String(values[Number(index)] ?? '')); }
    ${pullRequestPreviewComposerScript()}
    document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    openPr.addEventListener("click", () => vscode.postMessage({ type: "openExistingPr" }));
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "preview") {
        if ((pendingSourceBranch && msg.preview.sourceBranch !== pendingSourceBranch) || (pendingTargetBranch && msg.preview.targetBranch !== pendingTargetBranch)) return;
        if (!acceptPreview(msg.preview)) return;
        render(msg.preview);
      }
      if (msg.type === 'previewLoading') {
        beginPreviewLoading();
      }
      if (msg.type === "commitFiles") applyCommitFiles(msg.hash, msg.files);
      if (msg.type === "generatedPullRequestMessage") applyGeneratedPullRequestMessage(msg.message);
      if (msg.type === "aiPullRequestMessageGeneration") setPrMessageGenerationActive(msg.active);
      if (msg.type === "pullRequestPublishState") setPullRequestPublishActive(msg.active);
      if (msg.type === "error") {
        failPreview(msg.message);
      }
    });
    function render(preview) {
      latestPreview = preview;
      syncDraft(preview);
      const files = reviewFiles(preview);
      const commits = commitPreviews(preview);
      const changes = diffSummary(files);
      if (activeTab === 'commits' && commits.length && !commits.some((commit) => commit.hash === activeCommitHash)) {
        activeCommitHash = commits[0].hash;
      }
      if (activeTab === 'commits') markCommitFilesLoading(commits.find((commit) => commit.hash === activeCommitHash));
      openPr.hidden = !preview.existingPr?.url;
      syncActionButtons(preview);
      content.innerHTML =
        '<div class="pr-page">' +
          previewStatusHtml() +
          prHeader(preview) +
          tabbar(files.length, commits.length) +
          '<dl class="gsc-summary-strip"><div><dt>' + esc(publishText.repository) + '</dt><dd>' + esc(preview.repository || '') + '</dd></div><div><dt>' + esc(publishText.changed) + '</dt><dd>' + esc(files.length) + '</dd></div><div><dt>' + esc(publishText.staged) + '</dt><dd>' + esc(preview.stagedFileCount || 0) + '</dd></div><div><dt>' + esc(publishText.diffSummary) + '</dt><dd class="diff-summary" aria-label="' + esc(publishText.additions + ': ' + changes.additions + ', ' + publishText.deletions + ': ' + changes.deletions) + '"><span class="add">+' + esc(changes.additions) + '</span><span class="del">-' + esc(changes.deletions) + '</span></dd></div><div><dt>' + esc(publishText.commits) + '</dt><dd>' + esc(commits.length) + '</dd></div></dl>' +
          tabContent(preview, files, commits) +
        '</div>';
      bindTabs();
      bindComposer();
      bindCommitRows();
      bindPreviewBranches();
      bindOpenDiffs();
      bindFileToggles();
      bindViewButtons();
      bindContextToggles();
      bindConversationNavigation();
      content.querySelector('[data-retry-preview]')?.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    }
    function prHeader(preview) {
      const pr = preview.existingPr || {};
      const number = pr.number ? ' <span class="pr-number">#' + esc(pr.number) + '</span>' : '';
      const needsTarget = !preview.targetBranch;
      const state = needsTarget ? publishText.selectTargetState : pr.isDraft ? publishText.draft : (pr.state || (preview.hasStagedChanges ? publishText.ready : publishText.noChangesState));
      const stateClass = pr.isDraft ? 'draft' : ((needsTarget || (!preview.hasStagedChanges && !pr.state)) ? 'empty' : '');
      const source = pendingSourceBranch || preview.sourceBranch || preview.currentBranch;
      const targets = preview.targetBranches || [];
      const selected = pendingTargetBranch || preview.targetBranch;
      const title = effectiveMessage(preview).title || (needsTarget ? publishText.selectTargetBranch : source + ' -> ' + selected);
      const sourceControl = branchControl('source-branch', 'source', publishText.sourceBranch, publishText.changeSourceBranch, source, preview.sourceBranches || []);
      const targetControl = branchControl('target-branch', 'target', publishText.targetBranch, publishText.changeTargetBranch, selected, targets, publishText.selectTargetBranch);
      return '<section class="pr-header">' +
        '<div class="title-row"><span class="state-pill ' + stateClass + '"><span class="codicon codicon-git-pull-request" aria-hidden="true"></span>' + esc(state) + '</span>' +
        '<h2 class="pr-title" data-preview-title>' + esc(title) + number + '</h2></div>' +
        '<div class="branch-flow"><span class="codicon codicon-git-branch" aria-hidden="true"></span>' + sourceControl +
        '<span class="codicon codicon-arrow-right" aria-hidden="true"></span>' + targetControl + '</div>' +
      '</section>';
    }
    function tabbar(fileCount, commitCount) {
      return '<nav class="tabbar" role="tablist" aria-label="' + esc(publishText.sections) + '">' +
        tabButton('conversation', 'comment-discussion', publishText.conversation, '') +
        tabButton('commits', 'git-commit', publishText.commits, commitCount) +
        tabButton('files', 'files', publishText.changedFiles, fileCount) +
      '</nav>';
    }
    function tabButton(tab, icon, label, count) {
      const active = activeTab === tab;
      const title = template(publishText.showSection, label);
      return '<button id="pr-preview-tab-' + esc(tab) + '" class="tab' + (active ? ' active' : '') + '" type="button" role="tab" data-tab="' + esc(tab) + '" ' +
        'aria-selected="' + (active ? 'true' : 'false') + '" aria-controls="pr-preview-tabpanel" tabindex="' + (active ? '0' : '-1') + '" title="' + esc(title) + '" aria-label="' + esc(title) + '" data-tooltip="' + esc(title) + '">' +
        '<span class="codicon codicon-' + icon + '" aria-hidden="true"></span>' + esc(label) +
        (count === '' ? '' : ' <span class="count">' + esc(count) + '</span>') + '</button>';
    }
    function tabContent(preview, files, commits) {
      if (activeTab === 'conversation') return '<section id="pr-preview-tabpanel" class="content-single" role="tabpanel" tabindex="0" aria-labelledby="pr-preview-tab-conversation">' + conversationPanel(preview, files, commits) + '</section>';
      if (activeTab === 'files') {
        return '<section id="pr-preview-tabpanel" class="content-single" role="tabpanel" tabindex="0" aria-labelledby="pr-preview-tab-files">' + filesPanel(files, preview) + '</section>';
      }
      if (activeTab === 'commits') {
        return '<section id="pr-preview-tabpanel" class="commit-review" role="tabpanel" tabindex="0" aria-labelledby="pr-preview-tab-commits">' + commitsPanel(commits, preview) + commitFilesPanel(commits, preview) + '</section>';
      }
    }
    function bindTabs() {
      content.querySelectorAll('[data-tab]').forEach((button) => {
        button.addEventListener('click', () => {
          activeTab = button.dataset.tab || 'conversation';
          persistDisplayState();
          if (activeTab === 'commits') activeCommitHash = activeCommitHash || (commitPreviews(latestPreview)[0]?.hash || '');
          if (latestPreview) render(latestPreview);
        });
        button.addEventListener('keydown', (event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const tabs = Array.from(content.querySelectorAll('[role="tab"]'));
          const index = tabs.indexOf(button);
          const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
            (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
          event.preventDefault();
          activeTab = tabs[nextIndex]?.dataset.tab || 'conversation';
          persistDisplayState();
          if (activeTab === 'commits') activeCommitHash = activeCommitHash || (commitPreviews(latestPreview)[0]?.hash || '');
          if (latestPreview) render(latestPreview);
          content.querySelector('[data-tab="' + activeTab + '"]')?.focus();
        });
      });
    }
    function bindCommitRows() {
      content.querySelectorAll('[data-commit-hash]').forEach((button) => {
        button.addEventListener('click', () => {
          activeTab = 'commits';
          activeCommitHash = button.dataset.commitHash || '';
          if (latestPreview) render(latestPreview);
        });
      });
    }
    function bindPreviewBranches() {
      const source = document.getElementById('source-branch');
      const target = document.getElementById('target-branch');
      source?.addEventListener('change', () => { pendingSourceBranch = source.value; if (latestPreview) render(latestPreview); vscode.postMessage({ type: 'setPreviewBranch', role: 'source', branch: source.value }); });
      target?.addEventListener('change', () => { pendingTargetBranch = target.value; if (latestPreview) render(latestPreview); vscode.postMessage({ type: 'setPreviewBranch', role: 'target', branch: target.value }); });
    }
    function bindOpenDiffs() {
      content.querySelectorAll('[data-open-diff]').forEach((button) => {
        button.addEventListener('click', () => {
          const file = findPreviewFile(button.dataset.openDiff || '');
          if (!file) return;
          const preferEditable = !latestPreview?.existingPr || latestPreview?.headRef === 'HEAD';
          const fallbackRef = preferEditable && latestPreview?.sourceBranch === latestPreview?.currentBranch ? ':0' : undefined;
          vscode.postMessage({
            type: 'openEditableDiff',
            path: file.path,
            oldPath: file.oldPath,
            status: file.status,
            baseRef: latestPreview?.targetRef || latestPreview?.targetBranch,
            headRef: preferEditable ? (latestPreview?.sourceRef || 'HEAD') : (latestPreview?.headRef || latestPreview?.existingPr?.headHash || 'HEAD'),
            preferEditable,
            fallbackRef,
            comments: file.comments || [],
          });
        });
      });
    }
    function bindFileToggles() {
      content.querySelectorAll('[data-toggle-file]').forEach((button) => {
        button.addEventListener('click', () => {
          const key = button.dataset.toggleFile || '';
          if (collapsedFiles.has(key)) collapsedFiles.delete(key); else collapsedFiles.add(key);
          if (latestPreview) render(latestPreview);
        });
      });
    }
    function bindViewButtons() {
      content.querySelectorAll('[data-files-review-mode]').forEach((button) => {
        button.addEventListener('click', () => { filesReviewMode = button.dataset.filesReviewMode === 'cards' ? 'cards' : 'continuous'; persistDisplayState(); if (latestPreview) render(latestPreview); });
      });
      content.querySelectorAll('[data-diff-layout-mode]').forEach((button) => {
        button.addEventListener('click', () => setDiffLayoutMode(button.dataset.diffLayoutMode || 'unified'));
      });
    }
    function setDiffLayoutMode(mode) {
      diffLayoutMode = mode === 'split' ? 'split' : 'unified';
      persistDisplayState();
      if (latestPreview) render(latestPreview);
    }
    /** title/body draft를 보존하고 로컬 UI preference 및 Viewed 표시만 webview state에 저장한다. */
    function persistDisplayState() {
      vscode.setState?.({ activeTab, filesReviewMode, diffLayoutMode, localViewed: Array.from(localViewed) });
    }
    function bindContextToggles() {
      content.querySelectorAll('[data-expand-context]').forEach((button) => {
        button.addEventListener('click', () => {
          const key = button.dataset.expandContext || '';
          const step = Number(button.dataset.expandStep || 20);
          if (key) expandedDiffContexts.set(key, (expandedDiffContexts.get(key) || 0) + step);
          if (latestPreview) render(latestPreview);
        });
      });
      content.querySelectorAll('[data-collapse-context]').forEach((button) => {
        button.addEventListener('click', () => {
          const key = button.dataset.collapseContext || '';
          if (key) expandedDiffContexts.delete(key);
          if (latestPreview) render(latestPreview);
        });
      });
    }
    function filesPanel(files, preview) {
      const emptyText = !preview?.targetBranch ? publishText.selectTargetBranch : publishText.noChangedFiles;
      const body = filesReviewMode === 'continuous'
        ? '<div class="continuous-diff-list">' + files.map(continuousFileHtml).join('') + '</div>'
        : '<div class="file-list">' + files.map(reviewFileHtml).join('') + '</div>';
      return '<section class="panel' + (files.length ? '' : ' warning') + '"><div class="panel-header"><span class="panel-title"><span class="codicon codicon-files" aria-hidden="true"></span>' + esc(publishText.filesChanged) + '</span><div class="panel-actions">' +
        viewToggleHtml('files-review-mode', filesReviewMode, [['cards', 'files', publishText.cardsMode, publishText.cardsModeTooltip], ['continuous', 'list-flat', publishText.continuousMode, publishText.continuousModeTooltip]], publishText.filesDisplayMode) +
        viewToggleHtml('diff-layout-mode', diffLayoutMode, [['unified', 'diff-single', publishText.unifiedMode, publishText.unifiedModeTooltip], ['split', 'diff-multiple', publishText.splitMode, publishText.splitModeTooltip]], publishText.diffLayout) +
        '<span class="count">' + esc(files.length) + '</span></div></div>' +
        (files.length ? body : '<p class="empty">' + esc(emptyText) + '</p>') + '</section>';
    }
    function commitsPanel(commits, preview) {
      const emptyText = !preview?.targetBranch ? publishText.selectTargetBranch : publishText.noCommits;
      return '<section class="panel"><div class="panel-header"><span class="panel-title"><span class="codicon codicon-git-commit" aria-hidden="true"></span>' + esc(publishText.commits) + '</span><span class="count">' + esc(commits.length) + '</span></div>' +
        (commits.length ? '<div class="commit-list">' + commits.map(commitRow).join('') + '</div>' : '<p class="empty">' + esc(emptyText) + '</p>') + '</section>';
    }
    function commitFilesPanel(commits, preview) {
      if (!preview?.targetBranch) return '<section class="panel"><p class="empty">' + esc(publishText.selectTargetToInspectCommitFiles) + '</p></section>';
      const commit = commits.find((item) => item.hash === activeCommitHash) || commits[0];
      if (commit?.loading) return '<section class="panel"><p class="empty">' + esc(publishText.loadingCommitFiles) + '</p></section>';
      return commit ? filesPanel(commit.files || [], preview) : '<section class="panel"><p class="empty">' + esc(publishText.selectCommitToInspectChangedFiles) + '</p></section>';
    }
    function markCommitFilesLoading(commit) {
      if (!commit || commit.synthetic || (commit.files || []).length || commit.loading) return;
      commit.loading = true;
      vscode.postMessage({ type: 'loadCommitFiles', hash: commit.hash });
    }
    function applyCommitFiles(hash, files) {
      const commit = commitPreviews(latestPreview).find((item) => item.hash === hash);
      if (!commit) return;
      commit.files = files || [];
      commit.loading = false;
      render(latestPreview);
    }
    function reviewFileHtml(file) {
      const path = displayPath(file);
      const comments = file.comments || [];
      const collapsed = collapsedFiles.has(file.path);
      return '<article class="review-file' + (collapsed ? ' collapsed' : '') + '" data-review-path="' + esc(file.path) + '" data-status="' + esc(file.status) + '">' +
        reviewFileHeaderHtml(file, path, comments, collapsed) +
        (collapsed ? '' : '<div class="review-file-body">' + patchHtml(file.patch, false, file.path, comments, diffLayoutMode) + '</div>') + '</article>';
    }
    function continuousFileHtml(file) {
      const comments = file.comments || [];
      const collapsed = collapsedFiles.has(file.path);
      const path = displayPath(file);
      return '<article class="review-file continuous-file' + (collapsed ? ' collapsed' : '') + '" data-review-path="' + esc(file.path) + '" data-status="' + esc(file.status) + '">' +
        reviewFileHeaderHtml(file, path, comments, collapsed) +
        (collapsed ? '' : '<div class="review-file-body">' + splitPatchHtml(file.patch, file.path, comments, diffLayoutMode) + '</div>') + '</article>';
    }
    function reviewFileHeaderHtml(file, path, comments, collapsed) {
      const toggleTitle = template(collapsed ? publishText.expandFileDiff : publishText.collapseFileDiff, path);
      return '<div class="review-file-head" title="' + esc(path) + '">' +
        '<button class="file-toggle" type="button" data-toggle-file="' + esc(file.path) + '" title="' + esc(toggleTitle) + '" aria-label="' + esc(toggleTitle) + '" data-tooltip="' + esc(toggleTitle) + '"><span class="codicon ' + (collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down') + '" aria-hidden="true"></span></button>' +
        '<span class="status-icon codicon ' + statusIcon(file.status) + '" aria-hidden="true"></span>' +
        '<span class="review-file-title">' + esc(path) + '</span>' +
        '<span class="comment-chip"><span class="codicon codicon-comment-discussion" aria-hidden="true"></span>' + esc(comments.length) + '</span>' +
        '<span class="stat"><span class="add">+' + esc(file.additions || 0) + '</span><span class="del">-' + esc(file.deletions || 0) + '</span></span>' +
        localViewedButton(file) +
        '<button class="file-action" type="button" data-open-diff="' + esc(file.path) + '" title="' + esc(publishText.openEditableDiff) + '" aria-label="' + esc(publishText.openEditableDiff) + '" data-tooltip="' + esc(publishText.openEditableDiff) + '"><span class="codicon codicon-diff" aria-hidden="true"></span></button></div>';
    }
    function reviewFiles(preview) {
      if (preview.previewFiles && preview.previewFiles.length) return preview.previewFiles;
      return (preview.files || []).map((file) => Object.assign({ comments: [] }, file));
    }
    /** 표시 중인 파일 목록의 추가/삭제 라인 수를 한 번만 합산해 summary에 제공한다. */
    function diffSummary(files) {
      return files.reduce((summary, file) => ({
        additions: summary.additions + Number(file.additions || 0),
        deletions: summary.deletions + Number(file.deletions || 0),
      }), { additions: 0, deletions: 0 });
    }
    function commitPreviews(preview) {
      if (preview?.previewCommits?.length) return preview.previewCommits;
      return (preview?.commits || []).map((line) => {
        const parts = String(line || '').split(/\\s+/);
        const hash = /^[0-9a-f]{7,40}$/i.test(parts[0] || '') ? parts.shift() : line;
        return { hash, shortHash: hash.slice(0, 7), title: parts.join(' ') || line, files: [] };
      });
    }
    function findPreviewFile(path) { return reviewFiles(latestPreview).concat(commitPreviews(latestPreview).flatMap((commit) => commit.files || [])).find((file) => file.path === path); }
    function commitRow(commit) {
      const active = commit.hash === activeCommitHash;
      const title = template(publishText.showCommitFiles, commit.shortHash || commit.hash);
      return '<button class="commit-row' + (active ? ' active' : '') + '" type="button" data-commit-hash="' + esc(commit.hash) + '" title="' + esc(title) + '" aria-label="' + esc(title) + '" data-tooltip="' + esc(title) + '">' +
        '<span class="codicon codicon-git-commit" aria-hidden="true"></span><span class="commit-title">' + esc(commit.title) + '</span><span class="commit-hash">' + esc(commit.shortHash || '') + '</span></button>';
    }
    function viewToggleHtml(attr, active, items, label) { return '<div class="file-view-toggle" role="group" aria-label="' + esc(label || publishText.changedFilesView) + '">' + items.map((item) => viewToggleButton(attr, active, item[0], item[1], item[2], item[3])).join('') + '</div>'; }
    function viewToggleButton(attr, active, mode, icon, label, title) {
      return '<button class="file-view-button' + (active === mode ? ' active' : '') + '" type="button" data-' + attr + '="' + esc(mode) + '" aria-pressed="' + (active === mode ? 'true' : 'false') + '" title="' + esc(title) + '" aria-label="' + esc(title) + '" data-tooltip="' + esc(title) + '"><span class="codicon codicon-' + icon + '" aria-hidden="true"></span><span class="file-view-label">' + esc(label) + '</span></button>';
    }
    function displayPath(file) { return file.oldPath ? file.oldPath + ' -> ' + file.path : file.path; }
    function formatDate(iso) { const d = new Date(iso || ''); return isNaN(d.getTime()) ? '' : d.toLocaleString(); }
    function statusIcon(status) { return status === 'A' ? 'codicon-diff-added' : status === 'D' ? 'codicon-diff-removed' : (status === 'R' || status === 'C') ? 'codicon-diff-renamed' : status === 'U' ? 'codicon-warning' : 'codicon-diff-modified'; }
    ${pullRequestPreviewDiffScript()}
    ${pullRequestPreviewBranchComboboxScript()}
    ${pullRequestPreviewMarkdownScript()}
    ${pullRequestPreviewTimelineScript()}
    function esc(value) { return String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
    vscode.postMessage({ type: "ready" });
  `;
}

/** 번역 문자열을 inline script 문맥에서 태그 종료나 줄 구분자로 해석되지 않는 JSON으로 만든다. */
function webviewJson(value: PullRequestPreviewI18n): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
