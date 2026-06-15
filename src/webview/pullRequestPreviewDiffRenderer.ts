// PR preview Files changed 탭의 diff snippet 렌더러.
// - 웹뷰 패널 본문이 커지지 않도록 GitHub 스타일 diff 파싱/강조 스크립트를 분리한다.

/**
 * PR preview 웹뷰 안에서 실행할 diff 렌더링 helper 스크립트를 반환한다.
 * @returns old/new line number, marker, code 컬럼과 간단한 구문 강조를 만드는 클라이언트 스크립트
 */
export function pullRequestPreviewDiffScript(): string {
  return `
    function patchHtml(patch, compact, filePath, comments) {
      return renderGithubDiff(patch, compact ? 60 : 220, filePath, compact ? ' mini-diff' : '', comments || []);
    }
    function splitPatchHtml(patch, filePath, comments) {
      return renderGithubDiff(patch, 360, filePath, ' continuous-diff', comments || []);
    }
    function renderGithubDiff(patch, limit, filePath, extraClass, comments) {
      if (!patch) return '<p class="empty">Diff snippet is unavailable for this file.</p>';
      const rows = diffRows(String(patch), limit, filePath, comments);
      const omitted = rows.omitted ? diffOmittedRow(rows.omitted) : '';
      const unmatched = rows.unmatched.length ? inlineCommentsHtml(rows.unmatched, 'review') : '';
      return '<div class="diff-snippet github-diff' + extraClass + '">' + rows.html + omitted + unmatched + '</div>';
    }
    function diffRows(patch, limit, filePath, comments) {
      let oldLine = 0;
      let newLine = 0;
      let shown = 0;
      let html = '';
      const language = languageForPath(filePath);
      const commentState = buildCommentState(comments || []);
      const lines = patch.split('\\n');
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (index === lines.length - 1 && line === '') continue;
        if (isPatchHeaderLine(line)) continue;
        const hunk = /^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@(.*)$/.exec(line);
        if (hunk) {
          oldLine = Number(hunk[1]);
          newLine = Number(hunk[2]);
          html += diffRowHtml('hunk', '', '', '@@', esc(line));
          continue;
        }
        if (line.startsWith('\\\\ No newline')) {
          html += diffRowHtml('meta', '', '', '', esc(line));
          continue;
        }
        if (shown >= limit) {
          return { html, omitted: patch.split('\\n').length - shown, unmatched: remainingComments(commentState) };
        }
        if (line.startsWith('+')) {
          html += codeRowHtml('add', '', newLine, '+', line.slice(1), language);
          html += lineCommentsHtml(commentState, '', newLine);
          newLine++;
        } else if (line.startsWith('-')) {
          html += codeRowHtml('del', oldLine, '', '-', line.slice(1), language);
          html += lineCommentsHtml(commentState, oldLine, '');
          oldLine++;
        } else {
          const code = line.startsWith(' ') ? line.slice(1) : line;
          html += codeRowHtml('ctx', oldLine, newLine, '', code, language);
          html += lineCommentsHtml(commentState, oldLine, newLine);
          oldLine++;
          newLine++;
        }
        shown++;
      }
      return { html, omitted: 0, unmatched: remainingComments(commentState) };
    }
    function codeRowHtml(kind, oldNo, newNo, marker, code, language) {
      return diffRowHtml(kind, oldNo, newNo, marker, highlightCode(code || ' ', language));
    }
    function diffRowHtml(kind, oldNo, newNo, marker, codeHtml) {
      return '<div class="diff-row ' + kind + '"><span class="diff-line-no old">' + esc(oldNo) + '</span><span class="diff-line-no new">' + esc(newNo) + '</span><span class="diff-marker">' + esc(marker) + '</span><span class="diff-code">' + codeHtml + '</span></div>';
    }
    function diffOmittedRow(count) {
      return '<div class="diff-row omitted"><span class="diff-line-no old"></span><span class="diff-line-no new"></span><span class="diff-marker">...</span><span class="diff-code">' + esc(count) + ' lines truncated</span></div>';
    }
    function buildCommentState(comments) {
      const byKey = new Map();
      const used = new Set();
      (comments || []).forEach((comment, index) => {
        for (const key of commentKeys(comment)) {
          const list = byKey.get(key) || [];
          list.push({ index, comment });
          byKey.set(key, list);
        }
      });
      return { byKey, used, comments: comments || [] };
    }
    function commentKeys(comment) {
      const side = String(comment.side || '').toUpperCase();
      const keys = [];
      if (side === 'LEFT') {
        if (comment.originalLine) keys.push('old:' + comment.originalLine);
        if (comment.line) keys.push('old:' + comment.line);
        return keys;
      }
      if (comment.line) keys.push('new:' + comment.line);
      if (comment.originalLine) keys.push(side === 'RIGHT' ? 'new:' + comment.originalLine : 'old:' + comment.originalLine);
      return keys;
    }
    function lineCommentsHtml(state, oldNo, newNo) {
      const items = [];
      if (oldNo) items.push(...(state.byKey.get('old:' + oldNo) || []));
      if (newNo) items.push(...(state.byKey.get('new:' + newNo) || []));
      const unique = items.filter((item) => !state.used.has(item.index));
      unique.forEach((item) => state.used.add(item.index));
      return unique.length ? inlineCommentsHtml(unique.map((item) => item.comment), newNo || oldNo) : '';
    }
    function remainingComments(state) {
      return state.comments.filter((_, index) => !state.used.has(index));
    }
    function inlineCommentsHtml(comments, label) {
      return '<div class="diff-comment-row"><span class="diff-line-no old"></span><span class="diff-line-no new"></span><span class="diff-marker"><span class="codicon codicon-comment-discussion" aria-hidden="true"></span></span><div class="diff-inline-comments">' +
        comments.map((comment) => inlineCommentHtml(comment, label)).join('') + '</div></div>';
    }
    function inlineCommentHtml(comment, fallbackLabel) {
      const line = comment.line || comment.originalLine || fallbackLabel;
      const where = line ? 'line ' + line : 'review';
      return '<article class="diff-inline-comment"><div class="comment-meta"><span class="codicon codicon-comment-discussion" aria-hidden="true"></span><strong>' +
        esc(comment.author || 'unknown') + '</strong><span>' + esc(where) + '</span>' +
        (comment.createdAt ? '<span>' + esc(formatDate(comment.createdAt)) + '</span>' : '') + '</div>' +
        '<div class="comment-body markdown-body">' + renderMarkdown(comment.body || '') + '</div></article>';
    }
    function isPatchHeaderLine(line) {
      return /^(diff --git |index |--- |\\+\\+\\+ |new file mode |deleted file mode |similarity index |rename from |rename to )/.test(line);
    }
    function languageForPath(filePath) {
      const ext = String(filePath || '').split('.').pop().toLowerCase();
      if (/^(js|jsx|ts|tsx|mjs|cjs)$/.test(ext)) return 'js';
      if (/^(html|htm|xml|vue|svelte|svg)$/.test(ext)) return 'markup';
      if (/^(css|scss|sass|less)$/.test(ext)) return 'css';
      if (/^(json|jsonc)$/.test(ext)) return 'json';
      if (/^(py|rb|sh|bash|zsh|yml|yaml)$/.test(ext)) return 'hash';
      return 'plain';
    }
    function highlightCode(code, language) {
      if (language === 'plain') return esc(code);
      if (language === 'markup') return highlightMarkup(code);
      if (language === 'css') return highlightCss(code);
      if (language === 'json') return highlightJson(code);
      return highlightGeneric(code, language === 'hash');
    }
    function highlightGeneric(code, hashComment) {
      const stashed = stashTokens(esc(code), [
        [/(&quot;(?:\\\\.|[^&])*?&quot;|'(?:\\\\.|[^'])*'|\\\`(?:\\\\.|[^\\\`])*\\\`)/g, 'str'],
        [hashComment ? /(#.*$)/g : /(\\/\\/.*$|\\/\\*[\\s\\S]*?\\*\\/)/g, 'comment'],
      ]);
      let out = stashed.text;
      out = out.replace(/\\b(await|break|case|catch|class|const|continue|def|else|export|extends|finally|for|from|function|if|import|in|interface|let|new|return|throw|try|type|var|while|yield|async|public|private|protected|static|readonly)\\b/g, '<span class="tok-keyword">$1</span>');
      return stashed.restore(out.replace(/\\b(\\d+(?:\\.\\d+)?)\\b/g, '<span class="tok-number">$1</span>'));
    }
    function highlightJson(code) {
      const stashed = stashTokens(esc(code), [[/(&quot;(?:\\\\.|[^&])*?&quot;)(?=\\s*:)?/g, 'str']]);
      let out = stashed.text.replace(/\\b(true|false|null)\\b/g, '<span class="tok-keyword">$1</span>');
      return stashed.restore(out.replace(/\\b(\\d+(?:\\.\\d+)?)\\b/g, '<span class="tok-number">$1</span>'));
    }
    function highlightMarkup(code) {
      const stashed = stashTokens(esc(code), [[/(&lt;!--[\\s\\S]*?--&gt;)/g, 'comment'], [/(&quot;(?:\\\\.|[^&])*?&quot;|'(?:\\\\.|[^'])*')/g, 'str']]);
      let out = stashed.text;
      out = out.replace(/(&lt;\\/?)([A-Za-z][\\w:-]*)/g, '$1<span class="tok-tag">$2</span>');
      return stashed.restore(out.replace(/(\\s)([A-Za-z_:][\\w:.-]*)(=)/g, '$1<span class="tok-attr">$2</span>$3'));
    }
    function highlightCss(code) {
      const stashed = stashTokens(esc(code), [[/(\\/\\*[\\s\\S]*?\\*\\/)/g, 'comment'], [/(&quot;(?:\\\\.|[^&])*?&quot;|'(?:\\\\.|[^'])*')/g, 'str']]);
      let out = stashed.text;
      out = out.replace(/([\\w-]+)(\\s*:)/g, '<span class="tok-attr">$1</span>$2');
      return stashed.restore(out.replace(/(#[0-9a-fA-F]{3,8}|\\b\\d+(?:\\.\\d+)?(?:px|rem|em|%|vh|vw)?\\b)/g, '<span class="tok-number">$1</span>'));
    }
    function stashTokens(text, rules) {
      const tokens = [];
      let out = text;
      for (const rule of rules) {
        out = out.replace(rule[0], (match) => {
          const key = '\\u0000TOKEN' + tokens.length + 'END\\u0000';
          tokens.push('<span class="tok-' + rule[1] + '">' + match + '</span>');
          return key;
        });
      }
      return { text: out, restore: (value) => value.replace(/\\u0000TOKEN(\\d+)END\\u0000/g, (_, index) => tokens[Number(index)] || '') };
    }
  `;
}
