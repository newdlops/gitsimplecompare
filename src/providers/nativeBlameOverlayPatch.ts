// line-by-line blame을 VS Code editor 본문이 아닌 네이티브 거터에 그리는 renderer patch 조립 모듈.
// - main process CDP는 대상 Monaco editor instance를 찾고 renderer patch에 연결한다.
// - renderer는 Monaco의 lineDecorationsWidth를 늘린 뒤 margin row와 같은 top에 label을 배치한다.
import type { BlockBlameGutterSnapshot } from "../ui/blockBlameGutter";
import type { BlameHoverResponse } from "./blameHoverProtocol";
import {
  mainEvalExpression,
  rendererEvalExpression,
  type NativeOverlayWorkspaceHints,
} from "./nativeDiffOverlayMain";

import { NATIVE_BLAME_PATCH_VERSION as PATCH_VERSION } from "./nativeBlameOverlayRenderer";
export { nativeBlameOverlayRendererScript } from "./nativeBlameOverlayRenderer";
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
 * 상세 응답만 기존 popup에 적용한다. editor/heap 재탐색이나 gutter snapshot 교체를 수행하지 않는다.
 * @param response 원래 hover 요청의 식별자를 유지한 상세/오류/복사 결과, hints 소유 workbench 창
 * @returns 공용 CDP 연결에서 실행할 main process expression
 */
export function blameOverlayHoverResponseExpression(response: BlameHoverResponse, hints: NativeOverlayWorkspaceHints): string {
  const expression = `(function(){var overlay=window.__gscNativeBlameOverlay;return overlay&&overlay.updateHover?overlay.updateHover(${JSON.stringify(response)}):"blame-hover-unavailable";})()`;
  return mainEvalExpression(RENDERER_BINDING, hints, `
    var out = [];
    for (var i = 0; i < wins.length; i++) out.push(await evalWindow(wins[i], ${JSON.stringify(expression)}));
    return out.join('|');
  `);
}

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
    try { return item && typeof item.updateOptions === 'function' && typeof item.getLayoutInfo === 'function' && modelUri(item) === uri && visible(item); }
    catch (_) { return false; }
  });
  var item = matches.filter(function (candidate) {
    try { return candidate.getDomNode().classList.contains('focused'); } catch (_) { return false; }
  })[0] || matches[0];
  if (!item) return 'editor-not-found:' + uri;
  window.__gscNativeBlameEditor = item;
  window.__gscNativeBlameEditorConstructor = item.constructor;
  try {
    if (typeof WeakRef === 'function') {
      window.__gscNativeBlameEditorRef = new WeakRef(item);
      var service = item._codeEditorService;
      if (service && typeof service.listCodeEditors === 'function') {
        window.__gscNativeBlameEditorServiceRef = new WeakRef(service);
      }
    }
  } catch (_) {}
  return 'editor-bound:' + uri;
}`;

/**
 * Monaco 이벤트의 receiver/closure에서 이미 살아 있는 editor 또는 editor service를 찾는다.
 * @param uri snapshot의 정확한 모델 URI. 나머지 인자는 CDP가 읽은 실제 객체 참조다.
 * @returns 보이고 URI가 맞는 editor만 바인딩하며, 찾지 못하면 기존 heap 탐색으로 넘길 상태
 */
const BIND_EDITOR_OWNERS_FUNCTION = `function (uri) {
  var items = [];
  for (var index = 1; index < arguments.length; index++) {
    var owner = arguments[index];
    if (!owner) continue;
    try {
      items.push(owner, owner._editor, owner._codeEditor);
      var service = typeof owner.listCodeEditors === 'function' ? owner : owner._codeEditorService;
      if (service && typeof service.listCodeEditors === 'function') items = items.concat(service.listCodeEditors());
    } catch (_) {}
  }
  return (${BIND_EDITOR_FUNCTION}).call(items, uri);
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
      var discoveryStats;

      async function remoteProperties(debuggerApi, objectId) {
        discoveryStats.calls++;
        return debuggerApi.sendCommand('Runtime.getProperties', {
          objectId: objectId,
          ownProperties: true,
          accessorPropertiesOnly: false,
          generatePreview: false
        });
      }
      async function remoteValue(debuggerApi, expression) {
        discoveryStats.calls++;
        return debuggerApi.sendCommand('Runtime.evaluate', {
          expression: expression,
          includeCommandLineAPI: true,
          returnByValue: true,
          awaitPromise: true,
          objectGroup: ${JSON.stringify(REMOTE_OBJECT_GROUP)}
        });
      }
      async function remoteObject(debuggerApi, expression) {
        discoveryStats.calls++;
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
        discoveryStats.calls++;
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
        discoveryStats.calls++; discoveryStats.heapQueries++; discoveryStats.source = 'heap';
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
        // 최초 탐색에서 얻은 editor service의 목록을 재사용해 다른 탭에서도 heap query를 생략한다.
        // 내부 service를 제공하지 않는 VS Code 버전은 기존 constructor 탐색으로 안전하게 돌아간다.
        var expression = '(function(uri){var items=[];try{var service=window.__gscNativeBlameEditorServiceRef&&window.__gscNativeBlameEditorServiceRef.deref();if(service&&typeof service.listCodeEditors==="function")items=service.listCodeEditors();if(window.__gscNativeBlameEditor)items=items.concat([window.__gscNativeBlameEditor]);if(window.__gscNativeBlameEditorRef)items=items.concat([window.__gscNativeBlameEditorRef.deref()]);}catch(_){}return (' + ${JSON.stringify(BIND_EDITOR_FUNCTION)} + ').call(items,uri);})(' + JSON.stringify(snapshot.uri) + ')';
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
      /** CDP 연결에서 대상 DOM의 listener 함수를 한 번에 수집해 함수 objectId 목록을 반환한다. */
      async function listenerFunctions(debuggerApi) {
        var listeners = await remoteObject(
          debuggerApi,
          '(function(){var node=document.querySelector(".monaco-editor.focused")||Array.prototype.slice.call(document.querySelectorAll(".monaco-editor")).filter(function(node){return node&&node.isConnected&&node.offsetParent!==null&&node.clientWidth>0&&node.clientHeight>0;})[0];if(!node)return [];var groups=getEventListeners(node),seen=new Set(),items=[],preferred=["keydown","mousedown","pointerdown","contextmenu","focusin","focus","keyup"];var keys=preferred.concat(Object.keys(groups).filter(function(key){return preferred.indexOf(key)<0;}));keys.forEach(function(key){(groups[key]||[]).forEach(function(item){if(typeof item.listener==="function"&&!seen.has(item.listener)){seen.add(item.listener);items.push(item.listener);}});});return items;})()'
        );
        var listenersId = listeners && listeners.result && listeners.result.objectId;
        if (!listenersId) return [];
        var properties = await remoteProperties(debuggerApi, listenersId);
        return ((properties && properties.result) || []).filter(function(property){
          return /^\\d+$/.test(property.name || '') && property.value && property.value.type === 'function' && property.value.objectId;
        }).map(function(property){return property.value.objectId;});
      }
      /** listenerId를 호출 경계로 사용해 후보 객체를 한 번에 검사하며, 살아 있는 대상 editor를 찾았으면 true다. */
      async function bindListenerOwners(debuggerApi, listenerId, candidates) {
        if (!candidates.length) return false;
        discoveryStats.calls++;
        var response = await debuggerApi.sendCommand('Runtime.callFunctionOn', {
          objectId: listenerId,
          functionDeclaration: ${JSON.stringify(BIND_EDITOR_OWNERS_FUNCTION)},
          arguments: [{value:snapshot.uri}].concat(candidates.map(function(id){return {objectId:id};})),
          returnByValue: true,
          objectGroup: ${JSON.stringify(REMOTE_OBJECT_GROUP)}
        });
        if (!/^editor-bound:/.test(String(resultValue(response) || ''))) return false;
        discoveryStats.source = 'listener-owner';
        return true;
      }
      /** bound receiver와 작은 closure를 먼저 읽고, 없으면 기존 heap 탐색에 필요한 module objectId를 반환한다. */
      async function discoverFromListeners(debuggerApi) {
        var listeners = await listenerFunctions(debuggerApi), modules = [];
        for (var index = 0; index < listeners.length; index++) {
          if (index >= 8 && modules.length) break;
          var listenerId = listeners[index];
          var info = await remoteProperties(debuggerApi, listenerId);
          var internals = (info && info.internalProperties) || [];
          var bound = internals.filter(function(value){return value.name === '[[BoundThis]]' && value.value && value.value.objectId;});
          if (index < 8 && await bindListenerOwners(debuggerApi, listenerId, bound.map(function(value){return value.value.objectId;}))) return {bound:true,modules:modules};
          var scopes = internals.filter(function(value){return value.name === '[[Scopes]]' && value.value && value.value.objectId;})[0];
          if (!scopes) continue;
          var scopeList = await remoteProperties(debuggerApi, scopes.value.objectId);
          var properties = (scopeList && scopeList.result) || [], inspected = 0;
          for (var scopeIndex = 0; scopeIndex < properties.length; scopeIndex++) {
            var scope = properties[scopeIndex].value;
            if (!scope || !scope.objectId) continue;
            if (scope.description === 'Module') {
              if (modules.indexOf(scope.objectId) < 0) modules.push(scope.objectId);
              continue;
            }
            if (index >= 8 || !/^(Closure|Local|Block)(?: |$)/.test(scope.description || '') || inspected++ >= 3) continue;
            var values = await remoteProperties(debuggerApi, scope.objectId);
            var candidates = ((values && values.result) || []).filter(function(value){return value.value && value.value.type === 'object' && value.value.objectId;})
              .slice(0, 12).map(function(value){return value.value.objectId;});
            if (await bindListenerOwners(debuggerApi, listenerId, candidates)) return {bound:true,modules:modules};
          }
        }
        return {bound:false,modules:modules};
      }
      async function discoverEditor(debuggerApi) {
        var found = await discoverFromListeners(debuggerApi);
        if (found.bound) return 'editor-bound:' + snapshot.uri;
        if (!found.modules.length) return 'editor-module-scope-missing';
        for (var moduleIndex = 0; moduleIndex < found.modules.length; moduleIndex++) {
          var moduleScopeId = found.modules[moduleIndex];
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
        }
        return 'editor-constructor-missing';
      }
      async function prepareBlameEditor(w) {
        var debuggerApi = await ensureWindow(w);
        try {
          var cached = await cachedEditor(debuggerApi);
          if (/^editor-bound:/.test(cached)) return cached.replace('editor-bound:', 'editor-cached:');
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
        discoveryStats = {calls:0,heapQueries:0,source:'editor-cache'};
        var startedAt = Date.now();
        var installed = await evalWindow(wins[i], installExpr);
        var prepared = await prepareBlameEditor(wins[i]);
        var discoveryMs = Date.now() - startedAt;
        if (!/^editor-(?:cached|bound):/.test(prepared)) {
          out.push(installed + ',err:' + wins[i].id + ':' + prepared + ',discoveryCalls=' + discoveryStats.calls + ',heapQueries=' + discoveryStats.heapQueries + ',discoveryMs=' + discoveryMs);
          continue;
        }
        var renderExpr = 'window.__gscNativeBlameOverlay&&window.__gscNativeBlameOverlay.render(' + JSON.stringify(snapshot) + ')';
        var rendered = await evalWindow(wins[i], renderExpr);
        out.push(installed + ',' + prepared + ',' + rendered + ',discoverySource=' + discoveryStats.source + ',discoveryCalls=' + discoveryStats.calls + ',heapQueries=' + discoveryStats.heapQueries + ',discoveryMs=' + discoveryMs + ',durationMs=' + (Date.now() - startedAt));
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
      var cleanupExpr = '(function(){if(window.__gscNativeBlameOverlay)return window.__gscNativeBlameOverlay.render(null);document.querySelectorAll(".gsc-native-blame-layer,.gsc-native-blame-row,.gsc-native-blame-hover").forEach(function(node){node.remove();});var style=document.getElementById("gsc-native-blame-style");if(style)style.remove();return "cleaned-fallback";})()';
      for (var i = 0; i < wins.length; i++) {
        out.push(await evalWindow(wins[i], cleanupExpr));
      }
      return out.join('|');
    `
  );
}
