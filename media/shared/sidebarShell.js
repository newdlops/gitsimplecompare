// Changes와 Reviews가 공유하는 sidebar 최상위 navigation primitive.
// - 서로 다른 VS Code contributed view를 오가는 control이므로 ARIA tablist가 아닌 nav/button을 쓴다.
(function () {
  "use strict";

  /**
   * 최상위 sidebar surface를 전환할 navigation을 만든다.
   * @param {{ mode: "changes" | "reviews", labels: { navigation: string, changes: string, reviews: string }, onSelect: (mode: "changes" | "reviews") => void }} options 현재 mode와 host 전환 callback
   * @returns {HTMLElement} 접근 가능한 nav element
   */
  function renderPrimaryNavigation(options) {
    const nav = document.createElement("nav");
    nav.className = "gsc-sidebar-nav";
    nav.setAttribute("aria-label", options.labels.navigation);
    [
      { mode: "changes", label: options.labels.changes },
      { mode: "reviews", label: options.labels.reviews },
    ].forEach(function (item) {
      const button = document.createElement("button");
      const current = options.mode === item.mode;
      button.type = "button";
      button.className = "gsc-sidebar-nav__item";
      button.textContent = item.label;
      button.title = item.label;
      button.dataset.tooltip = item.label;
      button.setAttribute("aria-label", item.label);
      if (current) button.setAttribute("aria-current", "page");
      button.addEventListener("click", function () {
        if (!current) options.onSelect(item.mode);
      });
      nav.appendChild(button);
    });
    return nav;
  }

  window.__gscSidebarShell = { renderPrimaryNavigation };
}());
