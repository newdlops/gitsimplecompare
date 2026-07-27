// Changes 아코디언의 접힘·높이 배분·sash resize 상태 모듈.
// - 섹션 HTML 생성과 분리해 렌더 뒤 DOM 레이아웃만 일관되게 적용한다.
(function () {
  "use strict";

  /** Changes renderer가 소유한 상태와 disclosure helper를 받아 layout API를 만든다. */
  window.__gscChangesSectionLayout = function createChangesSectionLayout(deps) {
    const { rootEl, state, isCollapsed, syncDisclosureControl, HEADER_H, MIN_SECTION, DEFAULT_WEIGHT, strings, vscode } = deps;
    const REGION_DEFAULT_WEIGHT = { repository: 120, working: 280, tools: 220 };
    const MIN_REGION = 48;
    state.regionSizes = state.regionSizes || {};

    /** persisted collapse state를 section, twistie, accessibility state에 반영한다. */
    function applyCollapse() {
      rootEl.querySelectorAll(".section").forEach((section) => {
        const collapsed = isCollapsed(section.dataset.section);
        section.classList.toggle("collapsed", collapsed);
        const twistie = section.querySelector(".section-header .twistie");
        twistie.classList.toggle("codicon-chevron-down", !collapsed);
        twistie.classList.toggle("codicon-chevron-right", collapsed);
        syncDisclosureControl(section.querySelector(":scope > .section-header"), !collapsed);
      });
    }

    /** 펼친 섹션과 최상위 정보 영역의 저장한 높이 비율을 적용한다. */
    function applyResize() {
      rootEl.querySelectorAll(".changes-region").forEach((region) => applyRegionSections(region));
      applyRegionResize();
    }

    /** 한 정보 영역 안에서만 section 높이와 sash를 배치해 다른 영역을 침범하지 않게 한다. */
    function applyRegionSections(region) {
      const growable = [];
      Array.from(region.children).filter((node) => node.classList?.contains("section")).forEach((section) => {
        const id = section.dataset.section;
        if (section.classList.contains("collapsed")) {
          section.style.flex = `0 0 ${HEADER_H}px`;
          return;
        }
        if (id === "repos") {
          // 저장소 목록도 독립 영역 안에서 스크롤해, 긴 목록이 Working Changes/Tools를 밀어내지 않게 한다.
          section.style.flex = "1 1 0";
          growable.push(section);
          return;
        }
        const weight = state.sizes[id] > 0 ? state.sizes[id] : DEFAULT_WEIGHT[id] || 160;
        section.style.flex = `${weight} 1 0`;
        growable.push(section);
      });
      placeSashes(region, growable);
    }

    /** Repository·Working Changes·Tools를 모두 독립 높이 영역으로 만들고 인접 sash를 붙인다. */
    function applyRegionResize() {
      const regions = Array.from(rootEl.querySelectorAll(".changes-region"));
      rootEl.querySelectorAll(".changes-region-sash").forEach((sash) => sash.remove());
      if (regions.length < 2) return;

      regions.forEach((region) => {
        const id = region.dataset.changesRegion;
        const weight = state.regionSizes[id] > 0 ? state.regionSizes[id] : REGION_DEFAULT_WEIGHT[id];
        region.style.flex = `${weight} 1 0`;
      });
      for (let index = 1; index < regions.length; index += 1) {
        const above = regions[index - 1];
        const below = regions[index];
        const sash = document.createElement("div");
        const label = regionSashLabel(above, below);
        sash.className = "sash changes-region-sash";
        sash.setAttribute("role", "separator");
        sash.setAttribute("aria-orientation", "horizontal");
        sash.setAttribute("aria-label", label);
        sash.title = label;
        sash.addEventListener("pointerdown", (event) => startResize(event, sash, above, below, regions, persistSizes, MIN_REGION));
        below.insertBefore(sash, below.firstChild);
      }
    }

    /** 인접 정보 영역의 지역화된 제목으로 sash의 tooltip과 접근성 이름을 만든다. */
    function regionSashLabel(above, below) {
      const labels = {
        repository: strings.repositoryContext,
        working: strings.workingChanges,
        tools: strings.tools,
      };
      return String(strings.resizeRegions)
        .replace("{0}", labels[above.dataset.changesRegion] || "")
        .replace("{1}", labels[below.dataset.changesRegion] || "");
    }

    /** resize 가능한 인접 section 쌍의 아래 section에 pointer sash를 붙인다. */
    function placeSashes(region, growable) {
      region.querySelectorAll(":scope > .section > .sash").forEach((sash) => sash.remove());
      for (let index = 1; index < growable.length; index += 1) {
        const sash = document.createElement("div");
        sash.className = "sash";
        sash.addEventListener("pointerdown", (event) => startResize(event, sash, growable[index - 1], growable[index], growable, persistSizes, MIN_SECTION));
        growable[index].insertBefore(sash, growable[index].firstChild);
      }
    }

    /** sash pointer drag 중 두 section의 높이를 최소값 안에서만 교환한다. */
    function startResize(event, sash, above, below, resizeItems, onComplete, minimum) {
      event.preventDefault();
      event.stopPropagation();
      sash.setPointerCapture(event.pointerId);
      const startY = event.clientY;
      const startAbove = above.getBoundingClientRect().height;
      const startBelow = below.getBoundingClientRect().height;
      resizeItems.forEach((item) => {
        item.style.flex = `${item.getBoundingClientRect().height} 1 0`;
      });
      sash.classList.add("active");
      document.body.classList.add("resizing");
      const onMove = (moveEvent) => {
        const delta = Math.min(startBelow - minimum, Math.max(minimum - startAbove, moveEvent.clientY - startY));
        above.style.flex = `${startAbove + delta} 1 0`;
        below.style.flex = `${startBelow - delta} 1 0`;
      };
      const onUp = () => {
        sash.releasePointerCapture(event.pointerId);
        sash.removeEventListener("pointermove", onMove);
        sash.removeEventListener("pointerup", onUp);
        sash.classList.remove("active");
        document.body.classList.remove("resizing");
        onComplete();
      };
      sash.addEventListener("pointermove", onMove);
      sash.addEventListener("pointerup", onUp);
    }

    /** 현재 펼친 section의 실제 높이를 webview state에 저장한다. */
    function persistSizes() {
      rootEl.querySelectorAll(".section:not(.collapsed)").forEach((section) => {
        state.sizes[section.dataset.section] = section.getBoundingClientRect().height;
      });
      rootEl.querySelectorAll(".changes-region").forEach((region) => {
        state.regionSizes[region.dataset.changesRegion] = region.getBoundingClientRect().height;
      });
      vscode.setState(state);
    }

    return { applyCollapse, applyResize, persistSizes };
  };
}());
