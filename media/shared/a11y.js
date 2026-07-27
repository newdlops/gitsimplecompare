// 공유 webview의 focus 복구와 status announcement를 제공하는 접근성 primitive.
// - 각 surface가 live region과 DOM 연결 여부를 제각각 구현하지 않게 하되, global UI state는 소유하지 않는다.
(function () {
  "use strict";

  /** live region을 한 번 만들고 재사용한다. */
  function ensureLiveRegion(document, id) {
    let region = document.getElementById(id);
    if (region) return region;
    region = document.createElement("div");
    region.id = id;
    region.className = "gsc-visually-hidden";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "true");
    document.body.append(region);
    return region;
  }

  /** screen reader가 같은 문구도 다시 읽도록 region을 비운 뒤 새 text를 기록한다. */
  function announce(message, options) {
    const document = options?.document || window.document;
    const region = ensureLiveRegion(document, options?.id || "gsc-live-region");
    region.setAttribute("aria-live", options?.priority === "assertive" ? "assertive" : "polite");
    region.textContent = "";
    region.textContent = String(message || "");
  }

  /** 연결된 target을 우선 focus하고 사라졌으면 fallback으로 논리적 focus를 복구한다. */
  function restoreFocus(target, fallback) {
    const candidate = target?.isConnected ? target : fallback?.isConnected ? fallback : undefined;
    candidate?.focus?.();
    return candidate || null;
  }

  /** user의 reduced-motion OS 설정을 안전한 boolean으로 반환한다. */
  function prefersReducedMotion(media = window.matchMedia) {
    return Boolean(media?.("(prefers-reduced-motion: reduce)")?.matches);
  }

  window.__gscA11y = { announce, ensureLiveRegion, prefersReducedMotion, restoreFocus };
}());
