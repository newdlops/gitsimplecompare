// 주입된 workbench에서 커밋 호버의 구조·상태·액션·키보드 수명을 담당한다.
// - 라인 배치/Monaco 탐색과 분리하며 모든 Git 메시지와 identity는 textContent로 표시한다.

/** 현재 VS Code의 hover·SCM·링크·포커스 토큰만 사용하는 popup CSS를 반환한다. */
export function nativeBlameHoverStyles(): string {
  return [
    '.gsc-native-blame-hover{position:fixed;box-sizing:border-box;z-index:2600;width:min(460px,calc(100vw - 16px));max-height:calc(100vh - 16px);display:flex;flex-direction:column;overflow:hidden;color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground));background:var(--vscode-editorHoverWidget-background,var(--vscode-editorWidget-background));border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-widget-border));border-radius:4px;box-shadow:0 2px 8px var(--vscode-widget-shadow);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);line-height:1.45;overflow-wrap:anywhere;}',
    '.gsc-native-blame-hover .gsc-blame-author{display:flex;align-items:flex-start;gap:8px;padding:12px 12px 8px;flex-shrink:0;}',
    '.gsc-native-blame-hover .gsc-blame-identity{min-width:0;flex:1;}',
    '.gsc-native-blame-hover .gsc-blame-name{font-weight:600;}',
    '.gsc-native-blame-hover .gsc-blame-email,.gsc-native-blame-hover .gsc-blame-date{color:var(--vscode-descriptionForeground);font-size:12px;}',
    '.gsc-native-blame-hover .gsc-blame-date{display:flex;align-items:baseline;gap:4px;flex-wrap:wrap;margin-top:4px;}',
    '.gsc-native-blame-hover .gsc-blame-scroll{overflow:auto;overscroll-behavior:contain;min-height:0;padding:0 12px 12px;scrollbar-color:var(--vscode-scrollbarSlider-background) transparent;}',
    '.gsc-native-blame-hover .gsc-blame-subject{font-size:13px;font-weight:600;line-height:1.4;margin:0 0 6px;white-space:pre-wrap;}',
    '.gsc-native-blame-hover .gsc-blame-message{white-space:pre-wrap;line-height:1.45;}',
    '.gsc-native-blame-hover .gsc-blame-coauthors{display:flex;flex-direction:column;gap:4px;margin-top:12px;font-size:12px;}',
    '.gsc-native-blame-hover .gsc-blame-coauthor{display:flex;align-items:baseline;gap:6px;}',
    '.gsc-native-blame-hover .gsc-blame-coauthor-label{color:var(--vscode-descriptionForeground);font-style:italic;}',
    '.gsc-native-blame-hover .gsc-blame-stats{display:flex;gap:8px;flex-wrap:wrap;padding:8px 12px;border-top:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-widget-border));flex-shrink:0;font-size:12px;font-variant-numeric:tabular-nums;}',
    '.gsc-native-blame-hover .gsc-blame-insertions{color:var(--vscode-scmGraph-historyItemHoverAdditionsForeground,var(--vscode-gitDecoration-addedResourceForeground));}',
    '.gsc-native-blame-hover .gsc-blame-deletions{color:var(--vscode-scmGraph-historyItemHoverDeletionsForeground,var(--vscode-gitDecoration-deletedResourceForeground));}',
    '.gsc-native-blame-hover .gsc-blame-footer{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:4px 8px;border-top:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-widget-border));flex-shrink:0;}',
    '.gsc-native-blame-hover button{font:inherit;display:inline-flex;align-items:center;gap:4px;min-height:26px;padding:4px 6px;color:var(--vscode-textLink-foreground);background:transparent;border:0;border-radius:3px;cursor:pointer;}',
    '.gsc-native-blame-hover button:hover{color:var(--vscode-textLink-activeForeground,var(--vscode-textLink-foreground));background:var(--vscode-toolbar-hoverBackground);}',
    '.gsc-native-blame-hover button:active{background:var(--vscode-toolbar-activeBackground,var(--vscode-toolbar-hoverBackground));}',
    '.gsc-native-blame-hover button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px;}',
    '.gsc-native-blame-hover button:disabled,.gsc-native-blame-hover button[aria-disabled="true"]{color:var(--vscode-disabledForeground);cursor:default;}',
    '.gsc-native-blame-hover .gsc-blame-sha{font-family:var(--vscode-editor-font-family);font-size:12px;}',
    '.gsc-native-blame-hover .gsc-blame-settings{margin-left:auto;color:var(--vscode-icon-foreground);}',
    '.gsc-native-blame-hover .codicon{font-size:14px;flex-shrink:0;}',
    '.gsc-native-blame-hover .gsc-blame-account{font-size:16px;padding-top:2px;color:var(--vscode-icon-foreground);}',
    '.gsc-native-blame-hover .gsc-blame-status{box-sizing:border-box;padding:0 12px 8px;display:flex;align-items:center;gap:6px;color:var(--vscode-descriptionForeground);flex-shrink:0;font-size:12px;}',
    '.gsc-native-blame-hover .gsc-blame-status[data-error="true"]{color:var(--vscode-errorForeground);}',
    '.gsc-native-blame-hover .gsc-blame-feedback{color:var(--vscode-descriptionForeground);font-size:12px;}',
    '.gsc-native-blame-hover [hidden]{display:none!important;}',
    '.gsc-native-blame-hover ::selection{background:var(--vscode-editor-selectionBackground);color:var(--vscode-editor-selectionForeground,var(--vscode-editorHoverWidget-foreground));}',
  ].join('\n');
}

/**
 * gutter renderer 내부의 state/editorDom과 함께 실행할 독립 호버 구현을 반환한다.
 * @returns Git이나 VS Code API 없이 DOM과 좁은 CDP binding만 사용하는 JavaScript 본문
 */
export function nativeBlameHoverRendererScript(): string {
  return `
      var hoverUI = (function () {
        var closeTimer = 0;
        var suppressFocus = false;
        var pointerPoint = null, blockedPointer = null;
        state.hoverRequestSeq = state.hoverRequestSeq || 0;

        /** 주입된 번역에서 안내를 읽는다. key는 내부 UI 이름이며 fallback은 초기 구버전 snapshot용이다. */
        function text(key, fallback) { return state.snapshot && state.snapshot.hoverLabels && state.snapshot.hoverLabels[key] || fallback; }
        /** Git 데이터는 HTML로 해석하지 않고 tag/class/text의 의미 구조에 넣는다. */
        function node(parent, tag, className, value) {
          var element = document.createElement(tag);
          if (className) element.className = className;
          if (value !== undefined) element.textContent = String(value);
          if (parent) parent.appendChild(element);
          return element;
        }
        /** 기존 workbench Codicon을 사용한다. name은 고정된 내부 glyph 이름이다. */
        function icon(parent, name, className) {
          var element = node(parent, 'span', 'codicon codicon-' + name + (className ? ' ' + className : ''));
          element.setAttribute('aria-hidden', 'true'); return element;
        }
        /** 같은 popup의 식별자만 host에 보낸다. 명령명·파일 경로는 renderer가 지정하지 않는다. */
        function send(action) {
          var request = state.hoverRequest;
          if (!request || typeof window.gscNativeDiffOverlayToggle !== 'function') return false;
          window.gscNativeDiffOverlayToggle(JSON.stringify(Object.assign({}, request, { type: 'blameHover', action: action })));
          return true;
        }
        /** tooltip/접근성 이름과 실제 action이 있는 native 모양의 버튼을 한 번만 만든다. */
        function button(parent, action, glyph, title, label, className) {
          var element = node(parent, 'button', className || '');
          element.type = 'button'; element.title = title;
          element.setAttribute('aria-label', title); element.setAttribute('data-action', action);
          if (glyph) icon(element, glyph);
          if (label) node(element, 'span', action === 'openCommit' ? 'gsc-blame-sha' : '', label);
          element.addEventListener('click', function (event) {
            event.preventDefault(); event.stopPropagation();
            if (element.getAttribute('aria-disabled') === 'true') return;
            if (action === 'retry') setStatus(text('loading', 'Loading commit details…'), false);
            send(action === 'retry' ? 'retry' : action);
          });
          return element;
        }
        /** 초→년까지 현재 시각과의 실제 차이를 현 표시 언어로 만든다. 미래 시각도 그대로 표시한다. */
        function relative(date, locale) {
          var seconds = (date.getTime() - Date.now()) / 1000;
          var units = [['year',31536000],['month',2592000],['week',604800],['day',86400],['hour',3600],['minute',60],['second',1]];
          var chosen = units.filter(function (unit) { return Math.abs(seconds) >= unit[1]; })[0] || units[units.length - 1];
          try { return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(seconds / chosen[1]), chosen[0]); }
          catch (_) { return date.toLocaleDateString(); }
        }
        /** 구조와 footer 버튼은 유지한 채 실제 작성자·전체 메시지·공동 작성자만 갱신한다. */
        function fill(details) {
          var fields = state.hover && state.hover.__gscFields;
          if (!fields) return;
          fields.name.textContent = details.authorName || '';
          fields.email.textContent = details.authorEmail || ''; fields.email.hidden = !details.authorEmail;
          fields.email.title = details.authorEmail || '';
          var date = new Date(details.authorDateIso);
          var locale = state.snapshot.locale || navigator.language || 'en';
          if (details.authorDateIso && !isNaN(date.getTime())) {
            var exact = date.toLocaleString(locale, { year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short' });
            fields.dateValue.textContent = relative(date, locale) + ' · ' + exact;
            fields.date.title = date.toISOString(); fields.date.hidden = false;
          } else { fields.date.hidden = true; }
          var message = String(details.message || '').replace(/\\r\\n?/g, '\\n');
          var newline = message.indexOf('\\n');
          fields.subject.textContent = newline < 0 ? message : message.slice(0, newline);
          fields.message.textContent = newline < 0 ? '' : message.slice(newline + 1).replace(/^\\n/, '');
          fields.message.hidden = !fields.message.textContent;
          while (fields.coauthors.firstChild) fields.coauthors.removeChild(fields.coauthors.firstChild);
          (details.coAuthors || []).forEach(function (author) {
            var row = node(fields.coauthors, 'div', 'gsc-blame-coauthor'); icon(row, 'account');
            var identity = node(row, 'span', '', author.name + (author.email ? ' <' + author.email + '>' : ''));
            identity.title = author.email || author.name;
            node(row, 'span', 'gsc-blame-coauthor-label', text('coAuthor', 'Co-author'));
          });
          fields.coauthors.hidden = !(details.coAuthors || []).length;
          if (details.stats) {
            var stats = details.stats;
            var number = new Intl.NumberFormat(locale);
            fields.stats.hidden = false;
            fields.fileCount.textContent = stats.files ? text(stats.files === 1 ? 'fileChanged' : 'filesChanged', '{0} files changed').replace('{0}', number.format(stats.files)) : text('noChanges', 'No file changes');
            fields.fileCount.title = stats.binaryFiles ? text('binaryFiles', '{0} binary files').replace('{0}', number.format(stats.binaryFiles)) : fields.fileCount.textContent;
            fields.insertions.textContent = '+' + number.format(stats.insertions);
            fields.insertions.title = text('insertions', '{0} insertions (+)').replace('{0}', number.format(stats.insertions));
            fields.deletions.textContent = '−' + number.format(stats.deletions);
            fields.deletions.title = text('deletions', '{0} deletions (-)').replace('{0}', number.format(stats.deletions));
            fields.insertions.hidden = !stats.files; fields.deletions.hidden = !stats.files;
            if(!stats.files && document.activeElement===fields.open) fields.copy.focus();
            fields.open.disabled = !stats.files;
            if (!stats.files) fields.open.title = text('noChanges', 'No file changes');
          }
          fields.remote.hidden = !details.remoteUrl;
          if (details.remoteUrl) fields.remote.title = text('openRemote', 'Open Commit in Browser') + ' · ' + details.remoteUrl;
        }
        /** 로딩/오류는 기존 정보 옆에서 설명하고 재시도 버튼의 포커스도 보존한다. */
        function setStatus(message, failed) {
          var fields = state.hover && state.hover.__gscFields;
          if (!fields) return;
          var pendingRetry = !!message && !failed && !fields.retry.hidden;
          if (pendingRetry) fields.status.style.minHeight = fields.status.getBoundingClientRect().height + 'px';
          else fields.status.style.minHeight = '';
          if (!message && document.activeElement === fields.retry && !fields.copy.hidden) fields.copy.focus();
          fields.status.hidden = !message; fields.statusText.textContent = message || '';
          fields.status.setAttribute('data-error', failed ? 'true' : 'false');
          fields.retry.hidden = !failed && !pendingRetry;
          // 재시도 중에도 focus를 보존해 popup 아래의 다른 라인이 pointerenter로 선택되지 않게 한다.
          fields.retry.setAttribute('aria-disabled', pendingRetry ? 'true' : 'false');
        }
        /** viewport 안에서 anchor에 가깝게 배치하며 상세 도착/긴 메시지 뒤에도 다시 범위를 확인한다. */
        function place() {
          if (!state.hover || !state.hoverAnchor) return;
          var anchor = state.hoverAnchor.getBoundingClientRect(), box = state.hover.getBoundingClientRect();
          var left = anchor.right - 1, top = anchor.top;
          if (left + box.width > window.innerWidth - 8) { left = anchor.left; top = anchor.bottom - 1; }
          state.hover.style.left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8)) + 'px';
          state.hover.style.top = Math.max(8, Math.min(top, window.innerHeight - box.height - 8)) + 'px';
        }
        /** 닫기 예약을 취소해 row→popup이나 버튼 사이의 이동 중에 창을 유지한다. */
        function cancelClose() { if (closeTimer) clearTimeout(closeTimer); closeTimer = 0; }
        /** 실제 포인터 이동만 Escape 억제를 풀어 popup 제거 뒤 같은 좌표의 row로 재진입하는 것을 막는다. */
        function rememberPointer(event) {
          var point = {x:event.clientX,y:event.clientY};
          if(blockedPointer && (point.x!==blockedPointer.x || point.y!==blockedPointer.y)) {
            blockedPointer=null;
            if(!state.hover) document.removeEventListener('pointermove',rememberPointer,true);
          }
          pointerPoint=point;
        }
        /** geometry 변화로 생긴 pointerenter는 무시하고 실제 다른 좌표에 진입한 hover만 연다. */
        function enter(label,event) {
          if(blockedPointer && event.clientX===blockedPointer.x && event.clientY===blockedPointer.y) return;
          rememberPointer(event); show(label);
        }
        /** 활성 popup 소비자만 해제하고 aria/document listener/DOM 참조를 함께 정리한다. */
        function hide(notify) {
          cancelClose(); if (notify !== false) send('dismiss');
          blockedPointer=null; document.removeEventListener('pointermove',rememberPointer,true);
          if (state.hoverAnchor) { state.hoverAnchor.removeAttribute('aria-describedby'); state.hoverAnchor.setAttribute('aria-expanded','false'); }
          if (state.hover) state.hover.remove();
          state.hover = null; state.hoverAnchor = null; state.hoverRequest = null;
          document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onOutside, true);
          window.removeEventListener('blur', hide);
        }
        /** 포인터가 팝업과 거터 모두를 벗어날 때만 닫고 내부 keyboard focus는 보호한다. */
        function leave() {
          cancelClose(); closeTimer = setTimeout(function () {
            var active = document.activeElement;
            if (state.hover && (state.hover.matches(':hover') || state.hover.contains(active))) return;
            if (state.hoverAnchor && (state.hoverAnchor.matches(':hover') || state.hoverAnchor === active)) return;
            hide();
          }, 140);
        }
        /** 비모달 popup 밖의 일반 클릭은 즉시 닫는다. editor의 기본 클릭 동작은 중단하지 않는다. */
        function onOutside(event) {
          if (state.hover && !state.hover.contains(event.target) && state.hoverAnchor && !state.hoverAnchor.contains(event.target)) hide();
        }
        /** Escape로 닫고 내부 포커스만 anchor로 복원한다. Tab은 row에서 popup 액션으로 연결한다. */
        function onKey(event) {
          var anchor = state.hoverAnchor, hover = state.hover;
          if (!hover || !anchor) return;
          if (event.key === 'Escape') {
            var restore = hover.contains(document.activeElement);
            var point = pointerPoint;
            hide();
            if(point) {blockedPointer=point;document.addEventListener('pointermove',rememberPointer,true);}
            if (restore && anchor.isConnected) { suppressFocus = true; anchor.focus(); suppressFocus = false; event.preventDefault(); }
          } else if (event.key === 'Tab' && document.activeElement === anchor && !event.shiftKey) {
            var first = hover.querySelector('button:not([hidden]):not(:disabled)');
            if (first) { event.preventDefault(); first.focus(); }
          } else if(event.key === 'Tab' && event.shiftKey && document.activeElement === hover.querySelector('button:not([hidden]):not(:disabled)')) {
            event.preventDefault(); anchor.focus();
          }
        }
        /** 현재 라인의 이미 읽은 정보로 shell을 즉시 만들고 commit 상세만 host에 요청한다. */
        function show(label) {
          if (suppressFocus || !label || !label.isConnected) return;
          cancelClose();
          if (state.hoverAnchor === label && state.hover) return;
          if (state.hover && state.hover.contains(document.activeElement)) return;
          var line = state.lineMap.get(Number(label.getAttribute('data-gsc-line')));
          var summary = line && state.snapshot.commits && state.snapshot.commits[line.commit];
          var working=summary && /^0+$/.test(summary.hash);
          hide(!summary || working);
          var hover = node(null, 'div', 'gsc-native-blame-hover'); hover.id = 'gsc-native-blame-hover';
          hover.setAttribute('role', 'dialog'); hover.setAttribute('aria-label', text('title','Commit details'));
          var dom = editorDom(state.editor), root = dom && dom.closest('.monaco-workbench') || document.body;
          root.appendChild(hover); state.hover = hover; state.hoverAnchor = label;
          label.setAttribute('aria-describedby', hover.id); label.setAttribute('aria-expanded','true');
          var author = node(hover,'div','gsc-blame-author'); icon(author,'account','gsc-blame-account');
          var identity = node(author,'div','gsc-blame-identity');
          var fields = { name:node(identity,'div','gsc-blame-name'), email:node(identity,'div','gsc-blame-email') };
          fields.date = node(identity,'div','gsc-blame-date'); icon(fields.date,'history'); fields.dateValue = node(fields.date,'span','');
          var scroll = node(hover,'div','gsc-blame-scroll'); fields.subject=node(scroll,'h3','gsc-blame-subject');
          fields.message=node(scroll,'div','gsc-blame-message'); fields.coauthors=node(scroll,'div','gsc-blame-coauthors');
          fields.stats=node(hover,'div','gsc-blame-stats'); fields.stats.hidden=true;
          fields.fileCount=node(fields.stats,'span',''); fields.insertions=node(fields.stats,'span','gsc-blame-insertions'); fields.deletions=node(fields.stats,'span','gsc-blame-deletions');
          var footer=node(hover,'div','gsc-blame-footer');
          fields.open=button(footer,'openCommit','git-commit',text('openCommit','Open Commit Changes') + (summary ? ' · '+summary.hash : ''),summary ? summary.hash.slice(0,8) : '', '');
          fields.copy=button(footer,'copyHash','copy',text('copyHash','Copy Commit Hash'),'', '');
          fields.remote=button(footer,'openRemote','link-external',text('openRemote','Open Commit in Browser'),'', ''); fields.remote.hidden=true;
          fields.feedback=node(footer,'span','gsc-blame-feedback'); fields.feedback.setAttribute('role','status');
          button(footer,'settings','gear',text('settings','Open Blame Settings'),'', 'gsc-blame-settings');
          fields.status=node(hover,'div','gsc-blame-status'); fields.status.setAttribute('role','status');
          fields.statusText=node(fields.status,'span',''); fields.retry=button(fields.status,'retry','refresh',text('retry','Retry'),text('retry','Retry'),''); fields.retry.hidden=true;
          hover.__gscFields=fields;
          state.hoverRequest=summary ? { uri:state.snapshot.uri,revision:state.snapshot.revision,line:line.line,commit:summary.hash,requestId:++state.hoverRequestSeq } : null;
          fields.open.hidden=fields.copy.hidden=!!working || !summary;
          fill(summary || {message:label.getAttribute('data-tooltip') || label.textContent});
          setStatus(summary && !working ? text('loading','Loading commit details…') : '', false);
          document.addEventListener('keydown',onKey,true); document.addEventListener('pointerdown',onOutside,true); window.addEventListener('blur',hide);
          document.addEventListener('pointermove',rememberPointer,true);
          hover.addEventListener('pointerenter',cancelClose); hover.addEventListener('pointerleave',leave);
          hover.addEventListener('focusout',function(event){if(!hover.contains(event.relatedTarget) && event.relatedTarget !== label)leave();});
          place();
          if (summary && !working && !send('load')) setStatus(text('error','Could not load commit details.'),true);
        }
        /** 식별자가 일치하는 ready/error/copy 결과만 적용한다. 버튼 DOM과 키보드 포커스는 재생성하지 않는다. */
        function update(response) {
          var request=state.hoverRequest;
          if(!state.hover || !request || !response || request.requestId!==response.requestId || request.uri!==response.uri
            || request.revision!==response.revision || request.line!==response.line || request.commit!==response.commit) return 'blame-hover-stale';
          if(response.status==='ready' && response.details && response.details.hash===request.commit) {fill(response.details);setStatus('',false);place();}
          else if(response.status==='error') {setStatus(response.message || text('error','Could not load commit details.'),true);place();}
          else if(response.status==='copied') state.hover.__gscFields.feedback.textContent=response.message || text('copied','Commit hash copied');
          return 'blame-hover-updated:'+response.status;
        }
        return {show:show,hide:hide,leave:leave,enter:enter,update:update};
      })();
  `;
}
