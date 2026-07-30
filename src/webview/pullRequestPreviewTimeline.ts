/**
 * PR preview의 로컬 Conversation과 보조 탐색기를 위한 생성 스크립트를 만든다.
 * @returns preview script lexical scope에 삽입할 Conversation 렌더링/상호작용 코드
 */
export function pullRequestPreviewTimelineScript(): string {
  return `
    /** staged preview를 GitHub 같은 로컬 Conversation으로 표시하고 서버 상태처럼 보이지 않게 한다. */
    function conversationPanel(preview, files, commits) {
      const opening = { author: publishText.localDraft, body: effectiveMessage(preview).body || publishText.noDescription, createdAt: '' };
      const items = [opening].concat(Array.isArray(preview.conversation) ? preview.conversation : []);
      return '<div class="preview-conversation-layout" style="--preview-inspector-width:' + esc(inspectorWidth) + 'px"><div class="preview-conversation-main"><section class="panel preview-opening"><div class="panel-header"><span class="panel-title"><span class="codicon codicon-comment-discussion" aria-hidden="true"></span>' + esc(publishText.conversation) + '</span></div>' + composerHtml(preview) + '</section><section class="preview-timeline" aria-label="' + esc(publishText.conversation) + '">' + items.map(conversationItemHtml).join('') + '</section></div><div class="preview-inspector-splitter" role="separator" aria-orientation="vertical" tabindex="0" title="' + esc(publishText.resizeChangedFilesInspector) + '" aria-label="' + esc(publishText.resizeChangedFilesInspector) + '" data-tooltip="' + esc(publishText.resizeChangedFilesInspector) + '"></div>' + previewInspectorHtml(files, commits) + '</div>';
    }
    /** supplied local item을 안전하게 짧은 timeline 행으로 변환한다. */
    function conversationItemHtml(item) {
      const author = item.author || item.user || publishText.localDraft;
      const body = item.body || item.message || '';
      const when = item.createdAt || item.date || '';
      return '<article class="preview-conversation-item"' + (item.author === publishText.localDraft && !item.createdAt ? ' data-preview-opening' : '') + '><div class="preview-conversation-item__head"><span class="codicon codicon-account" aria-hidden="true"></span><strong>' + esc(author) + '</strong>' + (when ? '<span>' + esc(formatDate(when)) + '</span>' : '') + '</div><div class="preview-conversation-item__body">' + renderMarkdown(body) + '</div></article>';
    }
    /** 파일 path를 folder 단위로 묶어 Conversation에서 Files changed 진입점을 제공한다. */
    function previewInspectorHtml(files, commits) {
      const nodes = Object.create(null);
      files.forEach((file) => { let branch = nodes; String(file.path || '').split('/').forEach((part, index, parts) => { if (index === parts.length - 1) branch[part] = file; else branch = branch[part] || (branch[part] = Object.create(null)); }); });
      return '<aside class="preview-inspector" aria-label="' + esc(publishText.changedFiles) + '"><section class="panel preview-nav"><div class="panel-header"><span class="panel-title">' + esc(publishText.changedFiles) + '</span><span class="count">' + esc(files.length) + '</span></div><div class="preview-file-tree" role="region" tabindex="0" aria-label="' + esc(publishText.changedFiles) + '" title="' + esc(publishText.changedFiles) + '" data-tooltip="' + esc(publishText.changedFiles) + '"><div class="preview-file-tree__content">' + previewTreeHtml(nodes, '') + '</div></div></section><section class="panel preview-commits"><div class="panel-header"><span class="panel-title">' + esc(publishText.commits) + '</span><span class="count">' + esc(commits.length) + '</span></div><div class="commit-list">' + commits.slice(0, 6).map(commitRow).join('') + '</div></section></aside>';
    }
    /** 파일 수가 신뢰 가능한 정수인지 확인해 0을 포함한 정확한 줄 수만 표시한다. */
    function previewLineCount(value) { return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null; }
    /** 파일 leaf의 경로와 줄 수를 보조 기술과 tooltip에 함께 제공한다. */
    function previewFileDescription(file, additions, deletions) {
      const path = file.oldPath ? file.oldPath + ' → ' + file.path : file.path;
      const counts = additions === null || deletions === null
        ? publishText.lineCountsUnavailable
        : publishText.additions + ': +' + additions + ', ' + publishText.deletions + ': -' + deletions;
      return template(publishText.showFile, path) + '. ' + counts;
    }
    /** 재귀 folder tree를 button만으로 구성해 키보드와 긴 path에서도 안전하게 유지한다. */
    function previewTreeHtml(nodes, parent) {
      return Object.entries(nodes).map(([name, value]) => {
        if (value && typeof value.path === 'string') {
          const additions = previewLineCount(value.additions);
          const deletions = previewLineCount(value.deletions);
          const description = previewFileDescription(value, additions, deletions);
          return '<button class="preview-tree-file" type="button" data-preview-file="' + esc(value.path) + '" title="' + esc(description) + '" aria-label="' + esc(description) + '" data-tooltip="' + esc(description) + '"><span class="codicon codicon-file" aria-hidden="true"></span><span class="preview-tree-file__name">' + esc(name) + '</span><span class="preview-tree-file__stats" aria-hidden="true"><span class="preview-tree-file__add">+' + esc(additions === null ? '?' : additions) + '</span><span class="preview-tree-file__del">-' + esc(deletions === null ? '?' : deletions) + '</span></span></button>';
        }
        return '<details class="preview-tree-folder" open><summary title="' + esc(name) + '" aria-label="' + esc(name) + '" data-tooltip="' + esc(name) + '"><span class="codicon codicon-folder" aria-hidden="true"></span>' + esc(name) + '</summary><div>' + previewTreeHtml(value, parent + name + '/') + '</div></details>';
      }).join('');
    }
    /** Conversation 탐색과 preview-only Viewed toggle을 묶어 host message를 추가하지 않는다. */
    function bindConversationNavigation() {
      content.querySelectorAll('[data-preview-file]').forEach((button) => button.addEventListener('click', () => {
        const path = button.dataset.previewFile || '';
        activeTab = 'files'; persistDisplayState();
        if (latestPreview) render(latestPreview);
        requestAnimationFrame(() => content.querySelector('[data-review-path="' + CSS.escape(path) + '"]')?.scrollIntoView({ block: 'start' }));
      }));
      content.querySelectorAll('[data-toggle-local-viewed]').forEach((button) => button.addEventListener('click', () => {
        const key = button.dataset.toggleLocalViewed || '';
        if (localViewed.has(key)) localViewed.delete(key); else localViewed.add(key);
        persistDisplayState(); if (latestPreview) render(latestPreview);
      }));
    }
    /** Conversation 전용 splitter를 연결하고 마지막 유효 폭을 display state에 기록한다. */
    function bindConversationRail() {
      conversationRailSplitter?.dispose();
      conversationRailSplitter = null;
      const layout = content.querySelector('.preview-conversation-layout');
      const handle = content.querySelector('.preview-inspector-splitter');
      if (!layout || !handle || !window.__gscSplitter) return;
      conversationRailSplitter = window.__gscSplitter.createSplitter({
        handle,
        min: inspectorWidthMin,
        max: inspectorWidthMax,
        step: 20,
        value: inspectorWidth,
        direction: -1,
        onChange: (width) => {
          inspectorWidth = width;
          layout.style.setProperty('--preview-inspector-width', width + 'px');
          persistDisplayState();
        },
      });
    }
    /** repository/source/target/path로 한정한 local UI key를 만든다. */
    function localViewedKey(file) { return JSON.stringify([latestPreview?.repository || '', latestPreview?.sourceBranch || '', latestPreview?.targetBranch || '', file.path || '']); }
    /** 서버 동기화가 아닌 local UI 상태임을 명확히 보여 주는 파일 action을 만든다. */
    function localViewedButton(file) { const key = localViewedKey(file); const viewed = localViewed.has(key); const label = viewed ? publishText.markUnviewedLocal : publishText.markViewedLocal; return '<button class="file-viewed-button' + (viewed ? ' active' : '') + '" type="button" data-toggle-local-viewed="' + esc(key) + '" aria-pressed="' + viewed + '" title="' + esc(label) + '" aria-label="' + esc(label) + '" data-tooltip="' + esc(label) + '"><span class="codicon codicon-check" aria-hidden="true"></span>' + esc(viewed ? publishText.viewedLocal : publishText.unviewedLocal) + '</button>'; }
  `;
}
