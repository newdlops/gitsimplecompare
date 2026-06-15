// staged 상태를 target branch 로 PR 한다고 가정한 모의 페이지 웹뷰.
// - PR 데이터 생성은 PullRequestService 에 맡기고, 이 파일은 패널 생애주기와 렌더링만 담당한다.
import * as vscode from "vscode";
import {
  PullRequestInfo,
  PullRequestService,
} from "../git/pullRequestService";
import { logError } from "../ui/outputLog";
import {
  openPullRequestPreviewDiff,
  type PullRequestPreviewDiffRequest,
} from "../ui/pullRequestPreviewDiff";
import { pullRequestPreviewMarkdownScript } from "./pullRequestPreviewMarkdown";
import { pullRequestPreviewStyles } from "./pullRequestPreviewStyles";

type PreviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "openExistingPr" }
  | { type: "setBaseBranch"; branch: string }
  | { type: "loadCommitFiles"; hash: string }
  | ({ type: "openEditableDiff" } & PullRequestPreviewDiffRequest);

/** staged PR preview 웹뷰 패널 */
export class PullRequestPreviewPanel {
  private static current: PullRequestPreviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private lastTargetBranch?: string;
  private lastTargetRef?: string;
  private previewRequestSeq = 0;

  /**
   * staged PR preview 패널을 만들거나 기존 패널을 재사용한다.
   * @param service PR preview 데이터를 만드는 서비스
   * @param baseBranch PR target branch
   * @param existingPr 기존 PR 에서 preview 를 연 경우의 PR 정보
   */
  static createOrShow(
    extensionUri: vscode.Uri,
    service: PullRequestService,
    baseBranch?: string,
    existingPr?: PullRequestInfo
  ): void {
    if (PullRequestPreviewPanel.current) {
      PullRequestPreviewPanel.current.service = service;
      PullRequestPreviewPanel.current.baseBranch = baseBranch;
      PullRequestPreviewPanel.current.existingPr = existingPr;
      PullRequestPreviewPanel.current.panel.reveal();
      void PullRequestPreviewPanel.current.sendPreview();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "gitSimpleCompare.prPreview",
      vscode.l10n.t("Staged PR Preview"),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    PullRequestPreviewPanel.current = new PullRequestPreviewPanel(
      panel,
      extensionUri,
      service,
      baseBranch,
      existingPr
    );
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private service: PullRequestService,
    private baseBranch?: string,
    private existingPr?: PullRequestInfo
  ) {
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(
      (msg: PreviewMessage) => this.handleMessage(msg),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /** 패널 리소스를 정리한다. */
  private dispose(): void {
    PullRequestPreviewPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  /**
   * 웹뷰 메시지를 처리한다.
   * @param msg 웹뷰에서 보낸 메시지
   */
  private async handleMessage(msg: PreviewMessage): Promise<void> {
    if (msg.type === "ready" || msg.type === "refresh") {
      await this.sendPreview();
      return;
    }
    if (msg.type === "openExistingPr" && this.existingPr?.url) {
      await vscode.env.openExternal(vscode.Uri.parse(this.existingPr.url));
      return;
    }
    if (msg.type === "setBaseBranch") {
      this.baseBranch = msg.branch || undefined;
      if (this.existingPr?.baseRefName && msg.branch !== this.existingPr.baseRefName) {
        this.existingPr = undefined;
      }
      await this.sendPreview();
      return;
    }
    if (msg.type === "openEditableDiff") {
      await this.openEditableDiff(msg);
      return;
    }
    if (msg.type === "loadCommitFiles") {
      await this.sendCommitFiles(msg.hash);
    }
  }

  /**
   * PR preview 파일을 기준 브랜치와 작업트리의 editable diff 로 연 뒤, 오른쪽 파일에 review comment 를 표시한다.
   * @param msg 웹뷰에서 선택한 파일 경로와 comment 목록
   */
  private async openEditableDiff(msg: Extract<PreviewMessage, { type: "openEditableDiff" }>): Promise<void> {
    try {
      await openPullRequestPreviewDiff(this.service.repoRoot, {
        ...msg,
        baseRef: msg.baseRef || this.lastTargetRef || this.baseBranch || this.lastTargetBranch,
        headRef: msg.headRef || this.existingPr?.headHash || "HEAD",
      });
    } catch (error) {
      logError("PR preview editable diff open failed", error);
    }
  }

  /** Commits 탭에서 선택한 commit 의 파일 변경을 웹뷰에 보낸다. */
  private async sendCommitFiles(hash: string): Promise<void> {
    try {
      this.post({ type: "commitFiles", hash, files: await this.service.getPreviewCommitFiles(hash) });
    } catch (error) {
      logError("PR preview commit files failed", error);
      this.post({ type: "commitFiles", hash, files: [] });
    }
  }

  /** staged preview 데이터를 읽어 웹뷰에 보낸다. */
  private async sendPreview(): Promise<void> {
    const requestSeq = ++this.previewRequestSeq;
    try {
      const preview = await this.service.getStagedPreview(
        this.baseBranch,
        this.existingPr
      );
      if (requestSeq !== this.previewRequestSeq) {
        return;
      }
      this.lastTargetBranch = preview.targetBranch;
      this.lastTargetRef = preview.targetRef;
      this.post({ type: "preview", preview });
    } catch (error) {
      if (requestSeq !== this.previewRequestSeq) {
        return;
      }
      logError("staged PR preview failed", error);
      this.post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** preview 웹뷰 HTML 을 만든다. */
  private html(): string {
    const nonce = nonceValue();
    const codiconUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "codicons", "codicon.css")
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${this.panel.webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${this.panel.webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
      <meta http-equiv="Content-Security-Policy" content="${csp}" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <link href="${codiconUri}" rel="stylesheet" />
      <style nonce="${nonce}">${pullRequestPreviewStyles()}</style>
      <title>Staged PR Preview</title></head><body>
      <header class="topbar">
        <div class="topbar-title">
          <span class="codicon codicon-git-pull-request" aria-hidden="true"></span>
          <h1>Pull request preview</h1>
        </div>
        <div class="actions">
          <button id="refresh" class="icon-button" type="button" title="Refresh staged PR preview"
            aria-label="Refresh staged PR preview" data-tooltip="Refresh staged PR preview">
            <span class="codicon codicon-refresh" aria-hidden="true"></span>
          </button>
          <button id="open-pr" class="icon-button" type="button" title="Open related pull request"
            aria-label="Open related pull request" data-tooltip="Open related pull request" hidden>
            <span class="codicon codicon-mark-github" aria-hidden="true"></span>
          </button>
        </div>
      </header>
      <main id="content"><p class="placeholder">Loading...</p></main>
      <script nonce="${nonce}">${script()}</script>
    </body></html>`;
  }

  /** 타입이 보장된 메시지를 웹뷰로 보낸다. */
  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }
}

/** nonce 문자열을 만든다. */
function nonceValue(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

/** preview 페이지 클라이언트 스크립트를 반환한다. */
function script(): string {
  return `
    const vscode = acquireVsCodeApi();
    const content = document.getElementById("content");
    const openPr = document.getElementById("open-pr");
    let activeTab = 'conversation';
    let activeCommitHash = '';
    let collapsedFolders = new Set();
    let collapsedFiles = new Set();
    let latestPreview = null;
    let pendingTargetBranch = '';
    document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    openPr.addEventListener("click", () => vscode.postMessage({ type: "openExistingPr" }));
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "preview") {
        if (pendingTargetBranch && msg.preview.targetBranch !== pendingTargetBranch) return;
        pendingTargetBranch = '';
        render(msg.preview);
      }
      if (msg.type === "commitFiles") applyCommitFiles(msg.hash, msg.files);
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
      bindTargetBranch();
      bindOpenDiffs();
      bindFileToggles();
    }
    function prHeader(preview) {
      const pr = preview.existingPr || {};
      const number = pr.number ? ' <span class="pr-number">#' + esc(pr.number) + '</span>' : '';
      const state = pr.isDraft ? 'Draft' : (pr.state || (preview.hasStagedChanges ? 'Open' : 'No changes'));
      const stateClass = pr.isDraft ? 'draft' : (!preview.hasStagedChanges && !pr.state ? 'empty' : '');
      const targets = preview.targetBranches || [];
      const selected = pendingTargetBranch || preview.targetBranch;
      const targetControl = targets.length
        ? '<select id="target-branch" class="branch-select" title="Change base branch" aria-label="Change base branch">' + Array.from(new Set([selected].concat(targets))).map((branch) => '<option value="' + esc(branch) + '"' + (branch === selected ? ' selected' : '') + '>' + esc(branch) + '</option>').join('') + '</select>'
        : '<code>' + esc(preview.targetBranch) + '</code>';
      return '<section class="pr-header">' +
        '<div class="title-row"><span class="state-pill ' + stateClass + '"><span class="codicon codicon-git-pull-request" aria-hidden="true"></span>' + esc(state) + '</span>' +
        '<h2 class="pr-title">' + esc(preview.title) + number + '</h2></div>' +
        '<div class="branch-flow"><span class="codicon codicon-git-branch" aria-hidden="true"></span><code>' + esc(preview.currentBranch) + '</code>' +
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
        return '<section class="content-single">' + filesPanel(files) + '</section>';
      }
      if (activeTab === 'commits') {
        return '<section class="commit-review">' + commitsPanel(commits) + commitFilesPanel(commits) + '</section>';
      }
      return '<section class="content-grid">' + conversation(preview) +
        '<div class="side-stack">' + fileTreePanel(files) + commitsPanel(commits) + '</div></section>';
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
    function bindTargetBranch() {
      const select = document.getElementById('target-branch');
      select?.addEventListener('change', () => { pendingTargetBranch = select.value; if (latestPreview) render(latestPreview); vscode.postMessage({ type: 'setBaseBranch', branch: select.value }); });
    }
    function bindOpenDiffs() {
      content.querySelectorAll('[data-open-diff]').forEach((button) => {
        button.addEventListener('click', () => {
          const file = findPreviewFile(button.dataset.openDiff || '');
          if (file) vscode.postMessage({ type: 'openEditableDiff', path: file.path, oldPath: file.oldPath, status: file.status, baseRef: latestPreview?.targetRef || latestPreview?.targetBranch, headRef: latestPreview?.headRef || latestPreview?.existingPr?.headHash || 'HEAD', comments: file.comments || [] });
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
    function conversation(preview) {
      const items = preview.conversation?.length ? preview.conversation : [{ author: preview.existingPr?.author || preview.currentBranch || 'local', body: bodyText(preview), kind: 'body' }];
      return '<section class="timeline">' + items.map(timelineItem).join('') + '</section>';
    }
    function bodyText(preview) {
      if (preview.body) return preview.body;
      return preview.existingPr ? 'No PR body.' : 'No staged PR body generated.';
    }
    function filesPanel(files) {
      return '<section class="panel' + (files.length ? '' : ' warning') + '"><div class="panel-header"><span class="panel-title"><span class="codicon codicon-files" aria-hidden="true"></span>Files changed</span><span class="count">' + esc(files.length) + '</span></div>' +
        (files.length ? '<div class="file-list">' + files.map(reviewFileHtml).join('') + '</div>' : '<p class="empty">No changed files.</p>') + '</section>';
    }
    function commitsPanel(commits) {
      return '<section class="panel"><div class="panel-header"><span class="panel-title"><span class="codicon codicon-git-commit" aria-hidden="true"></span>Commits</span><span class="count">' + esc(commits.length) + '</span></div>' +
        (commits.length ? '<div class="commit-list">' + commits.map(commitRow).join('') + '</div>' : '<p class="empty">No commits ahead of target.</p>') + '</section>';
    }
    function commitFilesPanel(commits) {
      const commit = commits.find((item) => item.hash === activeCommitHash) || commits[0];
      if (commit?.loading) return '<section class="panel"><p class="empty">Loading commit files...</p></section>';
      return commit ? filesPanel(commit.files || []) : '<section class="panel"><p class="empty">Select a commit to inspect changed files.</p></section>';
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
    function metric(icon, label, value) {
      return '<div class="metric"><div class="metric-label"><span class="codicon codicon-' + icon + '" aria-hidden="true"></span>' + esc(label) + '</div><div class="metric-value">' + esc(value) + '</div></div>';
    }
    function reviewFileHtml(file) {
      const path = file.oldPath ? file.oldPath + ' -> ' + file.path : file.path;
      const comments = file.comments || [];
      const collapsed = collapsedFiles.has(file.path);
      const toggleTitle = (collapsed ? 'Expand ' : 'Collapse ') + path;
      return '<article class="review-file' + (collapsed ? ' collapsed' : '') + '" data-status="' + esc(file.status) + '">' +
        '<div class="review-file-head" title="' + esc(path) + '">' +
        '<button class="file-toggle" type="button" data-toggle-file="' + esc(file.path) + '" title="' + esc(toggleTitle) + '" aria-label="' + esc(toggleTitle) + '" data-tooltip="' + esc(toggleTitle) + '"><span class="codicon ' + (collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down') + '" aria-hidden="true"></span></button>' +
        '<span class="status-icon codicon ' + statusIcon(file.status) + '" aria-hidden="true"></span>' +
        '<span class="review-file-title">' + esc(path) + '</span>' +
        '<span class="comment-chip"><span class="codicon codicon-comment-discussion" aria-hidden="true"></span>' + esc(comments.length) + '</span>' +
        '<span class="stat"><span class="add">+' + esc(file.additions || 0) + '</span><span class="del">-' + esc(file.deletions || 0) + '</span></span>' +
        '<button class="file-action" type="button" data-open-diff="' + esc(file.path) + '" title="Open editable diff" aria-label="Open editable diff" data-tooltip="Open editable diff"><span class="codicon codicon-diff" aria-hidden="true"></span></button></div>' +
        (collapsed ? '' : '<div class="review-file-body">' + patchHtml(file.patch, false) + commentsHtml(comments) + '</div>') + '</article>';
    }
    function patchHtml(patch, compact) {
      if (!patch) return '<p class="empty">Diff snippet is unavailable for this file.</p>';
      const lines = String(patch).split('\\n');
      const visible = lines.slice(0, compact ? 40 : 180).map(diffLineHtml).join('');
      const omitted = lines.length > (compact ? 40 : 180)
        ? '<div class="diff-line"><span class="line-marker">...</span><span class="line-code">Snippet truncated</span></div>' : '';
      return '<div class="diff-snippet' + (compact ? ' mini-diff' : '') + '">' + visible + omitted + '</div>';
    }
    function diffLineHtml(line) {
      const marker = line.startsWith('+') ? '+' : line.startsWith('-') ? '-' : line.startsWith('@@') ? '@@' : '';
      const cls = marker === '+' ? ' add' : marker === '-' ? ' del' : marker === '@@' ? ' hunk' : '';
      const code = marker && marker !== '@@' ? line.slice(1) : line;
      return '<div class="diff-line' + cls + '"><span class="line-marker">' + esc(marker) + '</span><span class="line-code">' + esc(code || ' ') + '</span></div>';
    }
    function commentsHtml(comments) {
      if (!comments.length) return '';
      return '<div class="review-comments">' + comments.map(commentHtml).join('') + '</div>';
    }
    function commentHtml(comment) {
      const line = comment.line || comment.originalLine;
      const where = line ? 'line ' + line : (comment.side || 'review');
      return '<article class="review-comment"><div class="comment-meta"><span class="codicon codicon-comment-discussion" aria-hidden="true"></span><strong>' +
        esc(comment.author || 'unknown') + '</strong><span>' + esc(where) + '</span></div>' +
        '<div class="comment-body markdown-body">' + renderMarkdown(comment.body || '') + '</div>' +
        (comment.diffHunk ? patchHtml(comment.diffHunk, true) : '') + '</article>';
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
    function timelineItem(item) {
      const title = item.kind === 'body' ? 'opened this pull request' : 'commented';
      return '<article class="timeline-item"><span class="avatar">' + esc(initial(item.author)) + '</span><div class="timeline-card">' +
        '<div class="timeline-head"><strong>' + esc(item.author || 'unknown') + '</strong><span>' + esc(title) + '</span>' + (item.createdAt ? '<span>' + esc(formatDate(item.createdAt)) + '</span>' : '') + '</div>' +
        '<div class="markdown-body">' + renderMarkdown(item.body || '') + '</div></div></article>';
    }
    function fileTreePanel(files) {
      return '<section class="panel"><div class="panel-header"><span class="panel-title"><span class="codicon codicon-list-tree" aria-hidden="true"></span>Files changed</span><span class="count">' + esc(files.length) + '</span></div>' +
        (files.length ? '<div class="file-tree">' + treeNodesHtml(buildTree(files), 0) + '</div>' : '<p class="empty">No changed files.</p>') + '</section>';
    }
    function buildTree(files) {
      const root = [];
      const folders = new Map();
      files.forEach((file) => {
        const parts = file.path.split('/').filter(Boolean);
        let children = root;
        let current = '';
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
    function formatDate(iso) {
      const d = new Date(iso || '');
      return isNaN(d.getTime()) ? '' : d.toLocaleString();
    }
    function statusIcon(status) {
      if (status === 'A') return 'codicon-diff-added';
      if (status === 'D') return 'codicon-diff-removed';
      if (status === 'R' || status === 'C') return 'codicon-diff-renamed';
      if (status === 'U') return 'codicon-warning';
      return 'codicon-diff-modified';
    }
    ${pullRequestPreviewMarkdownScript()}
    function initial(value) { return String(value || '?').trim().charAt(0).toUpperCase() || '?'; }
    function esc(value) { return String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
    vscode.postMessage({ type: "ready" });
  `;
}
