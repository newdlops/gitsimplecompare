// line-by-line blame을 VS Code editor 본문이 아닌 네이티브 거터에 그리는 renderer patch 조립 모듈.
// - main process CDP는 대상 Monaco editor instance를 찾고 renderer patch에 연결한다.
// - renderer는 Monaco의 lineDecorationsWidth를 늘린 뒤 margin row와 같은 top에 label을 배치한다.
import type { BlockBlameGutterSnapshot } from "../ui/blockBlameGutter";
import type { BlameHoverResponse } from "./blameHoverProtocol";
import { nativeBlameEditorCaptureFunction } from "./nativeBlameEditorCapture";
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
  var items = [], queue = [], seen = new Set();
  for (var index = 1; index < arguments.length; index++) {
    if (arguments[index]) queue.push({value:arguments[index],depth:0});
  }
  var links = ['_editor','_codeEditor','_codeEditorService','_context','_view','_viewController','_controller',
    '_instantiationService','_parent','_services','_entries','_viewModel','viewModel'];
  for (var next = 0; next < queue.length && next < 256; next++) {
    var current = queue[next], owner = current.value;
    if (!owner || (typeof owner !== 'object' && typeof owner !== 'function') || seen.has(owner)) continue;
    seen.add(owner); items.push(owner);
    try {
      if (typeof owner.listCodeEditors === 'function') items = items.concat(owner.listCodeEditors());
      if (current.depth >= 6) continue;
      for (var link = 0; link < links.length && queue.length < 256; link++) {
        var descriptor = Object.getOwnPropertyDescriptor(owner, links[link]);
        if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') && descriptor.value) {
          queue.push({value:descriptor.value,depth:current.depth+1});
        }
      }
      if (owner instanceof Map) {
        var values = Map.prototype.values.call(owner), value;
        while (queue.length < 256 && !(value = values.next()).done) queue.push({value:value.value,depth:current.depth+1});
      }
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
  return blameOverlayExpression(rendererScript, snapshot, hints);
}

/**
 * Code Vision이 준비되는 동안 편집기 참조만 미리 찾는다. 거터 DOM과 editor 옵션은 변경하지 않는다.
 * @param uri 정확한 대상 파일 URI, hints 현재 확장 창의 workspace 식별 정보
 * @returns 실제 클릭이 재사용할 편집기/service 약한 참조를 준비하는 main expression
 */
export function blameOverlayPreparationExpression(uri: string, hints: NativeOverlayWorkspaceHints): string {
  return blameOverlayExpression(undefined, { uri }, hints);
}

/**
 * Code Vision 갱신에서 관찰한 editor를 확인하고 임시 상태와 가능한 강한 editor 참조를 해제한다.
 * @param uri 준비를 요청한 정확한 모델 URI, hints 준비 당시 선택한 workbench 창
 * @returns capture 완료를 기다린 뒤 URI/가시성 검증 결과를 돌려주는 main expression
 */
export function blameOverlayPreparationCompletionExpression(uri: string, hints: NativeOverlayWorkspaceHints): string {
  const expression = `(async function(uri){var state=window.__gscNativeBlameEditorCapture;if(state&&state.uri===uri){await state.ready;if(window.__gscNativeBlameEditorCapture===state)delete window.__gscNativeBlameEditorCapture;}var editor=window.__gscNativeBlameEditor||(window.__gscNativeBlameEditorRef&&window.__gscNativeBlameEditorRef.deref());var bound=(${BIND_EDITOR_FUNCTION}).call([editor],uri);if(!/^editor-bound:/.test(bound))return 'blame-editor-not-observed';if(window.__gscNativeBlameEditorRef)delete window.__gscNativeBlameEditor;return 'blame-editor-prepared,'+bound;})(${JSON.stringify(uri)})`;
  return mainEvalExpression(RENDERER_BINDING, hints, `var out=[];for(var i=0;i<wins.length;i++)out.push(await evalWindow(wins[i],${JSON.stringify(expression)}));return out.join('|');`);
}

/** 표시 요청과 선행 준비가 같은 URI 검증·탐색·임시 객체 해제를 공유하도록 expression을 조립한다. */
function blameOverlayExpression(
  rendererScript: string | undefined, snapshot: Pick<BlockBlameGutterSnapshot, "uri">, hints: NativeOverlayWorkspaceHints
): string {
  const preparationOnly = rendererScript === undefined;
  const rendererEval = preparationOnly ? "" : rendererEvalExpression(rendererScript);
  const snapshotJson = JSON.stringify(snapshot);
  return mainEvalExpression(
    RENDERER_BINDING,
    hints,
    `
      var rendererEval = ${JSON.stringify(rendererEval)};
      var snapshot = ${snapshotJson};
      var preparationOnly = ${preparationOnly};
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
        if (preparationOnly) {
          discoveryStats.calls++;
          var observed = await debuggerApi.sendCommand('Runtime.callFunctionOn', {
            objectId: prototypeObjectId,
            functionDeclaration: ${JSON.stringify(nativeBlameEditorCaptureFunction(BIND_EDITOR_FUNCTION))},
            arguments: [{value:snapshot.uri}], returnByValue:true,
            objectGroup: ${JSON.stringify(REMOTE_OBJECT_GROUP)}
          });
          var observation = String(resultValue(observed) || 'editor-observer-empty');
          if (/^editor-observing:/.test(observation)) { discoveryStats.source = 'method-observer'; return observation; }
        }
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
          // 선행 준비는 editor를 호출하지 않는 prototype 관찰을 바로 설치해 opaque listener의 반복 조회를 줄인다.
          if (preparationOnly) {
            var moduleScope = properties.filter(function(property){return property.value && property.value.description === 'Module';})[0];
            if (moduleScope && moduleScope.value.objectId) {
              var observation = await bindFromModule(debuggerApi, moduleScope.value.objectId);
              if (/^editor-(?:bound|observing):/.test(observation)) return {bound:true,binding:observation,modules:modules};
            }
          }
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
        if (found.bound) return found.binding || 'editor-bound:' + snapshot.uri;
        if (!found.modules.length) return 'editor-module-scope-missing';
        for (var moduleIndex = 0; moduleIndex < found.modules.length; moduleIndex++) {
          var binding = await bindFromModule(debuggerApi, found.modules[moduleIndex]);
          if (/^editor-(?:bound|observing):/.test(binding)) return binding;
        }
        return 'editor-constructor-missing';
      }
      async function bindFromModule(debuggerApi, moduleScopeId) {
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
          if (/^editor-(?:bound|observing):/.test(bound)) return bound;
        }
        return 'editor-constructor-missing';
      }
      async function prepareBlameEditor(w) {
        var debuggerApi = await ensureWindow(w);
        try {
          var cached = await cachedEditor(debuggerApi);
          if (/^editor-bound:/.test(cached)) return cached.replace('editor-bound:', 'editor-cached:');
          var constructorBound = await cachedConstructor(debuggerApi);
          if (/^editor-(?:bound|observing):/.test(constructorBound)) return constructorBound;
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
        var installed = preparationOnly ? 'blame-editor-preparing' : await evalWindow(wins[i], installExpr);
        var prepared = await prepareBlameEditor(wins[i]);
        var discoveryMs = Date.now() - startedAt;
        if (!/^editor-(?:cached|bound|observing):/.test(prepared)) {
          out.push(installed + ',err:' + wins[i].id + ':' + prepared + ',discoveryCalls=' + discoveryStats.calls + ',heapQueries=' + discoveryStats.heapQueries + ',discoveryMs=' + discoveryMs);
          continue;
        }
        if (preparationOnly) {
          if (/^editor-observing:/.test(prepared)) {
            out.push('ok:' + wins[i].id + ':blame-editor-observing,discoverySource=' + discoveryStats.source
              + ',discoveryCalls=' + discoveryStats.calls + ',heapQueries=' + discoveryStats.heapQueries + ',discoveryMs=' + discoveryMs);
            continue;
          }
          // 살아 있는 editor/service는 WeakRef로만 보관하고 표시 전에는 강한 editor 참조도 남기지 않는다.
          await evalWindow(wins[i], '(function(){if(window.__gscNativeBlameEditorRef)delete window.__gscNativeBlameEditor;return "blame-editor-prepared";})()');
          out.push('ok:' + wins[i].id + ':blame-editor-prepared,' + prepared + ',discoverySource=' + discoveryStats.source
            + ',discoveryCalls=' + discoveryStats.calls + ',heapQueries=' + discoveryStats.heapQueries + ',discoveryMs=' + discoveryMs);
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
