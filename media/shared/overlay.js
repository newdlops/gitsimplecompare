// menu, popover, dialog가 공유할 focus trap과 close lifecycle primitive.
// - overlay의 data model이나 visual style은 소유하지 않고 Esc, Tab, trigger focus 복구만 일관되게 처리한다.
(function () {
  "use strict";

  const FOCUSABLE = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";

  /** 현재 overlay 안에서 실제 keyboard focus를 받을 수 있는 요소를 반환한다. */
  function focusableElements(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter(function (element) {
      return !element.hidden && element.getAttribute("aria-hidden") !== "true";
    });
  }

  /** Tab 순환과 Escape 종료를 담당하는 overlay-local focus trap을 만든다. */
  function createFocusTrap(root, onEscape) {
    function onKeydown(event) {
      if (event.key === "Escape") { event.preventDefault(); onEscape?.(); return; }
      if (event.key !== "Tab") return;
      const targets = focusableElements(root);
      if (!targets.length) { event.preventDefault(); root.focus?.(); return; }
      const current = targets.indexOf(root.ownerDocument.activeElement);
      const next = event.shiftKey ? (current <= 0 ? targets.length - 1 : current - 1) : (current === targets.length - 1 ? 0 : current + 1);
      event.preventDefault();
      targets[next].focus();
    }
    root.addEventListener("keydown", onKeydown);
    return {
      focusInitial: function () { (focusableElements(root)[0] || root).focus?.(); },
      dispose: function () { root.removeEventListener("keydown", onKeydown); },
    };
  }

  /** 단일 surface의 열린 overlay를 추적하고 trigger focus를 안전하게 되돌린다. */
  function createOverlayManager() {
    let closeActive = null;
    function open(options) {
      closeActive?.();
      const root = options.root;
      const trigger = options.trigger;
      let closed = false;
      const trap = createFocusTrap(root, close);
      function close() {
        if (closed) return;
        closed = true;
        trap.dispose();
        options.onClose?.();
        if (trigger?.isConnected) trigger.focus?.();
        if (closeActive === close) closeActive = null;
      }
      closeActive = close;
      trap.focusInitial();
      return { close, isOpen: function () { return !closed; } };
    }
    return { close: function () { closeActive?.(); }, open };
  }

  window.__gscOverlay = { createFocusTrap, createOverlayManager, focusableElements };
}());
