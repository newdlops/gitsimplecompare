// PR preview 웹뷰 안에서 실행할 클라이언트 스크립트 조립 모듈.
// - 패널 생애주기 코드와 DOM 렌더링 스크립트를 분리해 파일 크기와 책임을 줄인다.
import { pullRequestPreviewBranchComboboxScript } from "./pullRequestPreviewBranchCombobox";
import { pullRequestPreviewDiffScript } from "./pullRequestPreviewDiffRenderer";
import { pullRequestPreviewMarkdownScript } from "./pullRequestPreviewMarkdown";
import { pullRequestPreviewTimelineScript } from "./pullRequestPreviewTimeline";

/**
 * preview 페이지 클라이언트 스크립트를 반환한다.
 * @returns 웹뷰 script 태그 안에 삽입할 JavaScript 문자열
 */
export function pullRequestPreviewScript(): string {
  return `
    const vscode = acquireVsCodeApi();
    const content = document.getElementById("content");
    const openPr = document.getElementById("open-pr");
    const generatePrMessage = document.getElementById("generate-pr-message");
    const configureAiCli = document.getElementById("configure-ai-cli");
    const copyPrMessage = document.getElementById("copy-pr-message");
    let activeTab = 'conversation';
    let activeCommitHash = '';
    let collapsedFolders = new Set();
    let collapsedFiles = new Set();
    let expandedDiffContexts = new Map();
    const savedState = vscode.getState?.() || {};
    let viewedFiles = new Set(Array.isArray(savedState.viewedFiles) ? savedState.viewedFiles : []);
    let fileNavMode = 'tree';
    let filesReviewMode = 'cards';
    let diffLayoutMode = savedState.diffLayoutMode === 'split' ? 'split' : 'unified';
    let latestPreview = null;
    let pendingSourceBranch = '';
    let pendingTargetBranch = '';
    let prMessageGenerationActive = false;
    document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    generatePrMessage?.addEventListener("click", () => {
      if (generatePrMessage.disabled || prMessageGenerationActive) return;
      setPrMessageGenerationActive(true);
      vscode.postMessage({ type: "generatePullRequestMessage" });
    });
    configureAiCli?.addEventListener("click", () => vscode.postMessage({ type: "configureAiCli" }));
    copyPrMessage?.addEventListener("click", () => {
      if (!latestPreview) return;
      vscode.postMessage({
        type: "copyPullRequestMessage",
        title: latestPreview.title || "",
        body: latestPreview.body || "",
      });
    });
    openPr.addEventListener("click", () => vscode.postMessage({ type: "openExistingPr" }));
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "preview") {
        if ((pendingSourceBranch && msg.preview.sourceBranch !== pendingSourceBranch) || (pendingTargetBranch && msg.preview.targetBranch !== pendingTargetBranch)) return;
        pendingSourceBranch = '';
        pendingTargetBranch = '';
        render(msg.preview);
      }
      if (msg.type === "commitFiles") applyCommitFiles(msg.hash, msg.files);
      if (msg.type === "generatedPullRequestMessage") applyGeneratedPullRequestMessage(msg.message);
      if (msg.type === "aiPullRequestMessageGeneration") setPrMessageGenerationActive(msg.active);
      if (msg.type === "error") content.innerHTML = '<p class="empty">' + esc(msg.message) + '</p>';
    });
    function render(preview) {
      latestPreview = preview;
      const files = reviewFiles(preview);
      const commits = commitPreviews(preview);
      const commentCount = files.reduce((sum, file) => sum + ((file.comments || []).length), 0);
      if (activeTab === 'commits' && commits.length && !commits.some((commit) => commit.hash === activeCommitHash)) {
        activeCommitHash = commits[0].hash;
      }
      if (activeTab === 'commits') markCommitFilesLoading(commits.find((commit) => commit.hash === activeCommitHash));
      const additions = files.reduce((sum, file) => sum + (file.additions || 0), 0);
      const deletions = files.reduce((sum, file) => sum + (file.deletions || 0), 0);
      openPr.hidden = !preview.existingPr?.url;
      syncActionButtons(preview);
      content.innerHTML =
        '<div class="pr-page">' +
          prHeader(preview) +
          tabbar(files.length, commits.length) +
          '<section class="quick-stats">' +
            metric('repo', 'Repository', preview.repository || 'unknown') +
            metric('files', 'Changed files', String(files.length)) +
            metric('comment-discussion', 'Review comments', String(commentCount)) +
            metric('diff', 'Diff summary', '+' + additions + ' / -' + deletions) +
          '</section>' +
          tabContent(preview, files, commits) +
        '</div>';
      bindTabs();
      bindCommitRows();
      bindTreeFolders();
      bindPreviewBranches();
      bindOpenDiffs();
      bindFileToggles();
      bindViewedToggles();
      bindViewButtons();
      bindContextToggles();
    }
    function syncActionButtons(preview) {
      const needsTarget = !preview.targetBranch;
      const generateTitle = prMessageGenerationActive
        ? 'Generating AI pull request message...'
        : needsTarget
          ? 'Select a target branch before generating a PR message'
          : !preview.hasStagedChanges
            ? 'Stage changes before generating an AI pull request message'
          : 'Generate AI pull request message';
      if (generatePrMessage) {
        generatePrMessage.disabled = prMessageGenerationActive || needsTarget || !preview.hasStagedChanges;
        generatePrMessage.title = generateTitle;
        generatePrMessage.setAttribute('aria-label', generateTitle);
        generatePrMessage.dataset.tooltip = generateTitle;
        generatePrMessage.classList.toggle('busy', prMessageGenerationActive);
      }
      if (copyPrMessage) {
        const canCopy = !!(preview.title || preview.body);
        const copyTitle = canCopy
          ? 'Copy pull request message'
          : 'No pull request message to copy';
        copyPrMessage.disabled = !canCopy;
        copyPrMessage.title = copyTitle;
        copyPrMessage.setAttribute('aria-label', copyTitle);
        copyPrMessage.dataset.tooltip = copyTitle;
      }
    }
    function setPrMessageGenerationActive(active) {
      prMessageGenerationActive = !!active;
      if (latestPreview) syncActionButtons(latestPreview);
      else if (generatePrMessage) {
        generatePrMessage.disabled = prMessageGenerationActive;
        generatePrMessage.classList.toggle('busy', prMessageGenerationActive);
        const title = prMessageGenerationActive ? 'Generating AI pull request message...' : 'Generate AI pull request message';
        generatePrMessage.title = title;
        generatePrMessage.setAttribute('aria-label', title);
        generatePrMessage.dataset.tooltip = title;
      }
    }
    function prHeader(preview) {
      const pr = preview.existingPr || {};
      const number = pr.number ? ' <span class="pr-number">#' + esc(pr.number) + '</span>' : '';
      const needsTarget = !preview.targetBranch;
      const state = needsTarget ? 'Select target' : pr.isDraft ? 'Draft' : (pr.state || (preview.hasStagedChanges ? 'Open' : 'No changes'));
      const stateClass = pr.isDraft ? 'draft' : ((needsTarget || (!preview.hasStagedChanges && !pr.state)) ? 'empty' : '');
      const source = pendingSourceBranch || preview.sourceBranch || preview.currentBranch;
      const targets = preview.targetBranches || [];
      const selected = pendingTargetBranch || preview.targetBranch;
      const title = preview.title || (needsTarget ? 'Select a target branch' : source + ' -> ' + selected);
      const sourceControl = branchControl('source-branch', 'source', 'from', 'Change source branch', source, preview.sourceBranches || []);
      const targetControl = branchControl('target-branch', 'target', 'target', 'Change target branch', selected, targets, 'Select target branch');
      return '<section class="pr-header">' +
        '<div class="title-row"><span class="state-pill ' + stateClass + '"><span class="codicon codicon-git-pull-request" aria-hidden="true"></span>' + esc(state) + '</span>' +
        '<h2 class="pr-title">' + esc(title) + number + '</h2></div>' +
        '<div class="branch-flow"><span class="codicon codicon-git-branch" aria-hidden="true"></span>' + sourceControl +
        '<span class="codicon codicon-arrow-right" aria-hidden="true"></span>' + targetControl + '</div>' +
      '</section>';
    }
    function tabbar(fileCount, commitCount) {
      return '<nav class="tabbar" aria-label="Pull request sections">' +
        tabButton('conversation', 'comment-discussion', 'Conversation', '') +
        tabButton('files', 'files', 'Files changed', fileCount) +
        tabButton('commits', 'git-commit', 'Commits', commitCount) +
      '</nav>';
    }
    function tabButton(tab, icon, label, count) {
      const active = activeTab === tab;
      const title = 'Show ' + label;
      return '<button class="tab' + (active ? ' active' : '') + '" type="button" data-tab="' + esc(tab) + '" ' +
        'aria-selected="' + (active ? 'true' : 'false') + '" title="' + esc(title) + '" aria-label="' + esc(title) + '" data-tooltip="' + esc(title) + '">' +
        '<span class="codicon codicon-' + icon + '" aria-hidden="true"></span>' + esc(label) +
        (count === '' ? '' : ' <span class="count">' + esc(count) + '</span>') + '</button>';
    }
    function tabContent(preview, files, commits) {
      if (activeTab === 'files') {
        return '<section class="content-single">' + filesPanel(files, preview) + '</section>';
      }
      if (activeTab === 'commits') {
        return '<section class="commit-review">' + commitsPanel(commits, preview) + commitFilesPanel(commits, preview) + '</section>';
      }
      return '<section class="content-grid">' + conversation(preview) +
        '<div class="side-stack">' + fileTreePanel(files, preview) + commitsPanel(commits, preview) + '</div></section>';
    }
    function bindTabs() {
      content.querySelectorAll('[data-tab]').forEach((button) => {
        button.addEventListener('click', () => {
          activeTab = button.dataset.tab || 'conversation';
          if (activeTab === 'commits') activeCommitHash = activeCommitHash || (commitPreviews(latestPreview)[0]?.hash || '');
          if (latestPreview) render(latestPreview);
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
    function bindTreeFolders() {
      content.querySelectorAll('[data-folder-key]').forEach((button) => {
        button.addEventListener('click', () => {
          const key = button.dataset.folderKey || '';
          if (collapsedFolders.has(key)) collapsedFolders.delete(key); else collapsedFolders.add(key);
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
    function bindViewedToggles() {
      content.querySelectorAll('[data-toggle-viewed-file]').forEach((button) => {
        button.addEventListener('click', () => {
          const path = button.dataset.toggleViewedFile || '';
          const file = findPreviewFile(path) || { path };
          const key = fileReviewKey(file);
          if (viewedFiles.has(key)) {
            viewedFiles.delete(key);
            collapsedFiles.delete(path);
          } else {
            viewedFiles.add(key);
            collapsedFiles.add(path);
          }
          persistReviewState();
          if (latestPreview) render(latestPreview);
        });
      });
    }
    function bindViewButtons() {
      content.querySelectorAll('[data-file-nav-mode]').forEach((button) => {
        button.addEventListener('click', () => { fileNavMode = button.dataset.fileNavMode || 'tree'; if (latestPreview) render(latestPreview); });
      });
      content.querySelectorAll('[data-files-review-mode]').forEach((button) => {
        button.addEventListener('click', () => { filesReviewMode = button.dataset.filesReviewMode || 'cards'; if (latestPreview) render(latestPreview); });
      });
      content.querySelectorAll('[data-diff-layout-mode]').forEach((button) => {
        button.addEventListener('click', () => setDiffLayoutMode(button.dataset.diffLayoutMode || 'unified'));
      });
    }
    function setDiffLayoutMode(mode) {
      diffLayoutMode = mode === 'split' ? 'split' : 'unified';
      persistReviewState();
      if (latestPreview) render(latestPreview);
    }
    function persistReviewState() {
      vscode.setState?.(Object.assign({}, vscode.getState?.() || {}, { diffLayoutMode, viewedFiles: Array.from(viewedFiles) }));
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
    function conversation(preview) {
      const items = preview.conversation?.length ? preview.conversation : [{ author: preview.existingPr?.author || preview.currentBranch || 'local', body: bodyText(preview), kind: 'body' }];
      return '<section class="timeline">' + items.map(timelineItem).join('') + '</section>';
    }
    function bodyText(preview) {
      if (preview.body) return preview.body;
      if (!preview.targetBranch) return 'Select a target branch to generate a staged PR preview.';
      return preview.existingPr ? 'No PR body.' : 'No staged PR body generated.';
    }
    function filesPanel(files, preview) {
      const emptyText = !preview?.targetBranch ? 'Select a target branch to load changed files.' : 'No changed files.';
      const body = filesReviewMode === 'continuous'
        ? '<div class="continuous-diff-list">' + files.map(continuousFileHtml).join('') + '</div>'
        : '<div class="file-list">' + files.map(reviewFileHtml).join('') + '</div>';
      return '<section class="panel' + (files.length ? '' : ' warning') + '"><div class="panel-header"><span class="panel-title"><span class="codicon codicon-files" aria-hidden="true"></span>Files changed</span><div class="panel-actions">' +
        viewToggleHtml('files-review-mode', filesReviewMode, [['cards', 'files', 'Cards', 'Show each file in a separated card'], ['continuous', 'list-flat', 'Stream', 'Show files as one continuous diff stream']], 'Files display mode') +
        viewToggleHtml('diff-layout-mode', diffLayoutMode, [['unified', 'diff-single', '1 col', 'Show unified one-column diff'], ['split', 'diff-multiple', '2 col', 'Show split two-column diff']], 'Diff layout') +
        '<span class="count">' + esc(files.length) + '</span></div></div>' +
        (files.length ? body : '<p class="empty">' + esc(emptyText) + '</p>') + '</section>';
    }
    function commitsPanel(commits, preview) {
      const emptyText = !preview?.targetBranch ? 'Select a target branch to load commits.' : 'No commits ahead of target.';
      return '<section class="panel"><div class="panel-header"><span class="panel-title"><span class="codicon codicon-git-commit" aria-hidden="true"></span>Commits</span><span class="count">' + esc(commits.length) + '</span></div>' +
        (commits.length ? '<div class="commit-list">' + commits.map(commitRow).join('') + '</div>' : '<p class="empty">' + esc(emptyText) + '</p>') + '</section>';
    }
    function commitFilesPanel(commits, preview) {
      if (!preview?.targetBranch) return '<section class="panel"><p class="empty">Select a target branch to inspect commit files.</p></section>';
      const commit = commits.find((item) => item.hash === activeCommitHash) || commits[0];
      if (commit?.loading) return '<section class="panel"><p class="empty">Loading commit files...</p></section>';
      return commit ? filesPanel(commit.files || [], preview) : '<section class="panel"><p class="empty">Select a commit to inspect changed files.</p></section>';
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
    function applyGeneratedPullRequestMessage(message) {
      if (!latestPreview || !message) return;
      latestPreview.title = message.title || latestPreview.title;
      latestPreview.body = message.body || latestPreview.body;
      const author = latestPreview.existingPr?.author || latestPreview.sourceBranch || latestPreview.currentBranch || 'AI';
      const bodyItem = { kind: 'body', author, body: latestPreview.body, action: 'generated this pull request message' };
      const rest = (latestPreview.conversation || []).filter((item) => item.kind !== 'body');
      latestPreview.conversation = [bodyItem].concat(rest);
      activeTab = 'conversation';
      render(latestPreview);
    }
    function metric(icon, label, value) {
      return '<div class="metric"><div class="metric-label"><span class="codicon codicon-' + icon + '" aria-hidden="true"></span>' + esc(label) + '</div><div class="metric-value">' + esc(value) + '</div></div>';
    }
    function reviewFileHtml(file) {
      const path = displayPath(file);
      const comments = file.comments || [];
      const collapsed = collapsedFiles.has(file.path);
      const viewed = viewedFiles.has(fileReviewKey(file));
      return '<article class="review-file' + (collapsed ? ' collapsed' : '') + (viewed ? ' viewed' : '') + '" data-status="' + esc(file.status) + '">' +
        reviewFileHeaderHtml(file, path, comments, collapsed, viewed) +
        (collapsed ? '' : '<div class="review-file-body">' + patchHtml(file.patch, false, file.path, comments, diffLayoutMode) + '</div>') + '</article>';
    }
    function continuousFileHtml(file) {
      const comments = file.comments || [];
      const collapsed = collapsedFiles.has(file.path);
      const path = displayPath(file);
      const viewed = viewedFiles.has(fileReviewKey(file));
      return '<article class="review-file continuous-file' + (collapsed ? ' collapsed' : '') + (viewed ? ' viewed' : '') + '" data-status="' + esc(file.status) + '">' +
        reviewFileHeaderHtml(file, path, comments, collapsed, viewed) +
        (collapsed ? '' : '<div class="review-file-body">' + splitPatchHtml(file.patch, file.path, comments, diffLayoutMode) + '</div>') + '</article>';
    }
    function reviewFileHeaderHtml(file, path, comments, collapsed, viewed) {
      const toggleTitle = (collapsed ? 'Expand file diff for ' : 'Collapse file diff for ') + path;
      const viewedTitle = (viewed ? 'Mark file as not viewed: ' : 'Mark file as viewed: ') + path;
      return '<div class="review-file-head" title="' + esc(path) + '">' +
        '<button class="file-toggle" type="button" data-toggle-file="' + esc(file.path) + '" title="' + esc(toggleTitle) + '" aria-label="' + esc(toggleTitle) + '" data-tooltip="' + esc(toggleTitle) + '"><span class="codicon ' + (collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down') + '" aria-hidden="true"></span></button>' +
        '<span class="status-icon codicon ' + statusIcon(file.status) + '" aria-hidden="true"></span>' +
        '<span class="review-file-title">' + esc(path) + '</span>' +
        '<span class="comment-chip"><span class="codicon codicon-comment-discussion" aria-hidden="true"></span>' + esc(comments.length) + '</span>' +
        '<span class="stat"><span class="add">+' + esc(file.additions || 0) + '</span><span class="del">-' + esc(file.deletions || 0) + '</span></span>' +
        '<button class="viewed-toggle' + (viewed ? ' viewed' : '') + '" type="button" data-toggle-viewed-file="' + esc(file.path) + '" aria-pressed="' + (viewed ? 'true' : 'false') + '" title="' + esc(viewedTitle) + '" aria-label="' + esc(viewedTitle) + '" data-tooltip="' + esc(viewedTitle) + '"><span class="codicon codicon-check" aria-hidden="true"></span><span>Viewed</span></button>' +
        '<button class="file-action" type="button" data-open-diff="' + esc(file.path) + '" title="Open editable diff" aria-label="Open editable diff" data-tooltip="Open editable diff"><span class="codicon codicon-diff" aria-hidden="true"></span></button></div>';
    }
    function fileReviewKey(file) {
      const scope = [latestPreview?.repository || '', latestPreview?.existingPr?.number || '', latestPreview?.targetRef || latestPreview?.targetBranch || '', latestPreview?.sourceRef || latestPreview?.sourceBranch || latestPreview?.currentBranch || ''].join('|');
      return scope + '::' + (file.path || '');
    }
    function reviewFiles(preview) {
      if (preview.previewFiles && preview.previewFiles.length) return preview.previewFiles;
      return (preview.files || []).map((file) => Object.assign({ comments: [] }, file));
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
      const title = 'Show files changed in commit ' + (commit.shortHash || commit.hash);
      return '<button class="commit-row' + (active ? ' active' : '') + '" type="button" data-commit-hash="' + esc(commit.hash) + '" title="' + esc(title) + '" aria-label="' + esc(title) + '" data-tooltip="' + esc(title) + '">' +
        '<span class="codicon codicon-git-commit" aria-hidden="true"></span><span class="commit-title">' + esc(commit.title) + '</span><span class="commit-hash">' + esc(commit.shortHash || '') + '</span></button>';
    }
    function fileTreePanel(files, preview) {
      const emptyText = !preview?.targetBranch ? 'Select a target branch to load changed files.' : 'No changed files.';
      return '<section class="panel"><div class="panel-header"><span class="panel-title"><span class="codicon codicon-list-tree" aria-hidden="true"></span>Files changed</span><div class="panel-actions">' +
        viewToggleHtml('file-nav-mode', fileNavMode, [['tree', 'list-tree', 'Tree', 'View changed files as tree'], ['list', 'list-selection', 'List', 'View changed files as list']]) +
        '<span class="count">' + esc(files.length) + '</span></div></div>' +
        (files.length ? fileNavHtml(files) : '<p class="empty">' + esc(emptyText) + '</p>') + '</section>';
    }
    function fileNavHtml(files) {
      if (fileNavMode === 'list') return '<div class="file-tree list">' + files.map((file) => treeFileHtml(file, displayPath(file), 0)).join('') + '</div>';
      return '<div class="file-tree">' + treeNodesHtml(buildTree(files), 0) + '</div>';
    }
    function buildTree(files) {
      const base = commonDirectory(files);
      const root = [];
      const folders = new Map();
      files.forEach((file) => {
        const parts = stripBase(file.path, base).split('/').filter(Boolean);
        let children = root;
        let current = base.join('/');
        for (let i = 0; i < Math.max(0, parts.length - 1); i++) {
          current = current ? current + '/' + parts[i] : parts[i];
          let folder = folders.get(current);
          if (!folder) {
            folder = { kind: 'folder', name: parts[i], path: current, children: [] };
            folders.set(current, folder);
            children.push(folder);
          }
          children = folder.children;
        }
        children.push({ kind: 'file', file, name: parts[parts.length - 1] || file.path });
      });
      return root;
    }
    function commonDirectory(files) {
      const dirs = files.map((file) => String(file.path || '').split('/').filter(Boolean).slice(0, -1));
      if (!dirs.length) return [];
      const prefix = [];
      for (let i = 0; i < dirs[0].length; i++) {
        const segment = dirs[0][i];
        if (dirs.every((dir) => dir[i] === segment)) prefix.push(segment); else break;
      }
      return prefix;
    }
    function stripBase(filePath, base) {
      if (!base.length) return filePath;
      const prefix = base.join('/') + '/';
      return filePath.indexOf(prefix) === 0 ? filePath.slice(prefix.length) : filePath;
    }
    function treeNodesHtml(nodes, depth) {
      return nodes.map((node) => {
        if (node.kind === 'file') return treeFileHtml(node.file, node.name, depth);
        const collapsed = collapsedFolders.has(node.path);
        const title = (collapsed ? 'Expand ' : 'Collapse ') + node.path;
        return '<div class="tree-node"><button class="tree-row tree-folder" type="button" data-folder-key="' + esc(node.path) + '" style="--indent:' + esc(depth * 16) + 'px" title="' + esc(title) + '" aria-label="' + esc(title) + '" data-tooltip="' + esc(title) + '">' +
          '<span class="twistie codicon ' + (collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down') + '" aria-hidden="true"></span><span class="codicon ' + (collapsed ? 'codicon-folder' : 'codicon-folder-opened') + '" aria-hidden="true"></span><span></span><span class="tree-label">' + esc(node.name) + '</span><span></span></button>' +
          '<div class="tree-children' + (collapsed ? ' collapsed' : '') + '">' + treeNodesHtml(node.children, depth + 1) + '</div></div>';
      }).join('');
    }
    function treeFileHtml(file, name, depth) {
      return '<div class="tree-row" data-status="' + esc(file.status) + '" style="--indent:' + esc(depth * 16) + 'px" title="' + esc(file.path) + '">' +
        '<span class="twistie"></span><span class="codicon ' + statusIcon(file.status) + '" aria-hidden="true"></span><span class="codicon codicon-file" aria-hidden="true"></span><span class="tree-label">' + esc(name) + '</span>' +
        '<span class="stat"><span class="add">+' + esc(file.additions || 0) + '</span><span class="del">-' + esc(file.deletions || 0) + '</span></span></div>';
    }
    function viewToggleHtml(attr, active, items, label) { return '<div class="file-view-toggle" role="group" aria-label="' + esc(label || 'Changed files view') + '">' + items.map((item) => viewToggleButton(attr, active, item[0], item[1], item[2], item[3])).join('') + '</div>'; }
    function viewToggleButton(attr, active, mode, icon, label, title) {
      return '<button class="file-view-button' + (active === mode ? ' active' : '') + '" type="button" data-' + attr + '="' + esc(mode) + '" aria-pressed="' + (active === mode ? 'true' : 'false') + '" title="' + esc(title) + '" aria-label="' + esc(title) + '" data-tooltip="' + esc(title) + '"><span class="codicon codicon-' + icon + '" aria-hidden="true"></span><span class="file-view-label">' + esc(label) + '</span></button>';
    }
    function displayPath(file) { return file.oldPath ? file.oldPath + ' -> ' + file.path : file.path; }
    function formatDate(iso) { const d = new Date(iso || ''); return isNaN(d.getTime()) ? '' : d.toLocaleString(); }
    function statusIcon(status) { return status === 'A' ? 'codicon-diff-added' : status === 'D' ? 'codicon-diff-removed' : (status === 'R' || status === 'C') ? 'codicon-diff-renamed' : status === 'U' ? 'codicon-warning' : 'codicon-diff-modified'; }
    ${pullRequestPreviewDiffScript()}
    ${pullRequestPreviewBranchComboboxScript()}
    ${pullRequestPreviewTimelineScript()}
    ${pullRequestPreviewMarkdownScript()}
    function initial(value) { return String(value || '?').trim().charAt(0).toUpperCase() || '?'; }
    function esc(value) { return String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
    vscode.postMessage({ type: "ready" });
  `;
}
