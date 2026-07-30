// pointer와 keyboard에서 같은 범위·step·ARIA 값을 사용하는 splitter primitive.
// - 실제 pane CSS와 persisted layout은 각 surface가 소유하고 이 모듈은 input to value 변환만 담당한다.
(function () {
  "use strict";

  /** min/max 사이로 값을 제한하고 정수 pixel 값으로 정규화한다. */
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  /** handle을 선택적으로 연결한 splitter controller를 만든다. */
  function createSplitter(options) {
    const min = Number(options.min);
    const max = Number(options.max);
    const step = Math.max(1, Number(options.step) || 10);
    const horizontal = options.orientation !== "vertical";
    let value = clamp(Number(options.value), min, max);
    const handle = options.handle;
    const document = handle?.ownerDocument;

    function announce(source) {
      if (handle) {
        handle.setAttribute("role", "separator");
        handle.setAttribute("aria-orientation", horizontal ? "vertical" : "horizontal");
        handle.setAttribute("aria-valuemin", String(min));
        handle.setAttribute("aria-valuemax", String(max));
        handle.setAttribute("aria-valuenow", String(value));
      }
      options.onChange?.(value, { source });
    }
    function setValue(next, source) {
      const normalized = clamp(next, min, max);
      if (normalized === value) return value;
      value = normalized;
      announce(source || "programmatic");
      return value;
    }
    function onKeydown(event) {
      const decrement = horizontal ? "ArrowLeft" : "ArrowUp";
      const increment = horizontal ? "ArrowRight" : "ArrowDown";
      const direction = Number(options.direction) || 1;
      if (event.key === decrement) { event.preventDefault(); setValue(value - step * direction, "keyboard"); }
      else if (event.key === increment) { event.preventDefault(); setValue(value + step * direction, "keyboard"); }
      else if (event.key === "Home") { event.preventDefault(); setValue(min, "keyboard"); }
      else if (event.key === "End") { event.preventDefault(); setValue(max, "keyboard"); }
    }
    function onPointerdown(event) {
      if (event.button !== 0 || !document) return;
      const startPointer = horizontal ? event.clientX : event.clientY;
      const startValue = value;
      const direction = Number(options.direction) || 1;
      function onPointermove(move) { setValue(startValue + ((horizontal ? move.clientX : move.clientY) - startPointer) * direction, "pointer"); }
      function onPointerup() { document.removeEventListener("pointermove", onPointermove); document.removeEventListener("pointerup", onPointerup); }
      handle.setPointerCapture?.(event.pointerId);
      document.addEventListener("pointermove", onPointermove);
      document.addEventListener("pointerup", onPointerup, { once: true });
    }
    if (handle) { handle.tabIndex = handle.tabIndex < 0 ? 0 : handle.tabIndex; handle.addEventListener("keydown", onKeydown); handle.addEventListener("pointerdown", onPointerdown); announce("initialize"); }
    return { dispose: function () { handle?.removeEventListener("keydown", onKeydown); handle?.removeEventListener("pointerdown", onPointerdown); }, getValue: function () { return value; }, setValue };
  }

  window.__gscSplitter = { clamp, createSplitter };
}());
