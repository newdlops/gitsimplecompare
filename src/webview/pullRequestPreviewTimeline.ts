// PR preview Conversation 탭의 timeline 렌더러.
// - GitHub Conversation 탭처럼 review/event/inline comment 를 구분해 표시한다.

/**
 * PR preview 웹뷰 안에서 실행할 conversation timeline helper 스크립트를 반환한다.
 * @returns timeline item HTML 렌더링 함수 스크립트
 */
export function pullRequestPreviewTimelineScript(): string {
  return `
    function timelineItem(item) {
      const action = conversationAction(item);
      return '<article class="timeline-item ' + esc(item.kind || 'comment') + '">' +
        '<span class="avatar">' + esc(initial(item.author)) + '</span><div class="timeline-card">' +
        '<div class="timeline-head"><span class="codicon codicon-' + conversationIcon(item) + '" aria-hidden="true"></span><strong>' +
        esc(item.author || 'unknown') + '</strong><span>' + esc(action) + '</span>' +
        (item.createdAt ? '<span>' + esc(formatDate(item.createdAt)) + '</span>' : '') +
        conversationContext(item) + '</div>' +
        conversationBody(item) + '</div></article>';
    }
    function conversationAction(item) {
      if (item.action) return item.action;
      if (item.kind === 'body') return 'opened this pull request';
      if (item.kind === 'review_comment') return 'commented on a file';
      if (item.kind === 'review') return item.state ? 'reviewed: ' + item.state.toLowerCase().replace(/_/g, ' ') : 'reviewed';
      if (item.kind === 'commit') return 'pushed a commit';
      return 'commented';
    }
    function conversationIcon(item) {
      if (item.kind === 'review_comment') return 'comment-discussion';
      if (item.kind === 'review') return item.state === 'APPROVED' ? 'pass' : item.state === 'CHANGES_REQUESTED' ? 'request-changes' : 'eye';
      if (item.kind === 'commit') return 'git-commit';
      if (item.kind === 'event') return 'history';
      return 'comment-discussion';
    }
    function conversationContext(item) {
      const parts = [];
      if (item.path) parts.push('<code>' + esc(item.path) + (item.line ? ':' + esc(item.line) : '') + '</code>');
      if (item.commitId) parts.push('<code>' + esc(shortConversationHash(item.commitId)) + '</code>');
      return parts.length ? '<span class="timeline-context">' + parts.join('') + '</span>' : '';
    }
    function conversationBody(item) {
      if (!item.body) return item.kind === 'body' ? '<div class="timeline-body muted">No description provided.</div>' : '';
      return '<div class="markdown-body timeline-body">' + renderMarkdown(item.body || '') + '</div>';
    }
    function shortConversationHash(hash) { return String(hash || '').slice(0, 8); }
  `;
}
