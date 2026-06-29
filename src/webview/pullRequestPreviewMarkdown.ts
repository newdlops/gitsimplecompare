// PR preview 웹뷰에서 사용할 안전한 markdown/html block 렌더러 스크립트.
// - 외부 CDN 없이 기본 markdown 을 HTML 로 바꾸고, 허용 태그/속성만 남겨 웹뷰 주입 위험을 줄인다.

/**
 * PR preview 클라이언트에 주입할 markdown 렌더링 함수들을 반환한다.
 * @returns 웹뷰 script 태그 안에 들어갈 JavaScript 코드 문자열
 */
export function pullRequestPreviewMarkdownScript(): string {
  return `
    function renderReviewCommentMarkdown(comment, fallbackLanguage) {
      const body = String(comment?.body || comment?.bodyText || '').replace(/\\r\\n/g, '\\n');
      const label = reviewCommentRangeLabel(comment);
      const language = fallbackLanguage || commentLanguage(comment);
      const segments = splitCommentFences(body);
      const parts = [];
      let hasSuggestion = false;
      segments.forEach((segment) => {
        if (segment.kind === 'suggestion') {
          hasSuggestion = true;
          parts.push(suggestedChangeHtml(segment.value, label, comment, language));
        } else if (segment.kind === 'code') {
          parts.push(codeBlockHtml(segment.value));
        } else if (String(segment.value || '').trim()) {
          parts.push(renderMarkdown(segment.value));
        }
      });
      if (!hasSuggestion) {
        suggestionsFromCommentHtml(comment?.bodyHtml).forEach((suggestion) => {
          parts.push(suggestedChangeHtml(suggestion, label, comment, language));
        });
      }
      return parts.length ? parts.join('') : renderMarkdown(body);
    }
    function commentLanguage(comment) {
      return typeof languageForPath === 'function'
        ? languageForPath(comment?.path || comment?.filePath || '')
        : 'plain';
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
    function suggestedChangeHtml(value, label, comment, language) {
      const title = 'Suggested changeset' + (label ? ' · ' + label : '');
      const rows = suggestedChangeRows(value, comment || {});
      const body = rows.length
        ? '<div class="suggested-change-diff">' + suggestedChangeRowsHtml(rows, language || 'plain') + '</div>'
        : '<pre><code>' + esc('Delete selected lines') + '</code></pre>';
      return '<div class="suggested-change"><p><strong>' + esc(title) + '</strong></p>' + body + '</div>';
    }
    function suggestedChangeRows(value, comment) {
      const encodedRows = decodeEncodedSuggestedChangeRows(value);
      if (encodedRows) {
        return lineNumberedEncodedRows(encodedRows, comment).map(encodedSuggestedChangeRow);
      }
      const suggestionLines = codeLines(value);
      const originalRows = selectedSuggestedOriginalRows(comment);
      const range = reviewCommentRange(comment || {});
      const suggestionRows = suggestionLines.map((line, index) => ({
        kind: 'add',
        marker: '+',
        no: range ? range.start + index : '',
        newNo: range ? range.start + index : '',
        code: line,
      }));
      return pairSuggestedChangeRows(originalRows, suggestionRows);
    }
    function decodeEncodedSuggestedChangeRows(value) {
      const prefix = '\\u001fGSC_SUGGESTED_CHANGE_V1:';
      const text = String(value || '');
      if (!text.startsWith(prefix)) return undefined;
      try {
        const parsed = JSON.parse(text.slice(prefix.length));
        return Array.isArray(parsed) ? parsed.filter((row) => row && typeof row.text === 'string') : undefined;
      } catch {
        return undefined;
      }
    }
    function encodedSuggestedChangeRow(row) {
      const kind = row.kind === 'delete' ? 'del' : row.kind === 'add' ? 'add' : 'ctx';
      return {
        kind,
        marker: kind === 'del' ? '-' : kind === 'add' ? '+' : '',
        no: displaySuggestedLineNo(row.oldLine, row.newLine),
        oldNo: numberLine(row.oldLine) || '',
        newNo: numberLine(row.newLine) || '',
        code: row.text || '',
      };
    }
    function lineNumberedEncodedRows(rows, comment) {
      if (rows.every((row) => row.oldLine || row.newLine)) return rows;
      return inferEncodedRowLineNumbers(rows, comment || {}) || rows;
    }
    function inferEncodedRowLineNumbers(rows, comment) {
      const range = reviewCommentRange(comment || {});
      const hunkLines = parseSuggestedDiffHunk(comment?.diffHunk || comment?.diff_hunk || '');
      const anchor = encodedRowAnchor(rows, hunkLines, range?.side || 'RIGHT');
      const startLine = anchor?.lineNo || range?.start;
      if (!startLine) return undefined;
      let oldLine = startLine;
      let newLine = startLine;
      const anchorIndex = anchor?.rowIndex ?? 0;
      for (let index = anchorIndex - 1; index >= 0; index--) {
        if (rows[index].kind === 'context') {
          oldLine--;
          newLine--;
        } else if (rows[index].kind === 'delete') {
          oldLine--;
        } else {
          newLine--;
        }
      }
      return rows.map((row) => {
        const numbered = numberEncodedRow(row, oldLine, newLine);
        oldLine = numbered.nextOldLine;
        newLine = numbered.nextNewLine;
        return numbered.row;
      });
    }
    function numberEncodedRow(row, oldLine, newLine) {
      if (row.kind === 'context') {
        return {
          row: Object.assign({}, row, { oldLine: row.oldLine || oldLine, newLine: row.newLine || newLine }),
          nextOldLine: oldLine + 1,
          nextNewLine: newLine + 1,
        };
      }
      if (row.kind === 'delete') {
        return {
          row: Object.assign({}, row, { oldLine: row.oldLine || oldLine }),
          nextOldLine: oldLine + 1,
          nextNewLine: newLine,
        };
      }
      return {
        row: Object.assign({}, row, { newLine: row.newLine || newLine }),
        nextOldLine: oldLine,
        nextNewLine: newLine + 1,
      };
    }
    function encodedRowAnchor(rows, hunkLines, side) {
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        if (row.kind === 'add') continue;
        const line = hunkLines.find((candidate) =>
          lineExistsOnSide(candidate, side) && sameCodeText(row.text || '', candidate.text || '')
        );
        const lineNo = line ? lineNumberOnSide(line, side) : undefined;
        if (lineNo) return { rowIndex, lineNo };
      }
      return undefined;
    }
    function lineExistsOnSide(line, side) {
      return side === 'LEFT' ? line.type !== 'add' : line.type !== 'delete';
    }
    function lineNumberOnSide(line, side) {
      const value = side === 'LEFT' ? line.oldLine : line.newLine;
      return numberLine(value);
    }
    function sameCodeText(a, b) {
      return String(a || '').replace(/[ \\t]+$/g, '') === String(b || '').replace(/[ \\t]+$/g, '');
    }
    function displaySuggestedLineNo(oldNo, newNo) {
      const oldLine = numberLine(oldNo);
      const newLine = numberLine(newNo);
      if (oldLine && newLine && oldLine !== newLine) return oldLine + '→' + newLine;
      return oldLine || newLine || '';
    }
    function pairSuggestedChangeRows(deletedRows, addedRows) {
      if (hasSuggestedLineNumbers(deletedRows) && hasSuggestedLineNumbers(addedRows)) {
        return pairSuggestedRowsByLineNumber(deletedRows, addedRows);
      }
      return pairSuggestedRowsByIndex(deletedRows, addedRows);
    }
    function hasSuggestedLineNumbers(rows) {
      return rows.some((row) => typeof row.no === 'number');
    }
    function pairSuggestedRowsByLineNumber(deletedRows, addedRows) {
      const rows = [];
      const addedByLine = new Map();
      const used = new Set();
      addedRows.forEach((row) => {
        if (typeof row.no !== 'number') return;
        const list = addedByLine.get(row.no) || [];
        list.push(row);
        addedByLine.set(row.no, list);
      });
      deletedRows.forEach((row) => {
        rows.push(row);
        const matches = typeof row.no === 'number' ? addedByLine.get(row.no) : undefined;
        if (!matches) return;
        matches.forEach((added) => {
          rows.push(added);
          used.add(added);
        });
      });
      addedRows.forEach((row) => { if (!used.has(row)) rows.push(row); });
      return rows;
    }
    function pairSuggestedRowsByIndex(deletedRows, addedRows) {
      const rows = [];
      const max = Math.max(deletedRows.length, addedRows.length);
      for (let index = 0; index < max; index++) {
        if (deletedRows[index]) rows.push(deletedRows[index]);
        if (addedRows[index]) rows.push(addedRows[index]);
      }
      return rows;
    }
    function selectedSuggestedOriginalRows(comment) {
      const hunk = comment?.diffHunk || comment?.diff_hunk || '';
      if (!hunk) return [];
      const range = reviewCommentRange(comment || {});
      if (!range) return [];
      return parseSuggestedDiffHunk(hunk)
        .filter((line) => suggestedDiffLineInRange(line, range))
        .map((line) => ({
          kind: 'del',
          marker: '-',
          no: range.side === 'LEFT' ? line.oldLine : line.newLine,
          oldNo: range.side === 'LEFT' ? line.oldLine : line.newLine,
          newNo: '',
          code: line.text,
        }));
    }
    function suggestedChangeRowsHtml(rows, language) {
      if (typeof inlineDiffPair !== 'function') {
        return rows.map((row) => suggestedChangeRowHtml(row, language)).join('');
      }
      const out = [];
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const next = rows[index + 1];
        if (row?.kind === 'del' && next?.kind === 'add') {
          const fragments = inlineDiffPair(row.code, next.code, language);
          out.push(suggestedChangeRowHtml(row, language, fragments.old));
          out.push(suggestedChangeRowHtml(next, language, fragments.new));
          index++;
          continue;
        }
        out.push(suggestedChangeRowHtml(row, language));
      }
      return out.join('');
    }
    function suggestedChangeRowHtml(row, language, codeHtml) {
      const kind = row.kind === 'add' ? 'add' : row.kind === 'del' ? 'del' : 'ctx';
      const code = codeHtml == null
        ? (typeof highlightCode === 'function' ? highlightCode(row.code || ' ', language) : esc(row.code || ' '))
        : codeHtml;
      return '<div class="suggested-change-row ' + kind + '">' +
        '<span class="suggested-change-line-no old">' + esc(row.oldNo || '') + '</span>' +
        '<span class="suggested-change-line-no new">' + esc(row.newNo || '') + '</span>' +
        '<span class="suggested-change-marker">' + esc(row.marker || '') + '</span>' +
        '<span class="suggested-change-code">' + code + '</span></div>';
    }
    function parseSuggestedDiffHunk(hunk) {
      const lines = [];
      let oldLine = 0;
      let newLine = 0;
      String(hunk || '').split(/\\r?\\n/).forEach((raw) => {
        const header = /^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/.exec(raw);
        if (header) {
          oldLine = Number(header[1]);
          newLine = Number(header[2]);
          return;
        }
        if (!raw || raw.startsWith('\\\\')) return;
        const prefix = raw[0];
        const text = raw.slice(1);
        if (prefix === '+') {
          lines.push({ type: 'add', text, oldLine, newLine });
          newLine++;
        } else if (prefix === '-') {
          lines.push({ type: 'delete', text, oldLine, newLine });
          oldLine++;
        } else {
          lines.push({ type: 'context', text, oldLine, newLine });
          oldLine++;
          newLine++;
        }
      });
      return lines;
    }
    function suggestedDiffLineInRange(line, range) {
      if (range.side === 'LEFT') {
        return line.type !== 'add'
          && typeof line.oldLine === 'number'
          && line.oldLine >= range.start
          && line.oldLine <= range.end;
      }
      return line.type !== 'delete'
        && typeof line.newLine === 'number'
        && line.newLine >= range.start
        && line.newLine <= range.end;
    }
    function codeLines(value) {
      const trimmed = stripTrailingLineBreaks(value);
      return trimmed ? trimmed.split(/\\r?\\n|\\r/) : [];
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
      return { side, start: Math.min(start, end), end: Math.max(start, end) };
    }
    function numberLine(value) {
      const line = Number(value);
      return Number.isFinite(line) && line > 0 ? line : undefined;
    }
  `;
}
