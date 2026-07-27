// Git Graph 좁은 폭 command bar의 보조 동작을 overflow menu로 이동한다.
// - 원래 button DOM을 재사용해 기존 graph/rebase/PR listener와 busy 상태를 그대로 보존한다.
(function () {
  "use strict";

  const OVERFLOW_WIDTH = 760;

  /** toolbar의 보조 button을 폭에 따라 원래 group과 menu 사이에서 이동시킨다. */
  function init() {
    const toolbar = document.getElementById("graph-toolbar");
    const toggle = document.getElementById("graph-toolbar-more");
    const menu = document.getElementById("graph-toolbar-overflow");
    if (!toolbar || !toggle || !menu) return;
    const items = Array.from(toolbar.querySelectorAll("[data-toolbar-overflow-item]"));
    const anchors = new Map(items.map((item) => [item, document.createComment(`overflow:${item.id}`)]));
    items.forEach((item) => item.parentNode?.insertBefore(anchors.get(item), item));
    let isOverflowing = false;

    /** 실제 가용 폭을 기준으로 menu 전환을 결정하고 열린 menu는 안전하게 닫는다. */
    function sync() {
      const next = toolbar.clientWidth < OVERFLOW_WIDTH;
      if (next === isOverflowing) return;
      isOverflowing = next;
      close();
      if (next) {
        items.forEach((item) => {
          item.setAttribute("role", "menuitem");
          menu.append(item);
        });
      } else {
        items.forEach((item) => {
          item.removeAttribute("role");
          const anchor = anchors.get(item);
          anchor?.parentNode?.insertBefore(item, anchor.nextSibling);
        });
      }
      toggle.hidden = !next;
    }

    /** menu의 표시/ARIA 상태를 한 곳에서 맞추고 Escape·외부 click 복구에 재사용한다. */
    function close() {
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    }

    /** icon button이 menu trigger일 때만 보조 action 목록을 열거나 닫는다. */
    function toggleMenu() {
      if (!isOverflowing) return;
      const open = menu.hidden;
      menu.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      if (open) menu.querySelector("button:not([disabled])")?.focus();
    }

    toggle.addEventListener("click", toggleMenu);
    document.addEventListener("click", (event) => {
      if (!menu.hidden && !menu.contains(event.target) && event.target !== toggle) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || menu.hidden) return;
      event.preventDefault();
      close();
      toggle.focus();
    });
    menu.addEventListener("click", close);
    /** menu role에 맞춰 Arrow/Home/End로 보이는 보조 명령 사이의 포커스를 이동한다. */
    menu.addEventListener("keydown", (event) => {
      const commands = Array.from(menu.querySelectorAll("button:not([disabled])"));
      const index = commands.indexOf(document.activeElement);
      if (!commands.length || index < 0) return;
      let next = -1;
      if (event.key === "ArrowDown") next = (index + 1) % commands.length;
      if (event.key === "ArrowUp") next = (index + commands.length - 1) % commands.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = commands.length - 1;
      if (next < 0) return;
      event.preventDefault();
      commands[next].focus();
    });
    new ResizeObserver(sync).observe(toolbar);
    sync();
  }

  window.GscGraphToolbarOverflow = { init };
}());
