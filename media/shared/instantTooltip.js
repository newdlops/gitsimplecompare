// 모든 Git Simple Compare 웹뷰에서 title/data-tooltip을 지연 없이 보여주는 공용 이벤트 위임 모듈.
(function () {
  "use strict";

  const TARGET_SELECTOR = "[data-tooltip], [title]";
  const VIEWPORT_EDGE = 8;
  const TOOLTIP_GAP = 6;
  const suppressedTitles = new WeakMap();
  let tooltipElement;
  let hoverTarget;
  let focusTarget;
  let activeTarget;

  /**
   * Text 노드에서 시작한 이벤트도 closest 탐색이 가능하도록 부모 Element로 정규화한다.
   * @param {Event} event 문서에 위임된 mouse/focus 이벤트
   * @returns {Element | undefined} closest를 호출할 수 있는 이벤트 대상
   */
  function eventElement(event) {
    const target = event.target;
    return target instanceof Element ? target : target?.parentElement;
  }

  /**
   * 이벤트 위치에서 가장 가까운 tooltip 대상 요소를 찾는다.
   * @param {Event} event mouse/focus 이벤트
   * @returns {HTMLElement | undefined} title 또는 data-tooltip을 가진 요소
   */
  function targetFromEvent(event) {
    const target = eventElement(event)?.closest?.(TARGET_SELECTOR);
    return target instanceof HTMLElement || target instanceof SVGElement
      ? target
      : undefined;
  }

  /**
   * data-tooltip, 현재 title, 억제 중 보관한 title 순으로 표시할 문구를 선택한다.
   * @param {Element | undefined} target tooltip 대상 요소
   * @returns {string} 공백을 제거한 현재 tooltip 문구
   */
  function tooltipText(target) {
    return String(
      target?.dataset?.tooltip ||
        target?.getAttribute("title") ||
        suppressedTitles.get(target) ||
        ""
    ).trim();
  }

  /**
   * 문서 전역 tooltip overlay를 최초 한 번만 만들어 이후 hover/focus에서 재사용한다.
   * @returns {HTMLDivElement} fixed 위치로 표시할 공용 tooltip 요소
   */
  function ensureTooltip() {
    if (!tooltipElement) {
      tooltipElement = document.createElement("div");
      tooltipElement.className = "gsc-instant-tooltip";
      tooltipElement.setAttribute("role", "tooltip");
      tooltipElement.hidden = true;
      document.body.appendChild(tooltipElement);
    }
    return tooltipElement;
  }

  /**
   * 브라우저 native title을 잠시 제거해 공용 overlay와 지연 tooltip이 겹치지 않게 한다.
   * @param {Element} target 활성 tooltip 대상
   */
  function suppressNativeTitle(target) {
    if (suppressedTitles.has(target)) {
      // 활성 중 상태 변화로 title이 다시 설정되면 최신 문구를 저장하고 즉시 다시 억제한다.
      if (target.hasAttribute("title")) {
        suppressedTitles.set(target, target.getAttribute("title") || "");
        target.removeAttribute("title");
      }
      return;
    }
    if (!target.hasAttribute("title")) {
      return;
    }
    suppressedTitles.set(target, target.getAttribute("title") || "");
    target.removeAttribute("title");
  }

  /**
   * 공용 tooltip이 끝난 요소의 native title을 복원하되, 외부 코드가 설정한 최신 값을 보존한다.
   * @param {Element | undefined} target 비활성화되는 tooltip 대상
   */
  function restoreNativeTitle(target) {
    if (!target || !suppressedTitles.has(target)) {
      return;
    }
    const title = suppressedTitles.get(target);
    suppressedTitles.delete(target);
    // 활성 중 다른 코드가 새 title을 설정했다면 그 최신 값을 덮어쓰지 않는다.
    if (!target.hasAttribute("title")) {
      target.setAttribute("title", title);
    }
  }

  /**
   * tooltip을 대상 아래에 배치하고 공간이 부족하면 위쪽 및 viewport 안쪽으로 좌표를 보정한다.
   * @param {Element} target tooltip 기준이 되는 버튼 또는 컨트롤
   * @param {HTMLDivElement} tooltip 실제 크기를 측정해 배치할 overlay
   */
  function placeTooltip(target, tooltip) {
    if (!target?.isConnected || tooltip.hidden) {
      return;
    }
    const targetRect = target.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const maxLeft = Math.max(VIEWPORT_EDGE, window.innerWidth - tooltipRect.width - VIEWPORT_EDGE);
    const left = clamp(
      targetRect.left + targetRect.width / 2 - tooltipRect.width / 2,
      VIEWPORT_EDGE,
      maxLeft
    );
    let top = targetRect.bottom + TOOLTIP_GAP;
    if (top + tooltipRect.height + VIEWPORT_EDGE > window.innerHeight) {
      top = targetRect.top - tooltipRect.height - TOOLTIP_GAP;
    }
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${clamp(
      top,
      VIEWPORT_EDGE,
      Math.max(VIEWPORT_EDGE, window.innerHeight - tooltipRect.height - VIEWPORT_EDGE)
    )}px`;
  }

  /**
   * 계산된 tooltip 좌표를 viewport 경계 범위 안으로 제한한다.
   * @param {number} value 원래 좌표
   * @param {number} min 허용할 최솟값
   * @param {number} max 허용할 최댓값
   * @returns {number} min/max 사이로 보정된 좌표
   */
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * 새 대상의 overlay를 즉시 표시하고 기존 pseudo/native tooltip이 중복되지 않게 억제한다.
   * @param {Element} target 현재 hover 또는 keyboard focus를 받은 요소
   */
  function activate(target) {
    const text = tooltipText(target);
    if (!text) {
      deactivate();
      return;
    }
    if (activeTarget && activeTarget !== target) {
      restoreNativeTitle(activeTarget);
      activeTarget.classList.remove("gsc-instant-tooltip-source");
    }
    activeTarget = target;
    suppressNativeTitle(target);
    target.classList.add("gsc-instant-tooltip-source");
    const tooltip = ensureTooltip();
    tooltip.textContent = text;
    tooltip.hidden = false;
    placeTooltip(target, tooltip);
  }

  /**
   * 현재 overlay를 숨기고 원래 title 및 pseudo-tooltip 상태를 복원한다.
   * @returns {void} 활성 대상이 없어도 안전하게 종료한다
   */
  function deactivate() {
    if (activeTarget) {
      restoreNativeTitle(activeTarget);
      activeTarget.classList.remove("gsc-instant-tooltip-source");
      activeTarget = undefined;
    }
    if (tooltipElement) {
      tooltipElement.hidden = true;
    }
  }

  /**
   * hover와 keyboard focus 중 표시할 대상을 다시 계산하며, 직접 조작 중인 hover를 우선한다.
   * @returns {void} 대상이 없으면 현재 tooltip을 닫는다
   */
  function refreshActiveTarget() {
    // 마우스를 다른 버튼으로 옮기면 이전 클릭으로 남은 focus보다 새 hover를 우선한다.
    const next = hoverTarget || focusTarget;
    if (!next) {
      deactivate();
      return;
    }
    activate(next);
  }

  document.addEventListener("mouseover", (event) => {
    const target = targetFromEvent(event);
    if (!target || target === hoverTarget) {
      return;
    }
    hoverTarget = target;
    refreshActiveTarget();
  });
  document.addEventListener("mouseout", (event) => {
    if (!hoverTarget) {
      return;
    }
    const related = event.relatedTarget;
    if (related instanceof Node && hoverTarget.contains(related)) {
      return;
    }
    hoverTarget = undefined;
    refreshActiveTarget();
  });
  document.addEventListener("focusin", (event) => {
    focusTarget = targetFromEvent(event);
    refreshActiveTarget();
  });
  document.addEventListener("focusout", (event) => {
    const relatedTarget =
      event.relatedTarget instanceof Element
        ? event.relatedTarget.closest(TARGET_SELECTOR)
        : undefined;
    focusTarget = relatedTarget || undefined;
    refreshActiveTarget();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hoverTarget = undefined;
      focusTarget = undefined;
      deactivate();
    }
  });
  document.addEventListener("scroll", () => {
    if (activeTarget && tooltipElement) {
      placeTooltip(activeTarget, tooltipElement);
    }
  }, true);
  window.addEventListener("resize", () => {
    if (activeTarget && tooltipElement) {
      placeTooltip(activeTarget, tooltipElement);
    }
  });
  window.addEventListener("blur", () => {
    hoverTarget = undefined;
    focusTarget = undefined;
    deactivate();
  });

  // hover/focus 중 버튼 상태가 바뀌어도 overlay 문구와 native title 억제를 같은 프레임에 맞춘다.
  new MutationObserver((records) => {
    if (activeTarget && !activeTarget.isConnected) {
      hoverTarget = undefined;
      focusTarget = undefined;
      deactivate();
      return;
    }
    if (
      activeTarget &&
      records.some(
        (record) =>
          record.target === activeTarget &&
          (record.attributeName === "title" || record.attributeName === "data-tooltip")
      )
    ) {
      activate(activeTarget);
    }
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["title", "data-tooltip"],
  });

  window.GscInstantTooltip = { refresh: refreshActiveTarget };
})();
