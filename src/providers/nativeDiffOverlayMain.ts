// native diff overlay 를 VS Code main process 에서 renderer 로 주입하는 expression 유틸.
// - renderer DOM 패치와 main process window 선택 책임을 분리해 overlay script 본문을 작게 유지한다.

export interface NativeOverlayWorkspaceHints {
  paths: string[];
  names: string[];
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
        var matched = candidates.filter(matchesWorkspace);
        var focused = candidates.filter(function (w) { try { return w.isFocused && w.isFocused(); } catch (_) { return false; } });
        var focusedMatched = focused.filter(matchesWorkspace);
        if (focusedMatched.length) return [focusedMatched[0]];
        if (matched.length) return [matched[0]];
        if (focused.length) return [focused[0]];
        return candidates.length ? [candidates[0]] : [];
      }
      async function ensureWindow(w) {
        var debuggerApi = w.webContents.debugger;
        var attached = false;
        try { attached = debuggerApi.isAttached(); } catch (_) {}
        if (!attached) debuggerApi.attach('1.3');
        await debuggerApi.sendCommand('Runtime.enable');
        try { await debuggerApi.sendCommand('Runtime.addBinding', { name: ${JSON.stringify(binding)} }); } catch (_) {}
        if (!global.__gscNativeDiffOverlayListeners) global.__gscNativeDiffOverlayListeners = new Map();
        var previous = global.__gscNativeDiffOverlayListeners.get(w.id);
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
        return debuggerApi;
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

/**
 * renderer script 를 CDP Runtime.evaluate 하나로 안전하게 넘길 수 있게 감싼다.
 * @param script renderer 에서 eval 할 JavaScript 소스
 * @returns UTF-8/base64 디코딩 뒤 eval 하는 짧은 JavaScript expression
 */
export function rendererEvalExpression(script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `(function(){var bin=atob(${JSON.stringify(encoded)});var bytes=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++){bytes[i]=bin.charCodeAt(i);}return eval(new TextDecoder('utf-8').decode(bytes));})()`;
}
