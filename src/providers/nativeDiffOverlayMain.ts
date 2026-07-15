// native diff overlay 를 VS Code main process 에서 renderer 로 주입하는 expression 유틸.
// - renderer DOM 패치와 main process window 선택 책임을 분리해 overlay script 본문을 작게 유지한다.

export interface NativeOverlayWorkspaceHints {
  paths: string[];
  names: string[];
  windowId?: number;
}

/**
 * main process 에서 target workbench windows 를 고른 뒤 body 를 실행하는 expression 을 만든다.
 * @param binding renderer checkbox click 을 extension host 로 전달할 CDP binding 이름
 * @param hints 대상 VS Code window 를 고르기 위한 workspace 경로/이름 힌트
 * @param body target window 목록과 helper 함수가 준비된 뒤 실행할 JavaScript 본문
 * @returns CDP Runtime.evaluate 에 전달할 main process JavaScript expression
 */
export function mainEvalExpression(
  binding: string,
  hints: NativeOverlayWorkspaceHints,
  body: string
): string {
  return `
    (async function () {
      var req = typeof require === 'function'
        ? require
        : (process && process.mainModule && typeof process.mainModule.require === 'function'
          ? process.mainModule.require.bind(process.mainModule)
          : undefined);
      if (!req) return 'no-require';
      var BW = req('electron').BrowserWindow;
      var workspacePaths = ${JSON.stringify(hints.paths)};
      var workspaceNames = ${JSON.stringify(hints.names)};
      var pinnedWindowId = ${JSON.stringify(hints.windowId ?? 0)};
      var wins = chooseWindows(BW.getAllWindows());
      if (!wins.length) return 'no-target-window';

      function windowTitle(w) { try { return String((w.getTitle && w.getTitle()) || ''); } catch (_) { return ''; } }
      function windowUrl(w) { try { return String((w.webContents && w.webContents.getURL && w.webContents.getURL()) || ''); } catch (_) { return ''; } }
      function isCandidate(w) {
        try {
          if (!w || (w.isDestroyed && w.isDestroyed())) return false;
          if (!w.webContents || (w.webContents.isDestroyed && w.webContents.isDestroyed())) return false;
          var title = windowTitle(w);
          var url = windowUrl(w);
          if (/Developer Tools/i.test(title) || /devtools:/i.test(url)) return false;
          return /workbench\\.(?:esm\\.)?html|vscode-app:|vscode-file:/i.test(url) || /Visual Studio Code|Extension Development Host/i.test(title);
        } catch (_) {
          return false;
        }
      }
      function matchesWorkspace(w) {
        var title = windowTitle(w);
        var url = windowUrl(w);
        for (var i = 0; i < workspacePaths.length; i++) {
          var p = workspacePaths[i];
          if (p && (url.indexOf(p) >= 0 || url.indexOf(encodeURIComponent(p)) >= 0)) return true;
        }
        for (var n = 0; n < workspaceNames.length; n++) {
          var name = workspaceNames[n];
          if (name && title.indexOf(name) >= 0) return true;
        }
        return false;
      }
      function chooseWindows(all) {
        var candidates = all.filter(isCandidate);
        if (pinnedWindowId) {
          var pinned = candidates.filter(function (w) { return w.id === pinnedWindowId; });
          return pinned.length ? [pinned[0]] : [];
        }
        var focused = candidates.filter(function (w) { try { return w.isFocused && w.isFocused(); } catch (_) { return false; } });
        var focusedMatched = focused.filter(matchesWorkspace);
        if (focusedMatched.length) return [focusedMatched[0]];
        if (focused.length) return [focused[0]];
        return [];
      }
      async function ensureWindow(w) {
        var debuggerApi = w.webContents.debugger;
        if (!global.__gscNativeDiffOverlayListeners) global.__gscNativeDiffOverlayListeners = new Map();
        if (!global.__gscNativeDiffOverlayReadyWindows) global.__gscNativeDiffOverlayReadyWindows = new Set();
        var previous = global.__gscNativeDiffOverlayListeners.get(w.id);
        var attached = false;
        try { attached = debuggerApi.isAttached(); } catch (_) {}
        if (attached && previous && global.__gscNativeDiffOverlayReadyWindows.has(w.id)) return debuggerApi;
        if (!attached) {
          debuggerApi.attach('1.3');
          if (!global.__gscNativeDiffOverlayOwnedDebuggers) global.__gscNativeDiffOverlayOwnedDebuggers = new Set();
          global.__gscNativeDiffOverlayOwnedDebuggers.add(w.id);
        }
        await debuggerApi.sendCommand('Runtime.enable');
        try {
          await debuggerApi.sendCommand('Runtime.addBinding', { name: ${JSON.stringify(binding)} });
        } catch (error) {
          if (!/already|exists|duplicate/i.test(String(error && (error.message || error)))) throw error;
        }
        if (previous) {
          try { debuggerApi.removeListener('message', previous); } catch (_) {}
        }
        var bridge = function (_event, method, params) {
          if (method === 'Runtime.bindingCalled' && params && params.name === ${JSON.stringify(binding)}) {
            try {
              if (typeof global.${"gscNativeDiffOverlayEvent"} === 'function') {
                global.${"gscNativeDiffOverlayEvent"}(String(params.payload || ''));
              }
            } catch (_) {}
          }
        };
        debuggerApi.on('message', bridge);
        global.__gscNativeDiffOverlayListeners.set(w.id, bridge);
        global.__gscNativeDiffOverlayReadyWindows.add(w.id);
        return debuggerApi;
      }
      function releaseWindow(w) {
        try {
          var debuggerApi = w.webContents.debugger;
          var listeners = global.__gscNativeDiffOverlayListeners;
          var bridge = listeners && listeners.get(w.id);
          if (bridge) debuggerApi.removeListener('message', bridge);
          if (listeners) listeners.delete(w.id);
          var ready = global.__gscNativeDiffOverlayReadyWindows;
          if (ready) ready.delete(w.id);
          var owned = global.__gscNativeDiffOverlayOwnedDebuggers;
          if (owned && owned.has(w.id)) {
            owned.delete(w.id);
            if (debuggerApi.isAttached()) debuggerApi.detach();
          }
          return 'released:' + w.id;
        } catch (error) {
          return 'release-err:' + w.id + ':' + String(error && (error.message || error)).slice(0, 300);
        }
      }
      async function evalWindow(w, expression) {
        try {
          var debuggerApi = await ensureWindow(w);
          var result = await debuggerApi.sendCommand('Runtime.evaluate', {
            expression: expression,
            includeCommandLineAPI: true,
            returnByValue: true,
            awaitPromise: true
          });
          return 'ok:' + w.id + ':' + String(result && result.result && result.result.value || '').slice(0, 2000);
        } catch (error) {
          return 'err:' + (w && w.id) + ':' + String(error && (error.message || error)).slice(0, 500);
        }
      }
      async function patchWindow(w, rendererEval, renderExpr) {
        var first = await evalWindow(w, rendererEval);
        var second = await evalWindow(w, renderExpr);
        return first + ',' + second;
      }
      ${body}
    })()
  `;
}

/** renderer cleanup이 끝난 창의 debugger bridge/listener를 main process에서 해제한다. */
export function overlayBridgeReleaseExpression(
  hints: NativeOverlayWorkspaceHints
): string {
  return mainEvalExpression(
    "gscNativeDiffOverlayEvent",
    hints,
    `
      var out = [];
      for (var i = 0; i < wins.length; i++) out.push(releaseWindow(wins[i]));
      return out.join('|');
    `
  );
}

/**
 * renderer script 를 CDP Runtime.evaluate 하나로 안전하게 넘길 수 있게 감싼다.
 * @param script renderer 에서 eval 할 JavaScript 소스
 * @returns UTF-8/base64 디코딩 뒤 eval 하는 짧은 JavaScript expression
 */
export function rendererEvalExpression(script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `(function(){var bin=atob(${JSON.stringify(encoded)});var bytes=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++){bytes[i]=bin.charCodeAt(i);}return eval(new TextDecoder('utf-8').decode(bytes));})()`;
}
