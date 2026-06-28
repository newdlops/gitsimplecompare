// PR preview 웹뷰에서 사용할 안전한 markdown/html block 렌더러 스크립트.
// - 외부 CDN 없이 기본 markdown 을 HTML 로 바꾸고, 허용 태그/속성만 남겨 웹뷰 주입 위험을 줄인다.

/**
 * PR preview 클라이언트에 주입할 markdown 렌더링 함수들을 반환한다.
 * @returns 웹뷰 script 태그 안에 들어갈 JavaScript 코드 문자열
 */
export function pullRequestPreviewMarkdownScript(): string {
  return `
    function renderReviewCommentMarkdown(comment) {
      const body = String(comment?.body || comment?.bodyText || '').replace(/\\r\\n/g, '\\n');
      const label = reviewCommentRangeLabel(comment);
      const segments = splitCommentFences(body);
      const parts = [];
      let hasSuggestion = false;
      segments.forEach((segment) => {
        if (segment.kind === 'suggestion') {
          hasSuggestion = true;
          parts.push(suggestedChangeHtml(segment.value, label));
        } else if (segment.kind === 'code') {
          parts.push(codeBlockHtml(segment.value));
        } else if (String(segment.value || '').trim()) {
          parts.push(renderMarkdown(segment.value));
        }
      });
      if (!hasSuggestion) {
        suggestionsFromCommentHtml(comment?.bodyHtml).forEach((suggestion) => {
          parts.push(suggestedChangeHtml(suggestion, label));
        });
      }
      return parts.length ? parts.join('') : renderMarkdown(body);
    }
    function renderMarkdown(value) {
      const source = String(value || '').replace(/\\r\\n/g, '\\n');
      if (!source.trim()) return '<p class="empty">No content.</p>';
      const blocks = [];
      let html = source.replace(/\`\`\`[^\\n]*\\n?([\\s\\S]*?)\`\`\`/g, (_, body) => {
        const token = '@@CODE' + blocks.length + '@@';
        blocks.push('<pre><code>' + esc(String(body || '').replace(/\\n$/, '')) + '</code></pre>');
        return token;
      });
      html = html.split(/\\n{2,}/).map(markdownBlock).join('');
      html = html.replace(/@@CODE(\\d+)@@/g, (_, index) => blocks[Number(index)] || '');
      return sanitizeHtml(html);
    }
    function markdownBlock(block) {
      const text = String(block || '').trim();
      if (!text) return '';
      if (/^</.test(text)) return text;
      const heading = /^(#{1,6})\\s+(.+)$/.exec(text);
      if (heading) return '<h' + heading[1].length + '>' + inlineMarkdown(heading[2]) + '</h' + heading[1].length + '>';
      if (/^>\\s?/m.test(text)) return '<blockquote>' + inlineMarkdown(text.replace(/^>\\s?/gm, '')).replace(/\\n/g, '<br>') + '</blockquote>';
      if (/^[-*]\\s+/m.test(text)) return '<ul>' + text.split('\\n').map((line) => '<li>' + inlineMarkdown(line.replace(/^[-*]\\s+/, '')) + '</li>').join('') + '</ul>';
      if (/^\\d+\\.\\s+/m.test(text)) return '<ol>' + text.split('\\n').map((line) => '<li>' + inlineMarkdown(line.replace(/^\\d+\\.\\s+/, '')) + '</li>').join('') + '</ol>';
      return '<p>' + inlineMarkdown(text).replace(/\\n/g, '<br>') + '</p>';
    }
    function inlineMarkdown(text) {
      return esc(text)
        .replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>')
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        .replace(/__([^_]+)__/g, '<strong>$1</strong>')
        .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
        .replace(/_([^_]+)_/g, '<em>$1</em>')
        .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+|mailto:[^)\\s]+)\\)/g, '<a href="$2">$1</a>');
    }
    function sanitizeHtml(html) {
      const allowed = new Set('a,p,br,strong,b,em,i,code,pre,blockquote,ul,ol,li,details,summary,table,thead,tbody,tr,th,td,h1,h2,h3,h4,h5,h6,hr,del,sub,sup,kbd'.split(','));
      const template = document.createElement('template');
      template.innerHTML = html;
      template.content.querySelectorAll('*').forEach((el) => {
        const tag = el.tagName.toLowerCase();
        if (!allowed.has(tag)) { el.replaceWith(document.createTextNode(el.textContent || '')); return; }
        Array.from(el.attributes).forEach((attr) => {
          const name = attr.name.toLowerCase();
          const value = attr.value || '';
          if (tag === 'a' && name === 'href' && /^(https?:|mailto:)/.test(value)) {
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noreferrer');
          } else if (!((tag === 'td' || tag === 'th') && (name === 'colspan' || name === 'rowspan'))) {
            el.removeAttribute(attr.name);
          }
        });
      });
      return template.innerHTML;
    }
    function splitCommentFences(body) {
      const lines = splitLinesKeepingEndings(body);
      const segments = [];
      let markdown = '';
      for (let index = 0; index < lines.length; index++) {
        const opening = parseOpeningFence(lines[index]);
        if (!opening) {
          markdown += lines[index];
          continue;
        }
        if (markdown) {
          segments.push({ kind: 'markdown', value: markdown });
          markdown = '';
        }
        const closingIndex = findClosingFence(lines, index + 1, opening);
        const end = closingIndex >= 0 ? closingIndex : lines.length;
        const info = String(opening.info || '').trim();
        const kind = /^suggestion\\b/i.test(info) ? 'suggestion' : 'code';
        segments.push({
          kind,
          value: stripTrailingLineBreaks(lines.slice(index + 1, end).join('')),
        });
        index = closingIndex >= 0 ? closingIndex : lines.length;
      }
      if (markdown) segments.push({ kind: 'markdown', value: markdown });
      return segments.length ? segments : [{ kind: 'markdown', value: body }];
    }
    function splitLinesKeepingEndings(value) {
      return String(value || '').match(/[^\\r\\n]*(?:\\r\\n|\\n|\\r|$)/g)?.filter(Boolean) || [];
    }
    function parseOpeningFence(line) {
      const value = withoutTrailingLineBreak(line).trimStart();
      const fence = parseFenceRun(value);
      if (!fence) return undefined;
      return Object.assign({}, fence, { info: value.slice(fence.length).trim() });
    }
    function findClosingFence(lines, start, opening) {
      for (let index = start; index < lines.length; index++) {
        const closing = parseClosingFence(lines[index]);
        if (closing && closing.char === opening.char && closing.length >= opening.length) return index;
      }
      return -1;
    }
    function parseClosingFence(line) {
      const value = withoutTrailingLineBreak(line).trim();
      const fence = parseFenceRun(value);
      if (!fence || value.slice(fence.length).trim()) return undefined;
      return fence;
    }
    function parseFenceRun(value) {
      const char = String(value || '').charAt(0);
      if (char !== '\`' && char !== '~') return undefined;
      let length = 0;
      while (value.charAt(length) === char) length++;
      return length >= 3 ? { char, length } : undefined;
    }
    function withoutTrailingLineBreak(value) {
      return String(value || '').replace(/(?:\\r?\\n|\\r)$/g, '');
    }
    function stripTrailingLineBreaks(value) {
      return String(value || '').replace(/(?:\\r?\\n|\\r)+$/g, '');
    }
    function suggestedChangeHtml(value, label) {
      const title = 'Suggested changeset' + (label ? ' · ' + label : '');
      const code = stripTrailingLineBreaks(value) || 'Delete selected lines';
      return '<div class="suggested-change"><p><strong>' + esc(title) + '</strong></p><pre><code>' + esc(code) + '</code></pre></div>';
    }
    function codeBlockHtml(value) {
      return '<pre><code>' + esc(stripTrailingLineBreaks(value)) + '</code></pre>';
    }
    function suggestionsFromCommentHtml(bodyHtml) {
      if (!bodyHtml) return [];
      const html = String(bodyHtml || '');
      const template = document.createElement('template');
      template.innerHTML = html;
      const text = template.content.textContent || '';
      const hasSuggestionHint = /suggest(?:ed)?\\s+changeset|suggest(?:ed)?\\s+change/i.test(text) ||
        /suggest(?:ed)?[-_ ]?changeset|suggest(?:ed)?[-_ ]?change|js-suggest/i.test(html);
      if (!hasSuggestionHint) return [];
      const values = [];
      template.content.querySelectorAll('pre code').forEach((node) => values.push(node.textContent || ''));
      if (!values.length) {
        template.content.querySelectorAll('pre').forEach((node) => values.push(node.textContent || ''));
      }
      template.content.querySelectorAll('table').forEach((table) => {
        const lines = blobCodeLines(table);
        if (lines.length) values.push(lines.join('\\n'));
      });
      if (!values.length) {
        const lines = blobCodeLines(template.content);
        if (lines.length) values.push(lines.join('\\n'));
      }
      return uniqueStrings(values.map(stripTrailingLineBreaks).filter(Boolean));
    }
    function blobCodeLines(root) {
      const added = Array.from(root.querySelectorAll('.blob-code-addition'));
      const cells = added.length
        ? added
        : Array.from(root.querySelectorAll('.blob-code')).filter((cell) => !cell.classList.contains('blob-code-deletion'));
      return cells
        .map((cell) => ({ text: cell.textContent || '', empty: cellIsEmptyCode(cell) }))
        .filter((line) => line.text || line.empty)
        .map((line) => line.text);
    }
    function cellIsEmptyCode(cell) {
      return cell.classList.contains('blob-code-empty');
    }
    function uniqueStrings(values) {
      const seen = new Set();
      return values.filter((value) => {
        if (seen.has(value)) return false;
        seen.add(value);
        return true;
      });
    }
    function reviewCommentRangeLabel(comment) {
      const range = reviewCommentRange(comment || {});
      if (!range) return '';
      return range.start === range.end ? 'line ' + range.end : 'lines ' + range.start + '-' + range.end;
    }
    function reviewCommentRange(comment) {
      const side = String(comment.side || comment.startSide || '').toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
      const end = side === 'LEFT'
        ? numberLine(comment.originalLine) || numberLine(comment.line)
        : numberLine(comment.line) || numberLine(comment.originalLine);
      if (!end) return undefined;
      const start = side === 'LEFT'
        ? numberLine(comment.originalStartLine) || numberLine(comment.startLine) || end
        : numberLine(comment.startLine) || numberLine(comment.originalStartLine) || end;
      return { start: Math.min(start, end), end: Math.max(start, end) };
    }
    function numberLine(value) {
      const line = Number(value);
      return Number.isFinite(line) && line > 0 ? line : undefined;
    }
  `;
}
