// line-by-line blame을 VS Code editor 본문이 아닌 네이티브 거터에 그리는 renderer patch 조립 모듈.
// - main process CDP는 대상 Monaco editor instance를 찾고 renderer patch에 연결한다.
// - renderer는 Monaco의 lineDecorationsWidth를 늘린 뒤 margin row와 같은 top에 label을 배치한다.
import type { BlockBlameGutterSnapshot } from "../ui/blockBlameGutter";
import {
  mainEvalExpression,
  rendererEvalExpression,
  type NativeOverlayWorkspaceHints,
} from "./nativeDiffOverlayMain";

const PATCH_VERSION = 2;
const RENDERER_BINDING = "gscNativeDiffOverlayToggle";
const REMOTE_OBJECT_GROUP = "gsc-native-blame-discovery";
const CODE_EDITOR_METHODS = [
  "getDomNode",
  "updateOptions",
  "getRawOptions",
  "createDecorationsCollection",
  "getLayoutInfo",
];

/**
 * Runtime.queryObjects 결과에서 URI가 일치하는 살아 있는 Monaco code editor를 renderer 전역에 연결한다.
 * - 함수 문자열은 VS Code main process가 renderer CDP의 Runtime.callFunctionOn에 그대로 전달한다.
 */
const BIND_EDITOR_FUNCTION = `function (uri) {
  function modelUri(item) {
    try {
      var model = item && typeof item.getModel === 'function' ? item.getModel() : null;
      return model && model.uri && typeof model.uri.toString === 'function' ? model.uri.toString() : '';
    } catch (_) { return ''; }
  }
  function visible(item) {
    try {
      var dom = item && typeof item.getDomNode === 'function' ? item.getDomNode() : null;
      return !!(dom && dom.isConnected && dom.offsetParent !== null && dom.clientWidth > 0 && dom.clientHeight > 0);
    } catch (_) { return false; }
  }
  var matches = Array.prototype.filter.call(this || [], function (item) {
    return item && typeof item.updateOptions === 'function' && typeof item.getLayoutInfo === 'function' && modelUri(item) === uri && visible(item);
  });
  var item = matches.filter(function (candidate) {
    try { return candidate.getDomNode().classList.contains('focused'); } catch (_) { return false; }
  })[0] || matches[0];
  if (!item) return 'editor-not-found:' + uri;
  window.__gscNativeBlameEditor = item;
  window.__gscNativeBlameEditorConstructor = item.constructor;
  try {
    if (typeof WeakRef === 'function') window.__gscNativeBlameEditorRef = new WeakRef(item);
  } catch (_) {}
  return 'editor-bound:' + uri;
}`;

/**
 * renderer patch 설치, 대상 Monaco editor 탐색, blame snapshot render를 한 main expression으로 조립한다.
 * @param rendererScript workbench renderer에 설치할 blame overlay JavaScript
 * @param snapshot 현재 파일의 line-by-line blame snapshot
 * @param hints 올바른 VS Code BrowserWindow를 고르기 위한 workspace 힌트
 * @returns extension host가 main process Runtime.evaluate에 전달할 expression
 */
export function blameOverlayInjectionExpression(
  rendererScript: string,
  snapshot: BlockBlameGutterSnapshot,
  hints: NativeOverlayWorkspaceHints
): string {
  const rendererEval = rendererEvalExpression(rendererScript);
  const snapshotJson = JSON.stringify(snapshot);
  return mainEvalExpression(
    RENDERER_BINDING,
    hints,
    `
      var rendererEval = ${JSON.stringify(rendererEval)};
      var snapshot = ${snapshotJson};
      var installExpr = '(window.__gscNativeBlameOverlay&&window.__gscNativeBlameOverlay.version===' + ${PATCH_VERSION} + ') ? "gsc-native-blame-installed:${PATCH_VERSION}:cached" : ' + rendererEval;

      async function remoteProperties(debuggerApi, objectId) {
        return debuggerApi.sendCommand('Runtime.getProperties', {
          objectId: objectId,
          ownProperties: true,
          accessorPropertiesOnly: false,
          generatePreview: false
        });
      }
      async function remoteValue(debuggerApi, expression) {
        return debuggerApi.sendCommand('Runtime.evaluate', {
          expression: expression,
          includeCommandLineAPI: true,
          returnByValue: true,
          awaitPromise: true,
          objectGroup: ${JSON.stringify(REMOTE_OBJECT_GROUP)}
        });
      }
      async function remoteObject(debuggerApi, expression) {
        return debuggerApi.sendCommand('Runtime.evaluate', {
          expression: expression,
          includeCommandLineAPI: true,
          returnByValue: false,
          objectGroup: ${JSON.stringify(REMOTE_OBJECT_GROUP)}
        });
      }
      function resultValue(response) {
        return response && response.result && response.result.value;
      }
      async function bindEditorInstances(debuggerApi, instancesObjectId) {
        var response = await debuggerApi.sendCommand('Runtime.callFunctionOn', {
          objectId: instancesObjectId,
          functionDeclaration: ${JSON.stringify(BIND_EDITOR_FUNCTION)},
          arguments: [{ value: snapshot.uri }],
          returnByValue: true,
          objectGroup: ${JSON.stringify(REMOTE_OBJECT_GROUP)}
        });
        return String(resultValue(response) || 'editor-bind-empty');
      }
      async function bindFromPrototype(debuggerApi, prototypeObjectId) {
        if (!prototypeObjectId) return 'editor-prototype-missing';
        var queried = await debuggerApi.sendCommand('Runtime.queryObjects', {
          prototypeObjectId: prototypeObjectId,
          objectGroup: ${JSON.stringify(REMOTE_OBJECT_GROUP)}
        });
        var instancesObjectId = queried && queried.objects && queried.objects.objectId;
        return instancesObjectId
          ? bindEditorInstances(debuggerApi, instancesObjectId)
          : 'editor-instances-missing';
      }
      async function cachedEditor(debuggerApi) {
        var expression = '(function(uri){var item=window.__gscNativeBlameEditor;try{if((!item||!item.getDomNode||!item.getDomNode()||!item.getDomNode().isConnected)&&window.__gscNativeBlameEditorRef)item=window.__gscNativeBlameEditorRef.deref();var model=item&&item.getModel&&item.getModel();var current=model&&model.uri&&model.uri.toString();var dom=item&&item.getDomNode&&item.getDomNode();if(current===uri&&dom&&dom.isConnected&&dom.offsetParent!==null){window.__gscNativeBlameEditor=item;return "editor-cached:"+uri;}}catch(_){}return "editor-cache-miss";})(' + JSON.stringify(snapshot.uri) + ')';
        return String(resultValue(await remoteValue(debuggerApi, expression)) || 'editor-cache-empty');
      }
      async function cachedConstructor(debuggerApi) {
        var response = await remoteObject(
          debuggerApi,
          'window.__gscNativeBlameEditorConstructor&&window.__gscNativeBlameEditorConstructor.prototype'
        );
        var prototypeObjectId = response && response.result && response.result.objectId;
        return bindFromPrototype(debuggerApi, prototypeObjectId);
      }
      async function moduleScopeFromListeners(debuggerApi) {
        var listeners = await remoteObject(
          debuggerApi,
          'getEventListeners(document.querySelector(".monaco-editor.focused")||Array.prototype.slice.call(document.querySelectorAll(".monaco-editor")).filter(function(node){return node&&node.isConnected&&node.offsetParent!==null&&node.clientWidth>0&&node.clientHeight>0;})[0])'
        );
        var listenersId = listeners && listeners.result && listeners.result.objectId;
        if (!listenersId) return '';
        var groups = await remoteProperties(debuggerApi, listenersId);
        var groupProperties = (groups && groups.result) || [];
        for (var groupIndex = 0; groupIndex < groupProperties.length; groupIndex++) {
          var groupId = groupProperties[groupIndex].value && groupProperties[groupIndex].value.objectId;
          if (!groupId) continue;
          var items = await remoteProperties(debuggerApi, groupId);
          var itemProperties = (items && items.result) || [];
          for (var itemIndex = 0; itemIndex < itemProperties.length; itemIndex++) {
            if (!/^\\d+$/.test(itemProperties[itemIndex].name || '')) continue;
            var itemId = itemProperties[itemIndex].value && itemProperties[itemIndex].value.objectId;
            if (!itemId) continue;
            var item = await remoteProperties(debuggerApi, itemId);
            var listenerProperty = ((item && item.result) || []).filter(function (property) {
              return property.name === 'listener';
            })[0];
            var listenerId = listenerProperty && listenerProperty.value && listenerProperty.value.objectId;
            if (!listenerId) continue;
            var listener = await remoteProperties(debuggerApi, listenerId);
            var scopes = ((listener && listener.internalProperties) || []).filter(function (property) {
              return property.name === '[[Scopes]]';
            })[0];
            var scopesId = scopes && scopes.value && scopes.value.objectId;
            if (!scopesId) continue;
            var scopeList = await remoteProperties(debuggerApi, scopesId);
            var scopeProperties = (scopeList && scopeList.result) || [];
            for (var scopeIndex = 0; scopeIndex < scopeProperties.length; scopeIndex++) {
              var scope = scopeProperties[scopeIndex].value;
              if (scope && scope.description === 'Module' && scope.objectId) return scope.objectId;
            }
          }
        }
        return '';
      }
      async function discoverEditor(debuggerApi) {
        var moduleScopeId = await moduleScopeFromListeners(debuggerApi);
        if (!moduleScopeId) return 'editor-module-scope-missing';
        var moduleProperties = await remoteProperties(debuggerApi, moduleScopeId);
        var properties = (moduleProperties && moduleProperties.result) || [];
        var requiredMethods = ${JSON.stringify(CODE_EDITOR_METHODS)};
        for (var index = 0; index < properties.length; index++) {
          var value = properties[index].value;
          var description = String(value && value.description || '');
          if (!value || value.type !== 'function' || !value.objectId) continue;
          if (!requiredMethods.every(function (method) { return description.indexOf(method) >= 0; })) continue;
          var constructorProperties = await remoteProperties(debuggerApi, value.objectId);
          var prototype = ((constructorProperties && constructorProperties.result) || []).filter(function (property) {
            return property.name === 'prototype';
          })[0];
          var prototypeObjectId = prototype && prototype.value && prototype.value.objectId;
          var bound = await bindFromPrototype(debuggerApi, prototypeObjectId);
          if (/^editor-bound:/.test(bound)) return bound;
        }
        return 'editor-constructor-missing';
      }
      async function prepareBlameEditor(w) {
        var debuggerApi = await ensureWindow(w);
        try {
          var cached = await cachedEditor(debuggerApi);
          if (/^editor-cached:/.test(cached)) return cached;
          var constructorBound = await cachedConstructor(debuggerApi);
          if (/^editor-bound:/.test(constructorBound)) return constructorBound;
          return await discoverEditor(debuggerApi);
        } finally {
          try {
            await debuggerApi.sendCommand('Runtime.releaseObjectGroup', {
              objectGroup: ${JSON.stringify(REMOTE_OBJECT_GROUP)}
            });
          } catch (_) {}
        }
      }

      var out = [];
      for (var i = 0; i < wins.length; i++) {
        var installed = await evalWindow(wins[i], installExpr);
        var prepared = await prepareBlameEditor(wins[i]);
        if (!/^editor-(?:cached|bound):/.test(prepared)) {
          out.push(installed + ',err:' + wins[i].id + ':' + prepared);
          continue;
        }
        var renderExpr = 'window.__gscNativeBlameOverlay&&window.__gscNativeBlameOverlay.render(' + JSON.stringify(snapshot) + ')';
        var rendered = await evalWindow(wins[i], renderExpr);
        out.push(installed + ',' + prepared + ',' + rendered);
      }
      return out.join('|');
    `
  );
}

/**
 * renderer에 남은 blame DOM과 확장한 Monaco 거터 폭을 원래 값으로 복원한다.
 * @param hints cleanup할 VS Code BrowserWindow를 고르기 위한 workspace 힌트
 * @returns main process Runtime.evaluate에 전달할 cleanup expression
 */
export function blameOverlayCleanupExpression(
  hints: NativeOverlayWorkspaceHints
): string {
  return mainEvalExpression(
    RENDERER_BINDING,
    hints,
    `
      var out = [];
      var cleanupExpr = '(function(){if(window.__gscNativeBlameOverlay)return window.__gscNativeBlameOverlay.render(null);document.querySelectorAll(".gsc-native-blame-layer,.gsc-native-blame-row").forEach(function(node){node.remove();});var style=document.getElementById("gsc-native-blame-style");if(style)style.remove();return "cleaned-fallback";})()';
      for (var i = 0; i < wins.length; i++) {
        out.push(await evalWindow(wins[i], cleanupExpr));
      }
      return out.join('|');
    `
  );
}

/**
 * workbench renderer에 상주하며 Monaco margin row와 blame label을 동기화하는 patch 본문을 만든다.
 * @returns renderer execution context에서 eval할 JavaScript source
 */
export function nativeBlameOverlayRendererScript(): string {
  return `
    (function () {
      var VERSION = ${PATCH_VERSION};
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
          '.gsc-native-blame-row:hover{color:var(--vscode-editor-foreground);}'
        ].join('\\n');
      }
      function cleanupDom() {
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
            if (typeof editor[name] === 'function') state.editorDisposables.push(editor[name](schedulePaint));
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
        state.extraWidth = extraWidth;
        editor.updateOptions({ lineDecorationsWidth: state.baseLineDecorationsWidth + extraWidth });
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
      function appendLabel(layer, row, line, hostTop) {
        var label = document.createElement('span');
        label.className = 'gsc-native-blame-row';
        var rowRect = row.getBoundingClientRect();
        label.style.top = (rowRect.top - hostTop) + 'px';
        label.style.height = Math.max(12, rowRect.height || styleNumber(row, 'height', 18)) + 'px';
        label.textContent = String(line.label || '');
        label.title = String(line.tooltip || line.label || '');
        label.setAttribute('data-tooltip', label.title);
        label.setAttribute('aria-label', label.title);
        label.setAttribute('data-gsc-line', String(line.line || ''));
        layer.appendChild(label);
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
        ensureStyle();
        observeMargin(margin);
        var layout = editor.getLayoutInfo();
        var layer = ensureLayer(host, Number(layout.contentLeft || 0) - state.extraWidth, state.extraWidth);
        layer.textContent = '';
        var hostTop = host.getBoundingClientRect().top;
        var lineMap = makeLineMap(snapshot);
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
        state.lastPaint = 'paint:native:' + placed + '/' + lineMap.size + ':width=' + state.extraWidth;
        return state.lastPaint;
      }
      function teardown() {
        state.snapshot = null;
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
          state.snapshot = snapshot;
          state.lastPaint = '';
          var configured = configureEditor(snapshot);
          if (!/^configured:/.test(configured)) {
            cleanupDom();
            return configured;
          }
          ensureStyle();
          schedulePaint();
          scheduleFollowUpPaints();
          return new Promise(function (resolve) {
            setTimeout(function () {
              var result = state.lastPaint || paint();
              resolve('render-scheduled:' + configured + ':' + result);
            }, 90);
          });
        }
      };
      return 'gsc-native-blame-installed:' + VERSION;
    })()
  `;
}
