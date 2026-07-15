// workbench renderer에 주입할 native conflict context overlay script 조립 모듈.
// - 실제 Result 편집은 VS Code Monaco가 소유하고, 이 patch는 commit 흐름과 whole-file action만 겹쳐 그린다.
import type { ConflictOverlaySnapshot } from "./conflictOverlayProtocol";
import {
  mainEvalExpression,
  rendererEvalExpression,
  type NativeOverlayWorkspaceHints,
} from "./nativeDiffOverlayMain";

const PATCH_VERSION = 2;
const RENDERER_BINDING = "gscNativeDiffOverlayToggle";

/** conflict renderer patch 설치와 snapshot render를 한 main-process expression으로 만든다. */
export function conflictOverlayInjectionExpression(
  rendererScript: string,
  snapshot: ConflictOverlaySnapshot,
  hints: NativeOverlayWorkspaceHints
): string {
  const rendererEval = rendererEvalExpression(rendererScript);
  const snapshotJson = JSON.stringify(snapshot);
  return mainEvalExpression(
    RENDERER_BINDING,
    hints,
    `
      var rendererEval = ${JSON.stringify(rendererEval)};
      var installExpr = '(window.__gscNativeConflictOverlay&&window.__gscNativeConflictOverlay.version===' + ${PATCH_VERSION} + ')?"gsc-native-conflict-installed:${PATCH_VERSION}:cached":' + rendererEval;
      var snapshot = ${snapshotJson};
      var renderExpr = 'window.__gscNativeConflictOverlay&&window.__gscNativeConflictOverlay.render(' + JSON.stringify(snapshot) + ')';
      var out = [];
      for (var i = 0; i < wins.length; i++) {
        out.push(await patchWindow(wins[i], installExpr, renderExpr));
      }
      return out.join('|');
    `
  );
}

/** renderer에 남아 있는 conflict context overlay만 제거한다. */
export function conflictOverlayCleanupExpression(
  hints: NativeOverlayWorkspaceHints
): string {
  return mainEvalExpression(
    RENDERER_BINDING,
    hints,
    `
      var out = [];
      var cleanupExpr = 'window.__gscNativeConflictOverlay&&window.__gscNativeConflictOverlay.render(null)';
      for (var i = 0; i < wins.length; i++) {
        out.push(await evalWindow(wins[i], cleanupExpr));
      }
      return out.join('|');
    `
  );
}

/** Workbench의 active native editor 우측 상단에 상주하는 context card patch 본문이다. */
export function nativeConflictOverlayRendererScript(): string {
  return `
    (function () {
      var VERSION = ${PATCH_VERSION};
      var BINDING = ${JSON.stringify(RENDERER_BINDING)};
      var STYLE_ID = 'gsc-native-conflict-overlay-style';
      var ROOT_CLASS = 'gsc-native-conflict-overlay';
      var previousState = window.__gscNativeConflictOverlayState;
      if (previousState && previousState.version !== VERSION) {
        try { if (previousState.observer) previousState.observer.disconnect(); } catch (_) {}
        try { if (previousState.frame) cancelAnimationFrame(previousState.frame); } catch (_) {}
        (previousState.timers || []).forEach(function (timer) { try { clearTimeout(timer); } catch (_) {} });
        Array.prototype.slice.call(document.querySelectorAll('.' + ROOT_CLASS)).forEach(function (node) { try { node.remove(); } catch (_) {} });
        Array.prototype.slice.call(document.querySelectorAll('[data-gsc-conflict-relative="true"]')).forEach(function (node) {
          try {
            node.style.removeProperty('position');
            node.removeAttribute('data-gsc-conflict-relative');
          } catch (_) {}
        });
        var oldStyle = document.getElementById(STYLE_ID);
        if (oldStyle) { try { oldStyle.remove(); } catch (_) {} }
      }
      var state = previousState && previousState.version === VERSION ? previousState : {
        version: VERSION,
        snapshot: null,
        collapsed: false,
        frame: 0,
        observer: null,
        timers: [],
        generation: 0,
        lastPaint: 'paint:none'
      };
      window.__gscNativeConflictOverlayState = state;

      function ensureStyle() {
        var style = document.getElementById(STYLE_ID);
        if (style && style.getAttribute('data-gsc-version') === String(VERSION)) return;
        if (!style) style = document.createElement('style');
        style.id = STYLE_ID;
        style.setAttribute('data-gsc-version', String(VERSION));
        style.textContent = [
          '.gsc-native-conflict-overlay{position:absolute;top:8px;right:20px;z-index:420;width:min(760px,calc(100% - 44px));max-height:min(calc(100% - 16px),520px);display:flex;flex-direction:column;overflow:hidden;overscroll-behavior:contain;color:var(--vscode-editorWidget-foreground,var(--vscode-foreground));background:var(--vscode-editorWidget-background,var(--vscode-editor-background));border:1px solid var(--vscode-editorWidget-border,var(--vscode-widget-border,var(--vscode-contrastBorder,transparent)));border-radius:7px;box-shadow:0 6px 22px rgba(0,0,0,.28);font-family:var(--vscode-font-family);font-size:12px;line-height:1.35;pointer-events:auto;contain:layout paint;isolation:isolate;}',
          '.gsc-native-conflict-overlay *{box-sizing:border-box;}',
          '.gsc-native-conflict-header{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-bottom:1px solid var(--vscode-editorWidget-border,var(--vscode-widget-border,transparent));background:var(--vscode-sideBarSectionHeader-background,transparent);}',
          '.gsc-native-conflict-heading{min-width:0;flex:1;}',
          '.gsc-native-conflict-title{margin:0;font:inherit;font-weight:600;color:var(--vscode-editorWidget-foreground,var(--vscode-foreground));}',
          '.gsc-native-conflict-path{margin-top:2px;color:var(--vscode-descriptionForeground);white-space:normal;overflow-wrap:anywhere;word-break:break-word;}',
          '.gsc-native-conflict-badge{flex:0 0 auto;max-width:45%;padding:2px 7px;border-radius:999px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);white-space:normal;overflow-wrap:anywhere;text-align:center;}',
          '.gsc-native-conflict-icon-button{flex:0 0 auto;width:26px;height:24px;padding:0;border:0;border-radius:4px;color:var(--vscode-icon-foreground,var(--vscode-foreground));background:transparent;cursor:pointer;}',
          '.gsc-native-conflict-icon-button:hover{background:var(--vscode-toolbar-hoverBackground);}',
          '.gsc-native-conflict-icon-button:focus-visible,.gsc-native-conflict-action:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px;}',
          '.gsc-native-conflict-body{min-height:0;overflow:auto;overscroll-behavior:contain;padding:9px 10px 10px;}',
          '.gsc-native-conflict-overlay.is-collapsed{width:min(520px,calc(100% - 44px));max-height:none;}',
          '.gsc-native-conflict-overlay.is-collapsed .gsc-native-conflict-body{display:none;}',
          '.gsc-native-conflict-meta{display:flex;flex-wrap:wrap;gap:5px 12px;margin-bottom:8px;color:var(--vscode-descriptionForeground);}',
          '.gsc-native-conflict-meta-item{white-space:normal;overflow-wrap:anywhere;}',
          '.gsc-native-conflict-flow{display:grid;grid-template-columns:repeat(4,minmax(135px,1fr));gap:7px;align-items:stretch;}',
          '.gsc-native-conflict-card{min-width:0;padding:8px;border:1px solid var(--vscode-editorWidget-border,var(--vscode-widget-border,transparent));border-radius:5px;background:var(--vscode-editor-background);}',
          '.gsc-native-conflict-card.current{border-top:2px solid var(--vscode-gitDecoration-modifiedResourceForeground,#3794ff);}',
          '.gsc-native-conflict-card.incoming{border-top:2px solid var(--vscode-gitDecoration-addedResourceForeground,#2ea043);}',
          '.gsc-native-conflict-card.result{border-top:2px solid var(--vscode-focusBorder);}',
          '.gsc-native-conflict-card.future{border-top:2px solid var(--vscode-editorWarning-foreground,#cca700);}',
          '.gsc-native-conflict-card-title{font-weight:600;white-space:normal;overflow-wrap:anywhere;}',
          '.gsc-native-conflict-card-identity{margin-top:4px;color:var(--vscode-textLink-foreground);white-space:normal;overflow-wrap:anywhere;}',
          '.gsc-native-conflict-card-secondary,.gsc-native-conflict-card-detail{margin-top:5px;color:var(--vscode-descriptionForeground);white-space:pre-line;overflow-wrap:anywhere;}',
          '.gsc-native-conflict-card-state{display:inline-block;margin-top:6px;padding:2px 5px;border-radius:3px;background:var(--vscode-editorWarning-background,rgba(204,167,0,.15));color:var(--vscode-editorWarning-foreground);white-space:normal;overflow-wrap:anywhere;}',
          '.gsc-native-conflict-impact{display:flex;gap:7px;margin-top:8px;padding:7px 8px;border-left:3px solid var(--vscode-focusBorder);background:var(--vscode-textBlockQuote-background,rgba(127,127,127,.08));}',
          '.gsc-native-conflict-impact.success{border-left-color:var(--vscode-testing-iconPassed,#2ea043);}',
          '.gsc-native-conflict-impact.warning{border-left-color:var(--vscode-editorWarning-foreground,#cca700);}',
          '.gsc-native-conflict-impact-title{font-weight:600;}',
          '.gsc-native-conflict-impact-detail{margin-top:2px;color:var(--vscode-descriptionForeground);white-space:normal;overflow-wrap:anywhere;}',
          '.gsc-native-conflict-notice{margin-top:8px;padding:7px 8px;border-radius:4px;background:var(--vscode-inputValidation-warningBackground,rgba(204,167,0,.12));color:var(--vscode-inputValidation-warningForeground,var(--vscode-foreground));white-space:normal;overflow-wrap:anywhere;}',
          '.gsc-native-conflict-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px;}',
          '.gsc-native-conflict-action{min-height:26px;padding:3px 9px;border:1px solid var(--vscode-button-border,transparent);border-radius:3px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font:inherit;cursor:pointer;white-space:normal;}',
          '.gsc-native-conflict-action:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground);}',
          '.gsc-native-conflict-action.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);}',
          '.gsc-native-conflict-action.primary:hover:not(:disabled){background:var(--vscode-button-hoverBackground);}',
          '.gsc-native-conflict-action:disabled{opacity:.55;cursor:default;}',
          '@media(max-width:1050px){.gsc-native-conflict-flow{grid-template-columns:repeat(2,minmax(150px,1fr));}}',
          '@media(max-width:650px){.gsc-native-conflict-overlay{right:8px;top:6px;width:calc(100% - 16px);}.gsc-native-conflict-flow{grid-template-columns:1fr;}}'
        ].join('\\n');
        if (!style.parentNode) document.head.appendChild(style);
      }

      function isVisible(node) {
        return !!(node && node.isConnected && node.offsetParent !== null && node.clientWidth > 0 && node.clientHeight > 0);
      }

      function activeEditorHost() {
        var groups = Array.prototype.slice.call(document.querySelectorAll('.editor-group-container.active,.editor-group-container.active-group'));
        var roots = groups.length ? groups : Array.prototype.slice.call(document.querySelectorAll('.editor-group-container'));
        for (var i = 0; i < roots.length; i++) {
          if (!isVisible(roots[i])) continue;
          var editors = Array.prototype.slice.call(roots[i].querySelectorAll('.editor-instance .monaco-editor')).filter(function (node) {
            if (!isVisible(node)) return false;
            if (node.closest('.ij-find-overlay')) return false;
            return !node.closest('.monaco-diff-editor') || !!node.closest('.editor.modified');
          });
          var focused = editors.filter(function (node) { return node.classList.contains('focused'); });
          var chosen = focused.length ? focused[focused.length - 1] : editors[editors.length - 1];
          if (chosen) return chosen.querySelector('.overflow-guard') || chosen;
        }
        var fallback = Array.prototype.slice.call(document.querySelectorAll('.editor-instance .monaco-editor')).filter(isVisible);
        return fallback.length ? (fallback[fallback.length - 1].querySelector('.overflow-guard') || fallback[fallback.length - 1]) : null;
      }

      function ensureRelative(host) {
        try {
          if (window.getComputedStyle(host).position === 'static') {
            host.style.position = 'relative';
            host.setAttribute('data-gsc-conflict-relative', 'true');
          }
        } catch (_) {}
      }

      function element(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
      }

      function tooltip(node, text) {
        node.title = String(text || '');
        node.setAttribute('aria-label', String(text || ''));
        node.setAttribute('data-tooltip', String(text || ''));
        return node;
      }

      function stopEditorEvent(event) {
        try {
          event.stopPropagation();
          if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        } catch (_) {}
      }

      function actionButton(label, title, action, enabled, primary) {
        var button = tooltip(element('button', 'gsc-native-conflict-action' + (primary ? ' primary' : ''), label), title);
        button.type = 'button';
        button.disabled = !enabled;
        button.setAttribute('aria-disabled', enabled ? 'false' : 'true');
        button.addEventListener('mousedown', stopEditorEvent, true);
        button.addEventListener('pointerdown', stopEditorEvent, true);
        button.addEventListener('click', function (event) {
          stopEditorEvent(event);
          if (!button.disabled) notify(action);
        }, true);
        return button;
      }

      function notify(action) {
        var snapshot = state.snapshot;
        if (!snapshot) return;
        try {
          var fn = window[BINDING];
          if (typeof fn === 'function') {
            fn(JSON.stringify({
              type: 'conflictAction',
              action: action,
              uri: snapshot.uri,
              sessionId: snapshot.sessionId,
              revision: snapshot.revision,
              editorVersion: snapshot.editorVersion
            }));
          }
        } catch (_) {}
      }

      function cleanup() {
        Array.prototype.slice.call(document.querySelectorAll('.' + ROOT_CLASS)).forEach(function (node) {
          try { node.remove(); } catch (_) {}
        });
        Array.prototype.slice.call(document.querySelectorAll('[data-gsc-conflict-relative="true"]')).forEach(function (node) {
          try {
            node.style.removeProperty('position');
            node.removeAttribute('data-gsc-conflict-relative');
          } catch (_) {}
        });
      }

      function cardNode(card) {
        var root = element('section', 'gsc-native-conflict-card ' + String(card.tone || ''));
        root.appendChild(element('div', 'gsc-native-conflict-card-title', card.title));
        root.appendChild(element('div', 'gsc-native-conflict-card-identity', card.identity));
        if (card.secondary) root.appendChild(element('div', 'gsc-native-conflict-card-secondary', card.secondary));
        if (card.state) root.appendChild(element('div', 'gsc-native-conflict-card-state', card.state));
        if (card.detail) root.appendChild(element('div', 'gsc-native-conflict-card-detail', card.detail));
        return root;
      }

      function buildPanel(snapshot) {
        var presentation = snapshot.presentation;
        var root = element('aside', ROOT_CLASS + (state.collapsed ? ' is-collapsed' : ''));
        root.setAttribute('role', 'complementary');
        root.setAttribute('aria-label', presentation.title);
        root.setAttribute('aria-busy', snapshot.busy ? 'true' : 'false');
        root.setAttribute('data-gsc-session', snapshot.sessionId);
        var paintKey = [snapshot.sessionId, snapshot.revision, snapshot.editorVersion, state.collapsed ? '1' : '0'].join(':');
        root.setAttribute('data-gsc-paint-key', paintKey);
        root.addEventListener('mousedown', stopEditorEvent, true);
        root.addEventListener('pointerdown', stopEditorEvent, true);
        root.addEventListener('wheel', stopEditorEvent, true);

        var header = element('header', 'gsc-native-conflict-header');
        var heading = element('div', 'gsc-native-conflict-heading');
        heading.appendChild(element('h2', 'gsc-native-conflict-title', presentation.title));
        heading.appendChild(element('div', 'gsc-native-conflict-path', presentation.path));
        header.appendChild(heading);
        header.appendChild(element('span', 'gsc-native-conflict-badge', presentation.operation));
        var collapseTitle = state.collapsed ? presentation.actions.expand : presentation.actions.collapse;
        var collapse = tooltip(element('button', 'gsc-native-conflict-icon-button', state.collapsed ? '▾' : '▴'), collapseTitle);
        collapse.type = 'button';
        collapse.setAttribute('aria-expanded', state.collapsed ? 'false' : 'true');
        collapse.setAttribute('aria-controls', 'gsc-native-conflict-body-' + snapshot.sessionId);
        collapse.addEventListener('click', function (event) {
          stopEditorEvent(event);
          state.collapsed = !state.collapsed;
          schedulePaint();
        }, true);
        header.appendChild(collapse);
        root.appendChild(header);

        var body = element('div', 'gsc-native-conflict-body');
        body.id = 'gsc-native-conflict-body-' + snapshot.sessionId;
        body.tabIndex = 0;
        if (presentation.meta && presentation.meta.length) {
          var meta = element('div', 'gsc-native-conflict-meta');
          presentation.meta.forEach(function (value) {
            meta.appendChild(element('span', 'gsc-native-conflict-meta-item', value));
          });
          body.appendChild(meta);
        }
        var flow = element('div', 'gsc-native-conflict-flow');
        (presentation.cards || []).forEach(function (card) { flow.appendChild(cardNode(card)); });
        body.appendChild(flow);
        var impact = element('div', 'gsc-native-conflict-impact ' + String(presentation.impact.tone || 'info'));
        var impactText = element('div', '');
        impactText.appendChild(element('div', 'gsc-native-conflict-impact-title', presentation.impact.title));
        impactText.appendChild(element('div', 'gsc-native-conflict-impact-detail', presentation.impact.detail));
        impact.appendChild(impactText);
        body.appendChild(impact);
        if (presentation.virtualNotice) body.appendChild(element('div', 'gsc-native-conflict-notice', presentation.virtualNotice));
        var actions = element('div', 'gsc-native-conflict-actions');
        var enabled = !snapshot.busy;
        actions.appendChild(actionButton(presentation.actions.current, presentation.actions.currentTooltip, 'acceptCurrent', enabled, true));
        actions.appendChild(actionButton(presentation.actions.incoming, presentation.actions.incomingTooltip, 'acceptIncoming', enabled, true));
        if (snapshot.canAcceptBoth) actions.appendChild(actionButton(presentation.actions.both, presentation.actions.bothTooltip, 'acceptBoth', enabled, false));
        if (snapshot.canMarkResolved) actions.appendChild(actionButton(presentation.actions.resolved, presentation.actions.resolvedTooltip, 'markResolved', enabled, false));
        if (snapshot.canOpenMergeEditor) actions.appendChild(actionButton(presentation.actions.mergeEditor, presentation.actions.mergeEditorTooltip, 'openMergeEditor', enabled, false));
        actions.appendChild(actionButton(presentation.actions.reload, presentation.actions.reloadTooltip, 'reload', enabled, false));
        body.appendChild(actions);
        root.appendChild(body);
        return root;
      }

      function paint() {
        state.frame = 0;
        var snapshot = state.snapshot;
        if (!snapshot) {
          cleanup();
          state.lastPaint = 'paint:none';
          return state.lastPaint;
        }
        var host = activeEditorHost();
        if (!host) {
          state.lastPaint = 'paint:no-editor';
          return state.lastPaint;
        }
        var paintKey = [snapshot.sessionId, snapshot.revision, snapshot.editorVersion, state.collapsed ? '1' : '0'].join(':');
        var existing = document.querySelector('.' + ROOT_CLASS);
        if (
          existing &&
          existing.parentNode === host &&
          existing.getAttribute('data-gsc-paint-key') === paintKey
        ) {
          state.lastPaint = 'paint:conflict:cached:' + paintKey;
          return state.lastPaint;
        }
        cleanup();
        ensureStyle();
        ensureRelative(host);
        host.appendChild(buildPanel(snapshot));
        state.lastPaint = 'paint:conflict:' + snapshot.sessionId + ':cards=' + ((snapshot.presentation.cards || []).length);
        return state.lastPaint;
      }

      function schedulePaint() {
        if (state.frame) return;
        state.frame = requestAnimationFrame(paint);
      }

      function clearTimers() {
        (state.timers || []).forEach(function (timer) { try { clearTimeout(timer); } catch (_) {} });
        state.timers = [];
      }

      function scheduleFollowUps() {
        clearTimers();
        [120, 420, 1000, 2200].forEach(function (delay) {
          state.timers.push(setTimeout(schedulePaint, delay));
        });
      }

      function overlayMutationOnly(mutation) {
        var nodes = Array.prototype.slice.call(mutation.addedNodes || []).concat(Array.prototype.slice.call(mutation.removedNodes || []));
        return !!nodes.length && nodes.every(function (node) {
          return !!(node && node.nodeType === 1 && (
            (node.classList && node.classList.contains(ROOT_CLASS)) ||
            (node.closest && node.closest('.' + ROOT_CLASS))
          ));
        });
      }

      function ensureObserver() {
        if (state.observer || typeof MutationObserver === 'undefined') return;
        var target = document.querySelector('.monaco-workbench') || document.body;
        if (!target) return;
        state.observer = new MutationObserver(function (mutations) {
          for (var i = 0; i < mutations.length; i++) {
            if (!overlayMutationOnly(mutations[i])) {
              schedulePaint();
              return;
            }
          }
        });
        try { state.observer.observe(target, { childList: true, subtree: true }); } catch (_) {}
      }

      window.__gscNativeConflictOverlay = {
        version: VERSION,
        render: function (snapshot) {
          state.generation = (state.generation || 0) + 1;
          state.snapshot = snapshot || null;
          clearTimers();
          if (!snapshot) {
            if (state.frame) {
              try { cancelAnimationFrame(state.frame); } catch (_) {}
              state.frame = 0;
            }
            cleanup();
            if (state.observer) { try { state.observer.disconnect(); } catch (_) {} state.observer = null; }
            state.lastPaint = 'paint:none';
            return 'cleaned';
          }
          ensureStyle();
          ensureObserver();
          schedulePaint();
          scheduleFollowUps();
          return new Promise(function (resolve) {
            setTimeout(function () {
              if (!document.querySelector('.' + ROOT_CLASS)) {
                try { paint(); } catch (_) {}
              }
              resolve('render-scheduled:conflict:last=' + state.lastPaint);
            }, 90);
          });
        }
      };
      return 'gsc-native-conflict-installed:' + VERSION;
    })()
  `;
}
