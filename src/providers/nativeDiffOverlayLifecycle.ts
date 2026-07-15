// native hunk renderer patch의 observer/listener/style/host-position 수명주기 JavaScript를 조립한다.
// - paint 알고리즘과 정리 책임을 분리해 mode 전환·dispose 뒤 workbench DOM에 흔적이 남지 않게 한다.

/** rendererPatchScript 내부에 삽입할 상태 초기화와 teardown 함수 선언을 반환한다. */
export function nativeDiffOverlayLifecycleScript(): string {
  return `
      var previousState = window.__gscNativeDiffOverlayState;
      if (previousState && previousState.version !== VERSION) {
        previousState.snapshot = null;
        try { if (previousState.frame) cancelAnimationFrame(previousState.frame); } catch (_) {}
        try { if (previousState.viewportTimer) clearTimeout(previousState.viewportTimer); } catch (_) {}
        (previousState.repaintTimers || []).forEach(function (timer) { try { clearTimeout(timer); } catch (_) {} });
        (previousState.observers || []).forEach(function (item) { try { (item.observer || item).disconnect(); } catch (_) {} });
        (previousState.scrollTargets || []).forEach(function (target) {
          try { if (previousState.viewportHandler) target.removeEventListener('scroll', previousState.viewportHandler); } catch (_) {}
          try { if (previousState.viewportHandler) target.removeEventListener('wheel', previousState.viewportHandler); } catch (_) {}
        });
        try { if (previousState.resizeHandler) window.removeEventListener('resize', previousState.resizeHandler); } catch (_) {}
        try { if (previousState.documentScrollHandler) document.removeEventListener('scroll', previousState.documentScrollHandler, true); } catch (_) {}
        Array.prototype.slice.call(document.querySelectorAll('.gsc-native-diff-overlay-layer,.gsc-native-diff-checkbox-wrap')).forEach(function (node) {
          try { node.remove(); } catch (_) {}
        });
        Array.prototype.slice.call(document.querySelectorAll('[data-gsc-diff-relative="true"]')).forEach(function (node) {
          try { node.style.removeProperty('position'); node.removeAttribute('data-gsc-diff-relative'); } catch (_) {}
        });
        var previousStyle = document.getElementById(STYLE_ID);
        if (previousStyle) { try { previousStyle.remove(); } catch (_) {} }
      }
      var state = previousState && previousState.version === VERSION ? previousState : {
        version: VERSION,
        snapshot: null,
        localChecked: Object.create(null),
        frame: 0,
        generation: 0,
        scrollTargets: [],
        observers: [],
        repaintTimers: [],
        viewportTimer: 0,
        resizeBound: false,
        documentScrollBound: false
      };
      state.scrollTargets = state.scrollTargets || [];
      state.observers = state.observers || [];
      window.__gscNativeDiffOverlayState = state;

      function ensureStyle() {
        var style = document.getElementById(STYLE_ID);
        if (style && style.getAttribute('data-gsc-version') === String(VERSION)) return;
        if (!style) style = document.createElement('style');
        style.id = STYLE_ID;
        style.setAttribute('data-gsc-version', String(VERSION));
        style.textContent = [
          '.gsc-native-diff-overlay-layer{position:absolute;left:0;top:0;width:22px;height:100%;z-index:80;pointer-events:none;}',
          '.gsc-native-diff-checkbox-wrap{width:16px;display:flex;align-items:center;justify-content:center;pointer-events:auto;}',
          '.gsc-native-diff-checkbox-row{position:absolute;left:2px;z-index:200;}',
          '.gsc-native-diff-checkbox{width:13px;height:13px;margin:0;padding:0;cursor:pointer;accent-color:var(--vscode-focusBorder);}',
          '.gsc-native-diff-checkbox:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:1px;}'
        ].join('\\n');
        if (!style.parentNode) document.head.appendChild(style);
      }
      function cleanupDom() {
        Array.prototype.slice.call(document.querySelectorAll('.gsc-native-diff-overlay-layer,.gsc-native-diff-checkbox-wrap')).forEach(function (node) {
          try { node.remove(); } catch (_) {}
        });
      }
      function schedulePaint() {
        if (state.frame) return;
        state.frame = requestAnimationFrame(function () { state.frame = 0; paint(); });
      }
      function scheduleViewportPaint() {
        if (state.viewportTimer) return;
        state.viewportTimer = setTimeout(function () { state.viewportTimer = 0; schedulePaint(); }, 48);
      }
      function clearFollowUpPaints() {
        (state.repaintTimers || []).forEach(function (timer) { try { clearTimeout(timer); } catch (_) {} });
        state.repaintTimers = [];
      }
      function scheduleFollowUpPaints() {
        clearFollowUpPaints();
        [120, 420, 1100, 2400].forEach(function (delay) {
          state.repaintTimers.push(setTimeout(schedulePaint, delay));
        });
      }
      function handleDocumentScroll(event) {
        var target = event && event.target;
        if (!target || !target.closest || target.closest('.monaco-diff-editor,.editor.original,.editor.modified,.margin-view-overlays')) {
          scheduleViewportPaint();
        }
      }
      state.viewportHandler = state.viewportHandler || scheduleViewportPaint;
      state.resizeHandler = state.resizeHandler || schedulePaint;
      state.documentScrollHandler = state.documentScrollHandler || handleDocumentScroll;

      function bindViewportEvents() {
        state.scrollTargets = (state.scrollTargets || []).filter(function (target) {
          if (target && target.isConnected) return true;
          try { target.removeEventListener('scroll', state.viewportHandler); } catch (_) {}
          try { target.removeEventListener('wheel', state.viewportHandler); } catch (_) {}
          return false;
        });
        var targets = Array.prototype.slice.call(document.querySelectorAll('.monaco-scrollable-element')).filter(function (target) {
          return !!(target && target.querySelector && target.querySelector('.editor.original,.editor.modified,.monaco-diff-editor,.margin-view-overlays'));
        });
        targets.forEach(function (target) {
          if (state.scrollTargets.indexOf(target) >= 0) return;
          state.scrollTargets.push(target);
          target.addEventListener('scroll', state.viewportHandler, { passive: true });
          target.addEventListener('wheel', state.viewportHandler, { passive: true });
        });
        if (!state.resizeBound) {
          state.resizeBound = true;
          window.addEventListener('resize', state.resizeHandler, { passive: true });
        }
        if (!state.documentScrollBound) {
          state.documentScrollBound = true;
          document.addEventListener('scroll', state.documentScrollHandler, true);
        }
      }
      function isOverlayNode(node) {
        return !!(node && node.nodeType === 1 && (
          (node.classList && node.classList.contains('gsc-native-diff-overlay-layer')) ||
          (node.classList && node.classList.contains('gsc-native-diff-checkbox-wrap')) ||
          (node.closest && node.closest('.gsc-native-diff-overlay-layer,.gsc-native-diff-checkbox-wrap'))
        ));
      }
      function mutationIsOverlayOnly(mutation) {
        if (isOverlayNode(mutation.target)) return true;
        if (mutation.type !== 'childList') return false;
        var nodes = Array.prototype.slice.call(mutation.addedNodes || []).concat(Array.prototype.slice.call(mutation.removedNodes || []));
        return !!nodes.length && nodes.every(isOverlayNode);
      }
      function observeEditorDom(editorDom) {
        if (!editorDom || typeof MutationObserver === 'undefined') return;
        state.observers = (state.observers || []).filter(function (item) {
          if (item.target && item.target.isConnected) return true;
          try { item.observer.disconnect(); } catch (_) {}
          return false;
        });
        var targets = [editorDom.querySelector('.margin-view-overlays'), editorDom.querySelector('.view-lines')].filter(Boolean);
        targets.forEach(function (target) {
          if (state.observers.some(function (item) { return item.target === target; })) return;
          var observer = new MutationObserver(function (mutations) {
            if (mutations.some(function (mutation) { return !mutationIsOverlayOnly(mutation); })) scheduleViewportPaint();
          });
          try {
            observer.observe(target, { childList: true, subtree: false, attributes: true, attributeFilter: ['style', 'class', 'data-line-number'] });
            state.observers.push({ target: target, observer: observer });
          } catch (_) { try { observer.disconnect(); } catch (_) {} }
        });
      }
      function ensureRelative(host) {
        try {
          if (window.getComputedStyle(host).position === 'static') {
            host.style.position = 'relative';
            host.setAttribute('data-gsc-diff-relative', 'true');
          }
        } catch (_) {}
      }
      function teardown() {
        state.snapshot = null;
        if (state.frame) { try { cancelAnimationFrame(state.frame); } catch (_) {} state.frame = 0; }
        if (state.viewportTimer) { try { clearTimeout(state.viewportTimer); } catch (_) {} state.viewportTimer = 0; }
        clearFollowUpPaints();
        (state.observers || []).forEach(function (item) { try { item.observer.disconnect(); } catch (_) {} });
        state.observers = [];
        (state.scrollTargets || []).forEach(function (target) {
          try { target.removeEventListener('scroll', state.viewportHandler); } catch (_) {}
          try { target.removeEventListener('wheel', state.viewportHandler); } catch (_) {}
        });
        state.scrollTargets = [];
        if (state.resizeBound) { try { window.removeEventListener('resize', state.resizeHandler); } catch (_) {} state.resizeBound = false; }
        if (state.documentScrollBound) { try { document.removeEventListener('scroll', state.documentScrollHandler, true); } catch (_) {} state.documentScrollBound = false; }
        cleanupDom();
        Array.prototype.slice.call(document.querySelectorAll('[data-gsc-diff-relative="true"]')).forEach(function (node) {
          try { node.style.removeProperty('position'); node.removeAttribute('data-gsc-diff-relative'); } catch (_) {}
        });
        var style = document.getElementById(STYLE_ID);
        if (style) { try { style.remove(); } catch (_) {} }
      }
  `;
}
