// PR preview 웹뷰에서 사용할 안전한 markdown/html block 렌더러 스크립트.
// - 외부 CDN 없이 기본 markdown 을 HTML 로 바꾸고, 허용 태그/속성만 남겨 웹뷰 주입 위험을 줄인다.

/**
 * PR preview 클라이언트에 주입할 markdown 렌더링 함수들을 반환한다.
 * @returns 웹뷰 script 태그 안에 들어갈 JavaScript 코드 문자열
 */
export function pullRequestPreviewMarkdownScript(): string {
  return `
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
  `;
}
