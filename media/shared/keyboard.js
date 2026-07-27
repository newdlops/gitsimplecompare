// roving tabindex와 화면 범위 shortcut 등록을 제공하는 keyboard primitive.
// - native control을 우선 사용하고, custom tab/list가 같은 화살표·Home·End 규약을 재사용하게 한다.
(function () {
  "use strict";

  /** focus 가능한 항목 배열에서 범위를 벗어나지 않는 index를 계산한다. */
  function boundedIndex(index, count) {
    return Math.max(0, Math.min(Math.max(0, count - 1), index));
  }

  /** item 목록을 직접 제공받아 roving tabindex controller를 만든다. */
  function createRovingTabIndex(options) {
    const getItems = options.getItems;
    let activeIndex = Number.isInteger(options.initialIndex) ? options.initialIndex : 0;

    function items() { return Array.from(getItems() || []); }
    function apply(nextIndex, focus) {
      const all = items();
      if (!all.length) return null;
      activeIndex = boundedIndex(nextIndex, all.length);
      all.forEach(function (item, index) {
        item.tabIndex = index === activeIndex ? 0 : -1;
        if (options.selected) item.setAttribute("aria-selected", index === activeIndex ? "true" : "false");
      });
      const active = all[activeIndex];
      if (focus) active.focus?.();
      options.onActiveChange?.(active, activeIndex);
      return active;
    }

    function handleKeydown(event) {
      const all = items();
      if (!all.length) return false;
      const current = Math.max(0, all.indexOf(event.target));
      const horizontal = options.orientation !== "vertical";
      let next;
      if ((horizontal && event.key === "ArrowRight") || (!horizontal && event.key === "ArrowDown")) next = current + 1;
      if ((horizontal && event.key === "ArrowLeft") || (!horizontal && event.key === "ArrowUp")) next = current - 1;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = all.length - 1;
      if (next === undefined) return false;
      event.preventDefault();
      apply(next, true);
      return true;
    }

    return { apply: function () { return apply(activeIndex, false); }, handleKeydown, setActive: function (index, focus) { return apply(index, Boolean(focus)); } };
  }

  /** modifier를 포함한 shortcut을 한 surface 범위에서 등록하고 dispose 가능하게 만든다. */
  function createShortcutRegistry(target) {
    const entries = [];
    const eventTarget = target || window;
    function matches(event, shortcut) {
      return event.key.toLowerCase() === shortcut.key.toLowerCase()
        && Boolean(event.metaKey) === Boolean(shortcut.metaKey)
        && Boolean(event.ctrlKey) === Boolean(shortcut.ctrlKey)
        && Boolean(event.altKey) === Boolean(shortcut.altKey)
        && Boolean(event.shiftKey) === Boolean(shortcut.shiftKey);
    }
    function onKeydown(event) {
      entries.some(function (entry) {
        if (!matches(event, entry) || entry.when?.(event) === false) return false;
        event.preventDefault();
        entry.handler(event);
        return true;
      });
    }
    eventTarget.addEventListener("keydown", onKeydown);
    return {
      register: function (shortcut) {
        entries.push(shortcut);
        return function () { const index = entries.indexOf(shortcut); if (index >= 0) entries.splice(index, 1); };
      },
      dispose: function () { eventTarget.removeEventListener("keydown", onKeydown); entries.splice(0); },
    };
  }

  window.__gscKeyboard = { createRovingTabIndex, createShortcutRegistry };
}());
