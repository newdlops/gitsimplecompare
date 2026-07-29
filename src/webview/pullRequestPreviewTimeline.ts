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
      return '<div class="preview-conversation-layout"><div class="preview-conversation-main"><section class="panel preview-opening"><div class="panel-header"><span class="panel-title"><span class="codicon codicon-comment-discussion" aria-hidden="true"></span>' + esc(publishText.conversation) + '</span></div>' + composerHtml(preview) + '</section><section class="preview-timeline" aria-label="' + esc(publishText.conversation) + '">' + items.map(conversationItemHtml).join('') + '</section></div>' + previewInspectorHtml(files, commits) + '</div>';
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
      return '<aside class="preview-inspector" aria-label="' + esc(publishText.changedFiles) + '"><section class="panel preview-nav"><div class="panel-header"><span class="panel-title">' + esc(publishText.changedFiles) + '</span><span class="count">' + esc(files.length) + '</span></div><div class="preview-file-tree">' + previewTreeHtml(nodes, '') + '</div></section><section class="panel preview-commits"><div class="panel-header"><span class="panel-title">' + esc(publishText.commits) + '</span><span class="count">' + esc(commits.length) + '</span></div><div class="commit-list">' + commits.slice(0, 6).map(commitRow).join('') + '</div></section></aside>';
    }
    /** 재귀 folder tree를 button만으로 구성해 키보드와 긴 path에서도 안전하게 유지한다. */
    function previewTreeHtml(nodes, parent) {
      return Object.entries(nodes).map(([name, value]) => {
        if (value && typeof value.path === 'string') return '<button class="preview-tree-file" type="button" data-preview-file="' + esc(value.path) + '" title="' + esc(template(publishText.showFile, value.path)) + '" aria-label="' + esc(template(publishText.showFile, value.path)) + '" data-tooltip="' + esc(template(publishText.showFile, value.path)) + '"><span class="codicon codicon-file" aria-hidden="true"></span>' + esc(name) + '</button>';
        return '<details class="preview-tree-folder" open><summary title="' + esc(name) + '"><span class="codicon codicon-folder" aria-hidden="true"></span>' + esc(name) + '</summary><div>' + previewTreeHtml(value, parent + name + '/') + '</div></details>';
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
    /** repository/source/target/path로 한정한 local UI key를 만든다. */
    function localViewedKey(file) { return JSON.stringify([latestPreview?.repository || '', latestPreview?.sourceBranch || '', latestPreview?.targetBranch || '', file.path || '']); }
    /** 서버 동기화가 아닌 local UI 상태임을 명확히 보여 주는 파일 action을 만든다. */
    function localViewedButton(file) { const key = localViewedKey(file); const viewed = localViewed.has(key); const label = viewed ? publishText.markUnviewedLocal : publishText.markViewedLocal; return '<button class="file-viewed-button' + (viewed ? ' active' : '') + '" type="button" data-toggle-local-viewed="' + esc(key) + '" aria-pressed="' + viewed + '" title="' + esc(label) + '" aria-label="' + esc(label) + '" data-tooltip="' + esc(label) + '"><span class="codicon codicon-check" aria-hidden="true"></span>' + esc(viewed ? publishText.viewedLocal : publishText.unviewedLocal) + '</button>'; }
  `;
}
