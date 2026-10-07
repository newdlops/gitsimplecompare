// 네이티브 blame 거터의 라인 배치, 재사용, hover와 편집기 폭 복원을 담당한다.
// - CDP 편집기 탐색과 분리해 표시 수명과 스크롤 비용을 독립적으로 검증한다.
export const NATIVE_BLAME_PATCH_VERSION = 5;

/**
 * workbench renderer에 상주하며 Monaco margin row와 blame label을 동기화하는 patch 본문을 만든다.
 * @returns renderer execution context에서 eval할 JavaScript source
 */
export function nativeBlameOverlayRendererScript(): string {
  return `
    (function () {
      var VERSION = ${NATIVE_BLAME_PATCH_VERSION};
      var STYLE_ID = 'gsc-native-blame-style';
      var previous = window.__gscNativeBlameOverlay;
      if (previous && previous.version !== VERSION) {
        try { previous.render(null); } catch (_) {}
      }
      var state = window.__gscNativeBlameOverlayState;
      if (!state || state.version !== VERSION) {
        state = {
          version: VERSION,
          snapshot: null,
          lineMap: new Map(),
          labels: new Map(),
          hover: null,
          hoverAnchor: null,
          editor: null,
          originalLineDecorationsWidth: undefined,
          baseLineDecorationsWidth: 10,
          extraWidth: 0,
          frame: 0,
          repaintTimers: [],
          observer: null,
          observerTarget: null,
          editorDisposables: []
        };
        window.__gscNativeBlameOverlayState = state;
      }

      function ensureStyle() {
        var style = document.getElementById(STYLE_ID);
        if (!style) {
          style = document.createElement('style');
          style.id = STYLE_ID;
          document.head.appendChild(style);
        }
        style.textContent = [
          '.gsc-native-blame-layer{position:absolute;top:0;height:100%;z-index:70;overflow:hidden;pointer-events:none;background:var(--vscode-editorGutter-background);}',
          '.gsc-native-blame-row{position:absolute;left:0;box-sizing:border-box;width:100%;display:flex;align-items:center;justify-content:flex-end;padding:0 8px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;pointer-events:auto;color:var(--vscode-editorCodeLens-foreground);background:var(--vscode-editorGutter-background);border-right:1px solid var(--vscode-editorIndentGuide-background1,transparent);font:inherit;cursor:default;}',
          '.gsc-native-blame-row:hover,.gsc-native-blame-row:focus-visible{color:var(--vscode-editor-foreground);}',
          '.gsc-native-blame-row:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px;}',
          '.gsc-native-blame-hover{position:fixed;box-sizing:border-box;z-index:2600;max-width:min(420px,calc(100vw - 16px));max-height:calc(100vh - 16px);padding:8px 12px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground));background:var(--vscode-editorHoverWidget-background,var(--vscode-editorWidget-background));border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-widget-border));border-radius:3px;box-shadow:0 2px 8px var(--vscode-widget-shadow);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);line-height:1.5;}'
        ].join('\\n');
      }
      function cleanupDom() {
        hideHover();
        state.labels.clear();
        Array.prototype.slice.call(document.querySelectorAll('.gsc-native-blame-layer,.gsc-native-blame-row')).forEach(function (node) {
          try { node.remove(); } catch (_) {}
        });
      }
      function clearFollowUpPaints() {
        (state.repaintTimers || []).forEach(function (timer) {
          try { clearTimeout(timer); } catch (_) {}
        });
        state.repaintTimers = [];
      }
      function schedulePaint() {
        if (state.frame) return;
        state.frame = requestAnimationFrame(function () {
          state.frame = 0;
          try { paint(); } catch (_) {}
        });
      }
      function scheduleFollowUpPaints() {
        clearFollowUpPaints();
        [80, 240, 800, 1800].forEach(function (delay) {
          state.repaintTimers.push(setTimeout(schedulePaint, delay));
        });
      }
      function editorUri(editor) {
        try {
          var model = editor && editor.getModel && editor.getModel();
          return model && model.uri && model.uri.toString ? model.uri.toString() : '';
        } catch (_) { return ''; }
      }
      function editorDom(editor) {
        try { return editor && editor.getDomNode ? editor.getDomNode() : null; } catch (_) { return null; }
      }
      function isUsableEditor(editor, uri) {
        var dom = editorDom(editor);
        return !!(editor && typeof editor.updateOptions === 'function' && typeof editor.getLayoutInfo === 'function' && dom && dom.isConnected && editorUri(editor) === uri);
      }
      function disposeEditorListeners() {
        (state.editorDisposables || []).forEach(function (disposable) {
          try { disposable.dispose(); } catch (_) {}
        });
        state.editorDisposables = [];
        if (state.observer) {
          try { state.observer.disconnect(); } catch (_) {}
        }
        state.observer = null;
        state.observerTarget = null;
      }
      function restoreEditorWidth() {
        var editor = state.editor;
        disposeEditorListeners();
        if (editor) {
          try {
            editor.updateOptions({ lineDecorationsWidth: state.originalLineDecorationsWidth });
          } catch (_) {}
        }
        if (window.__gscNativeBlameEditor === editor) window.__gscNativeBlameEditor = null;
        state.editor = null;
        state.originalLineDecorationsWidth = undefined;
        state.baseLineDecorationsWidth = 10;
        state.extraWidth = 0;
      }
      function measureCharacterWidth(dom) {
        var sample = document.createElement('span');
        sample.textContent = '00000000000000000000';
        sample.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-10000px;top:0;';
        var code = dom.querySelector('.view-lines .view-line');
        if (code) {
          var computed = window.getComputedStyle(code);
          sample.style.fontFamily = computed.fontFamily;
          sample.style.fontSize = computed.fontSize;
          sample.style.fontWeight = computed.fontWeight;
          sample.style.letterSpacing = computed.letterSpacing;
        }
        dom.appendChild(sample);
        var width = sample.getBoundingClientRect().width / 20;
        sample.remove();
        return Number.isFinite(width) && width > 2 ? width : 8;
      }
      function desiredExtraWidth(dom, snapshot) {
        var preferred = Math.ceil(measureCharacterWidth(dom) * Math.max(1, Number(snapshot.columnWidthCh) || 23) + 16);
        var maximum = Math.max(88, Math.min(260, Math.floor(dom.clientWidth * 0.42)));
        return Math.max(88, Math.min(maximum, preferred));
      }
      function bindEditorEvents(editor) {
        disposeEditorListeners();
        ['onDidScrollChange', 'onDidLayoutChange', 'onDidChangeModel'].forEach(function (name) {
          try {
            if (typeof editor[name] === 'function') state.editorDisposables.push(editor[name](function () {
              hideHover();
              // 편집기 폭·글꼴이 바뀔 때만 열 폭을 다시 계산해 좁은 pane에서 코드를 밀어내지 않는다.
              if (name === 'onDidLayoutChange' && state.snapshot) configureEditor(state.snapshot);
              schedulePaint();
            }));
          } catch (_) {}
        });
        try {
          if (typeof editor.onDidDispose === 'function') {
            state.editorDisposables.push(editor.onDidDispose(function () {
              cleanupDom();
              state.editor = null;
              window.__gscNativeBlameEditor = null;
            }));
          }
        } catch (_) {}
      }
      function configureEditor(snapshot) {
        var editor = window.__gscNativeBlameEditor;
        if (!isUsableEditor(editor, snapshot.uri)) return 'no-matching-editor';
        if (state.editor && state.editor !== editor) {
          cleanupDom();
          restoreEditorWidth();
        }
        var dom = editorDom(editor);
        var extraWidth = desiredExtraWidth(dom, snapshot);
        if (!state.editor) {
          var rawOptions = editor.getRawOptions ? editor.getRawOptions() : {};
          state.editor = editor;
          state.originalLineDecorationsWidth = rawOptions && rawOptions.lineDecorationsWidth;
          state.baseLineDecorationsWidth = typeof state.originalLineDecorationsWidth === 'number'
            ? state.originalLineDecorationsWidth
            : 10;
          bindEditorEvents(editor);
        }
        if (state.extraWidth !== extraWidth) {
          state.extraWidth = extraWidth;
          editor.updateOptions({ lineDecorationsWidth: state.baseLineDecorationsWidth + extraWidth });
        }
        return 'configured:' + extraWidth;
      }
      function isOwnNode(node) {
        return !!(node && node.nodeType === 1 && (
          (node.classList && (node.classList.contains('gsc-native-blame-layer') || node.classList.contains('gsc-native-blame-row'))) ||
          (node.closest && node.closest('.gsc-native-blame-layer,.gsc-native-blame-row'))
        ));
      }
      function observeMargin(margin) {
        if (!margin || typeof MutationObserver === 'undefined' || state.observerTarget === margin) return;
        if (state.observer) {
          try { state.observer.disconnect(); } catch (_) {}
        }
        state.observerTarget = margin;
        state.observer = new MutationObserver(function (mutations) {
          var changed = mutations.some(function (mutation) {
            if (isOwnNode(mutation.target)) return false;
            if (mutation.type !== 'childList') return true;
            var nodes = Array.prototype.slice.call(mutation.addedNodes || []).concat(Array.prototype.slice.call(mutation.removedNodes || []));
            return !nodes.length || !nodes.every(isOwnNode);
          });
          if (changed) schedulePaint();
        });
        try {
          state.observer.observe(margin, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'data-line-number']
          });
        } catch (_) {}
      }
      function rowLineNumber(row) {
        if (!row || !row.querySelector) return 0;
        var lineElement = row.querySelector('.line-numbers');
        var direct = row.getAttribute && row.getAttribute('data-line-number');
        var data = lineElement && lineElement.getAttribute && lineElement.getAttribute('data-line-number');
        if (direct && /^\\d+$/.test(direct)) return Number(direct);
        if (data && /^\\d+$/.test(data)) return Number(data);
        var text = [
          lineElement && lineElement.getAttribute && lineElement.getAttribute('aria-label'),
          lineElement && lineElement.getAttribute && lineElement.getAttribute('title'),
          lineElement && lineElement.textContent
        ].filter(Boolean).join(' ');
        var match = /(?:^|\\D)(\\d+)(?:\\D|$)/.exec(text);
        return match ? Number(match[1]) : 0;
      }
      function styleNumber(row, name, fallback) {
        var value = parseFloat(row && row.style && row.style[name] || '');
        return Number.isFinite(value) ? value : fallback;
      }
      function ensureLayer(margin, left, width) {
        var layer = margin.querySelector('.gsc-native-blame-layer');
        if (!layer) {
          state.labels.clear();
          layer = document.createElement('div');
          layer.className = 'gsc-native-blame-layer';
          margin.appendChild(layer);
        }
        layer.style.left = Math.max(0, left) + 'px';
        layer.style.width = Math.max(0, width) + 'px';
        return layer;
      }
      function makeLineMap(snapshot) {
        var map = new Map();
        (snapshot.lines || []).forEach(function (line) {
          var number = Number(line.line) || 0;
          if (number > 0 && !map.has(number)) map.set(number, line);
        });
        return map;
      }
      /** 같은 라인의 DOM을 유지해 재배치 중 hover·키보드 포커스가 끊기지 않게 한다. */
      function appendLabel(layer, row, line, hostTop) {
        var label = state.labels.get(line.line);
        if (!label) {
          label = document.createElement('span');
          label.className = 'gsc-native-blame-row';
          label.tabIndex = 0;
          label.addEventListener('pointerenter', function () { showHover(label); });
          label.addEventListener('focus', function () { showHover(label); });
          label.addEventListener('blur', function () {
            // Monaco가 클릭 뒤 본문으로 focus를 옮겨도 포인터가 머무르는 상세는 유지한다.
            if (!label.matches(':hover') && !(state.hover && state.hover.matches(':hover'))) hideHover();
          });
          label.addEventListener('pointerleave', function (event) {
            if (!state.hover || !state.hover.contains(event.relatedTarget)) hideHover();
          });
          label.setAttribute('data-gsc-line', String(line.line));
          state.labels.set(line.line, label);
          layer.appendChild(label);
        }
        var rowRect = row.getBoundingClientRect();
        label.style.top = (rowRect.top - hostTop) + 'px';
        label.style.height = Math.max(12, rowRect.height || styleNumber(row, 'height', 18)) + 'px';
        var text = String(line.label || '');
        var tooltip = String(line.tooltip || text);
        if (label.textContent !== text) label.textContent = text;
        if (label.getAttribute('data-tooltip') !== tooltip) {
          label.setAttribute('data-tooltip', tooltip);
          label.setAttribute('aria-label', tooltip);
        }
      }
      /** Escape로 열린 hover를 닫는다. editor 입력과 기본 키 동작은 그대로 유지한다. */
      function onHoverKey(event) {
        if (event.key === 'Escape') hideHover();
      }
      /** 활성 라인의 tooltip과 접근성 참조만 해제해 탭 전환·cleanup에 잔여 DOM을 남기지 않는다. */
      function hideHover() {
        if (state.hoverAnchor) state.hoverAnchor.removeAttribute('aria-describedby');
        if (state.hover) state.hover.remove();
        state.hover = null;
        state.hoverAnchor = null;
        document.removeEventListener('keydown', onHoverKey, true);
      }
      /** label의 plain text 상세를 즉시 보여 주고 좁은 창에서도 viewport 안에 배치한다. */
      function showHover(label) {
        if (!label || !label.isConnected) return;
        if (state.hoverAnchor === label && state.hover) return;
        hideHover();
        var hover = document.createElement('div');
        hover.id = 'gsc-native-blame-hover';
        hover.className = 'gsc-native-blame-hover';
        hover.setAttribute('role', 'tooltip');
        hover.textContent = label.getAttribute('data-tooltip') || label.textContent;
        var dom = editorDom(state.editor);
        var root = dom && dom.closest('.monaco-workbench') || document.body;
        root.appendChild(hover);
        state.hover = hover;
        state.hoverAnchor = label;
        label.setAttribute('aria-describedby', hover.id);
        document.addEventListener('keydown', onHoverKey, true);
        hover.addEventListener('pointerleave', function (event) {
          if (!label.contains(event.relatedTarget)) hideHover();
        });
        var anchor = label.getBoundingClientRect();
        var box = hover.getBoundingClientRect();
        var left = anchor.right - 1;
        var top = anchor.top;
        if (left + box.width > window.innerWidth - 8) {
          left = anchor.left;
          top = anchor.bottom - 1;
        }
        hover.style.left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8)) + 'px';
        hover.style.top = Math.max(8, Math.min(top, window.innerHeight - box.height - 8)) + 'px';
      }
      function paint() {
        var snapshot = state.snapshot;
        var editor = state.editor;
        if (!snapshot || !isUsableEditor(editor, snapshot.uri)) {
          cleanupDom();
          state.lastPaint = 'paint:no-editor';
          return state.lastPaint;
        }
        var dom = editorDom(editor);
        var margin = dom && dom.querySelector('.margin-view-overlays');
        var host = dom && (dom.querySelector('.overflow-guard') || dom);
        if (!margin || !host) {
          cleanupDom();
          state.lastPaint = 'paint:no-margin';
          return state.lastPaint;
        }
        observeMargin(margin);
        var layout = editor.getLayoutInfo();
        var layer = ensureLayer(host, Number(layout.contentLeft || 0) - state.extraWidth, state.extraWidth);
        var hostTop = host.getBoundingClientRect().top;
        var lineMap = state.lineMap;
        var used = new Set();
        var placed = 0;
        Array.prototype.slice.call(margin.children || []).forEach(function (row) {
          if (row === layer || isOwnNode(row)) return;
          var lineNumber = rowLineNumber(row);
          var line = lineMap.get(lineNumber);
          if (!line || used.has(lineNumber)) return;
          used.add(lineNumber);
          appendLabel(layer, row, line, hostTop);
          placed++;
        });
        state.labels.forEach(function (label, lineNumber) {
          if (used.has(lineNumber)) return;
          if (state.hoverAnchor === label) hideHover();
          label.remove();
          state.labels.delete(lineNumber);
        });
        state.lastPaint = 'paint:native:' + placed + '/' + lineMap.size + ':width=' + state.extraWidth;
        return state.lastPaint;
      }
      function teardown() {
        state.snapshot = null;
        state.lineMap.clear();
        if (state.frame) {
          try { cancelAnimationFrame(state.frame); } catch (_) {}
          state.frame = 0;
        }
        clearFollowUpPaints();
        cleanupDom();
        restoreEditorWidth();
        var style = document.getElementById(STYLE_ID);
        if (style) {
          try { style.remove(); } catch (_) {}
        }
        return 'cleaned';
      }

      window.__gscNativeBlameOverlay = {
        version: VERSION,
        render: function (snapshot) {
          if (!snapshot) return teardown();
          clearFollowUpPaints();
          hideHover();
          state.snapshot = snapshot;
          // 전체 파일 스캔은 snapshot 교체 때 한 번만 하고 이후에는 보이는 margin row만 읽는다.
          state.lineMap = makeLineMap(snapshot);
          state.lastPaint = '';
          var configured = configureEditor(snapshot);
          if (!/^configured:/.test(configured)) {
            cleanupDom();
            return configured;
          }
          ensureStyle();
          schedulePaint();
          scheduleFollowUpPaints();
          return 'render-scheduled:' + configured + ':' + paint();
        }
      };
      return 'gsc-native-blame-installed:' + VERSION;
    })()
  `;
}
