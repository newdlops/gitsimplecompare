// PR preview Files changed 탭의 diff snippet 렌더러.
// - 웹뷰 패널 본문이 커지지 않도록 GitHub 스타일 diff 파싱/강조 스크립트를 분리한다.

/**
 * PR preview 웹뷰 안에서 실행할 diff 렌더링 helper 스크립트를 반환한다.
 * @returns old/new line number, marker, code 컬럼과 간단한 구문 강조를 만드는 클라이언트 스크립트
 */
export function pullRequestPreviewDiffScript(): string {
  return `
    function patchHtml(patch, compact, filePath, comments, layout) {
      return renderGithubDiff(patch, compact ? 60 : 220, filePath, compact ? ' mini-diff' : '', comments || [], layout || 'unified');
    }
    function splitPatchHtml(patch, filePath, comments, layout) {
      return renderGithubDiff(patch, 360, filePath, ' continuous-diff', comments || [], layout || 'unified');
    }
    function renderGithubDiff(patch, limit, filePath, extraClass, comments, layout) {
      if (!patch) return '<p class="empty">Diff snippet is unavailable for this file.</p>';
      const rows = layout === 'split'
        ? splitDiffRows(String(patch), limit, filePath, comments)
        : diffRows(String(patch), limit, filePath, comments);
      const omitted = rows.omitted ? diffOmittedRow(rows.omitted) : '';
      const unmatched = rows.unmatched.length ? inlineCommentsHtml(rows.unmatched, 'review') : '';
      const layoutClass = layout === 'split' ? ' split-diff' : ' unified-diff';
      return '<div class="diff-snippet github-diff' + extraClass + layoutClass + '">' + rows.html + omitted + unmatched + '</div>';
    }
    function diffRows(patch, limit, filePath, comments) {
      let oldLine = 0;
      let newLine = 0;
      let shown = 0;
      let html = '';
      const language = languageForPath(filePath);
      const commentState = buildCommentState(comments || []);
      const entries = compactPatchEntries(patch, filePath);
      for (let index = 0; index < entries.length; index++) {
        if (entries[index].expanded) {
          html += diffContextRow(entries[index].expanded, entries[index].key, true);
          continue;
        }
        if (entries[index].omitted) {
          html += diffContextRow(entries[index].omitted, entries[index].key, false, entries[index].step, entries[index].collapsible);
          oldLine += entries[index].omitted;
          newLine += entries[index].omitted;
          continue;
        }
        const line = entries[index].line;
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
          return { html, omitted: remainingEntryLines(entries, index), unmatched: remainingComments(commentState) };
        }
        if (line.startsWith('-')) {
          const removed = [];
          while (index < entries.length && entries[index].line?.startsWith('-')) {
            removed.push({ no: oldLine, code: entries[index].line.slice(1) });
            oldLine++;
            index++;
          }
          const added = [];
          while (index < entries.length && entries[index].line?.startsWith('+')) {
            added.push({ no: newLine, code: entries[index].line.slice(1) });
            newLine++;
            index++;
          }
          index--;
          const fragments = pairedInlineFragments(removed, added, language);
          const paired = Math.max(removed.length, added.length);
          for (let i = 0; i < paired; i++) {
            if (shown >= limit) return { html, omitted: remainingEntryLines(entries, index), unmatched: remainingComments(commentState) };
            if (removed[i]) {
              html += codeRowHtml('del', removed[i].no, '', '-', removed[i].code, language, fragments[i]?.old);
              html += lineCommentsHtml(commentState, removed[i].no, '');
              shown++;
            }
            if (added[i]) {
              if (shown >= limit) return { html, omitted: remainingEntryLines(entries, index), unmatched: remainingComments(commentState) };
              html += codeRowHtml('add', '', added[i].no, '+', added[i].code, language, fragments[i]?.new);
              html += lineCommentsHtml(commentState, '', added[i].no);
              shown++;
            }
          }
          continue;
        }
        if (line.startsWith('+')) {
          html += codeRowHtml('add', '', newLine, '+', line.slice(1), language);
          html += lineCommentsHtml(commentState, '', newLine);
          newLine++;
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
    function splitDiffRows(patch, limit, filePath, comments) {
      let oldLine = 0;
      let newLine = 0;
      let shown = 0;
      let html = '';
      const language = languageForPath(filePath);
      const commentState = buildCommentState(comments || []);
      const entries = compactPatchEntries(patch, filePath);
      for (let index = 0; index < entries.length; index++) {
        if (entries[index].expanded) {
          html += diffContextRow(entries[index].expanded, entries[index].key, true);
          continue;
        }
        if (entries[index].omitted) {
          html += diffContextRow(entries[index].omitted, entries[index].key, false, entries[index].step, entries[index].collapsible);
          oldLine += entries[index].omitted;
          newLine += entries[index].omitted;
          continue;
        }
        const line = entries[index].line;
        const hunk = /^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@(.*)$/.exec(line);
        if (hunk) {
          oldLine = Number(hunk[1]);
          newLine = Number(hunk[2]);
          html += splitMetaRowHtml('hunk', '@@', esc(line));
          continue;
        }
        if (line.startsWith('\\\\ No newline')) {
          html += splitMetaRowHtml('meta', '', esc(line));
          continue;
        }
        if (shown >= limit) {
          return { html, omitted: remainingEntryLines(entries, index), unmatched: remainingComments(commentState) };
        }
        if (line.startsWith('-')) {
          const removed = [];
          while (index < entries.length && entries[index].line?.startsWith('-')) {
            removed.push({ kind: 'del', no: oldLine, marker: '-', code: entries[index].line.slice(1) });
            oldLine++;
            index++;
          }
          const added = [];
          while (index < entries.length && entries[index].line?.startsWith('+')) {
            added.push({ kind: 'add', no: newLine, marker: '+', code: entries[index].line.slice(1) });
            newLine++;
            index++;
          }
          index--;
          const paired = Math.max(removed.length, added.length);
          const fragments = pairedInlineFragments(removed, added, language);
          for (let i = 0; i < paired; i++) {
            if (shown >= limit) return { html, omitted: remainingEntryLines(entries, index), unmatched: remainingComments(commentState) };
            html += splitCodeRowHtml(removed[i], added[i], language, fragments[i]);
            html += lineCommentsHtml(commentState, removed[i]?.no || '', added[i]?.no || '');
            shown++;
          }
          continue;
        }
        if (line.startsWith('+')) {
          const added = { kind: 'add', no: newLine, marker: '+', code: line.slice(1) };
          html += splitCodeRowHtml(null, added, language);
          html += lineCommentsHtml(commentState, '', newLine);
          newLine++;
        } else {
          const code = line.startsWith(' ') ? line.slice(1) : line;
          const oldCell = { kind: 'ctx', no: oldLine, marker: '', code };
          const newCell = { kind: 'ctx', no: newLine, marker: '', code };
          html += splitCodeRowHtml(oldCell, newCell, language);
          html += lineCommentsHtml(commentState, oldLine, newLine);
          oldLine++;
          newLine++;
        }
        shown++;
      }
      return { html, omitted: 0, unmatched: remainingComments(commentState) };
    }
    function compactPatchEntries(patch, filePath) {
      const lines = String(patch || '').split('\\n');
      const entries = [];
      let hunkIndex = -1;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (index === lines.length - 1 && line === '') continue;
        if (isPatchHeaderLine(line)) continue;
        if (/^@@ -\\d+(?:,\\d+)? \\+\\d+(?:,\\d+)? @@/.test(line)) {
          hunkIndex++;
          entries.push({ line });
          const body = [];
          index++;
          while (index < lines.length && !/^@@ -\\d+(?:,\\d+)? \\+\\d+(?:,\\d+)? @@/.test(lines[index])) {
            if (index === lines.length - 1 && lines[index] === '') break;
            if (!isPatchHeaderLine(lines[index])) body.push(lines[index]);
            index++;
          }
          index--;
          entries.push(...compactHunkBody(body, filePath, hunkIndex));
          continue;
        }
        entries.push({ line });
      }
      return entries;
    }
    function compactHunkBody(lines, filePath, hunkIndex) {
      const out = [];
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!isContextLine(line)) {
          out.push({ line });
          continue;
        }
        const start = index;
        while (index < lines.length && isContextLine(lines[index])) index++;
        const run = lines.slice(start, index);
        index--;
        out.push(...compactContextRun(run, filePath, hunkIndex, start, start === 0, index === lines.length - 1));
      }
      return out;
    }
    function compactContextRun(lines, filePath, hunkIndex, start, atStart, atEnd) {
      const minCollapse = 7;
      const edge = 3;
      const expandStep = 20;
      const key = filePath + ':' + hunkIndex + ':' + start;
      if (lines.length < minCollapse) {
        return lines.map((line) => ({ line }));
      }
      const expanded = diffContextExpansion(key);
      if (atStart) {
        return contextRunWithHidden(lines, key, expandStep, 0, edge + expanded, "start", expanded);
      }
      if (atEnd) {
        return contextRunWithHidden(lines, key, expandStep, edge + expanded, 0, "end", expanded);
      }
      const left = edge + Math.ceil(expanded / 2);
      const right = edge + Math.floor(expanded / 2);
      return contextRunWithHidden(lines, key, expandStep, left, right, "middle", expanded);
    }
    function contextRunWithHidden(lines, key, step, leftCount, rightCount, position, expanded) {
      const left = Math.min(lines.length, Math.max(0, leftCount));
      const right = Math.min(Math.max(0, lines.length - left), Math.max(0, rightCount));
      const hidden = Math.max(0, lines.length - left - right);
      if (!hidden) {
        return [{ expanded: lines.length, key }, ...lines.map((line) => ({ line }))];
      }
      const head = position === 'start' ? [] : lines.slice(0, left).map((line) => ({ line }));
      const tail = position === 'end' ? [] : lines.slice(lines.length - right).map((line) => ({ line }));
      return [...head, { omitted: hidden, key, step, collapsible: expanded > 0 }, ...tail];
    }
    function isContextLine(line) {
      return !line.startsWith('+') && !line.startsWith('-') && !line.startsWith('\\\\ No newline');
    }
    function diffContextExpansion(key) {
      if (typeof expandedDiffContexts === 'undefined') return 0;
      if (typeof expandedDiffContexts.get === 'function') {
        return Number(expandedDiffContexts.get(key) || 0);
      }
      return expandedDiffContexts.has?.(key) ? Number.MAX_SAFE_INTEGER : 0;
    }
    function remainingEntryLines(entries, start) {
      return entries.slice(start).reduce((sum, entry) => sum + (entry.omitted || (entry.line && !/^@@ /.test(entry.line) && !entry.line.startsWith('\\\\ No newline') ? 1 : 0)), 0);
    }
    function codeRowHtml(kind, oldNo, newNo, marker, code, language, codeHtml) {
      return diffRowHtml(kind, oldNo, newNo, marker, codeHtml == null ? highlightCode(code || ' ', language) : codeHtml);
    }
    function diffRowHtml(kind, oldNo, newNo, marker, codeHtml) {
      return '<div class="diff-row ' + kind + '"><span class="diff-line-no old">' + esc(oldNo) + '</span><span class="diff-line-no new">' + esc(newNo) + '</span><span class="diff-marker">' + esc(marker) + '</span><span class="diff-code">' + codeHtml + '</span></div>';
    }
    function splitCodeRowHtml(oldCell, newCell, language, fragments) {
      const kind = oldCell && newCell ? (oldCell.kind === 'ctx' && newCell.kind === 'ctx' ? 'ctx' : 'change') : oldCell ? 'del' : 'add';
      return '<div class="diff-row split-row ' + kind + '">' +
        splitCellHtml('old', oldCell, language, fragments?.old) + splitCellHtml('new', newCell, language, fragments?.new) + '</div>';
    }
    function splitCellHtml(side, cell, language, codeHtml) {
      const kind = cell?.kind || 'empty';
      const code = cell ? (codeHtml == null ? highlightCode(cell.code || ' ', language) : codeHtml) : '';
      return '<span class="diff-line-no ' + side + ' ' + kind + '">' + esc(cell?.no || '') + '</span>' +
        '<span class="diff-marker ' + side + ' ' + kind + '">' + esc(cell?.marker || '') + '</span>' +
        '<span class="diff-code ' + side + ' ' + kind + '">' + code + '</span>';
    }
    function splitMetaRowHtml(kind, marker, codeHtml) {
      return '<div class="diff-row split-meta-row ' + kind + '"><span class="diff-line-no old"></span><span class="diff-line-no new"></span><span class="diff-marker">' + esc(marker) + '</span><span class="diff-code">' + codeHtml + '</span></div>';
    }
    function pairedInlineFragments(removed, added, language) {
      const count = Math.max(removed.length, added.length);
      const fragments = [];
      for (let index = 0; index < count; index++) {
        fragments.push(removed[index] && added[index] ? inlineDiffPair(removed[index].code, added[index].code, language) : undefined);
      }
      return fragments;
    }
    function inlineDiffPair(oldText, newText, language) {
      const oldChars = Array.from(String(oldText || ''));
      const newChars = Array.from(String(newText || ''));
      const min = Math.min(oldChars.length, newChars.length);
      let prefix = 0;
      while (prefix < min && oldChars[prefix] === newChars[prefix]) prefix++;
      let suffix = 0;
      while (suffix < min - prefix && oldChars[oldChars.length - 1 - suffix] === newChars[newChars.length - 1 - suffix]) suffix++;
      return {
        old: inlineDiffCode(oldChars, prefix, oldChars.length - suffix, language, 'del'),
        new: inlineDiffCode(newChars, prefix, newChars.length - suffix, language, 'add'),
      };
    }
    function inlineDiffCode(chars, start, end, language, kind) {
      const before = chars.slice(0, start).join('');
      const middle = chars.slice(start, end).join('');
      const after = chars.slice(end).join('');
      if (!middle) return highlightCode(chars.join('') || ' ', language);
      return highlightCode(before, language) + '<span class="diff-word ' + kind + '">' + highlightCode(middle || ' ', language) + '</span>' + highlightCode(after, language);
    }
    function diffOmittedRow(count) {
      return '<div class="diff-row omitted"><span class="diff-line-no old"></span><span class="diff-line-no new"></span><span class="diff-marker">...</span><span class="diff-code">' + esc(count) + ' lines truncated</span></div>';
    }
    function diffContextRow(count, key, expanded, step, collapsible) {
      if (expanded) {
        return '<div class="diff-row omitted context-fold"><span class="diff-line-no old"></span><span class="diff-line-no new"></span><span class="diff-marker">...</span><span class="diff-code">' + collapseContextButton(key, count) + '</span></div>';
      }
      const next = Math.min(count, step || 20);
      const title = 'Expand ' + count + ' unchanged lines';
      const expandButton = '<button type="button" class="diff-context-toggle" data-expand-context="' + esc(key) + '" data-expand-step="' + esc(next) + '" title="' + esc(title) + '" aria-label="' + esc(title) + '" data-tooltip="' + esc(title) + '">Show ' + esc(next) + ' more unchanged lines (' + esc(count) + ' hidden)</button>';
      const collapseButton = collapsible ? collapseContextButton(key, count) : '';
      return '<div class="diff-row omitted context-fold"><span class="diff-line-no old"></span><span class="diff-line-no new"></span><span class="diff-marker">...</span><span class="diff-code"><span class="diff-context-actions">' + expandButton + collapseButton + '</span></span></div>';
    }
    function collapseContextButton(key, count) {
      const title = 'Collapse ' + count + ' unchanged lines';
      return '<button type="button" class="diff-context-toggle" data-collapse-context="' + esc(key) + '" title="' + esc(title) + '" aria-label="' + esc(title) + '" data-tooltip="' + esc(title) + '">Collapse unchanged lines</button>';
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
