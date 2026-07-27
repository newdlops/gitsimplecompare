// Changes 아코디언의 접힘·높이 배분·sash resize 상태 모듈.
// - 섹션 HTML 생성과 분리해 렌더 뒤 DOM 레이아웃만 일관되게 적용한다.
(function () {
  "use strict";

  /** Changes renderer가 소유한 상태와 disclosure helper를 받아 layout API를 만든다. */
  window.__gscChangesSectionLayout = function createChangesSectionLayout(deps) {
    const { rootEl, state, isCollapsed, syncDisclosureControl, HEADER_H, MIN_SECTION, DEFAULT_WEIGHT, vscode } = deps;

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

    /** 펼친 섹션의 저장한 높이 비율을 적용하고 인접 section 사이에 sash를 둔다. */
    function applyResize() {
      const growable = [];
      rootEl.querySelectorAll(".section").forEach((section) => {
        const id = section.dataset.section;
        if (section.classList.contains("collapsed")) {
          section.style.flex = `0 0 ${HEADER_H}px`;
          return;
        }
        if (id === "repos") {
          const body = section.querySelector(".section-body");
          section.style.flex = `0 0 ${HEADER_H + (body ? body.scrollHeight : 0)}px`;
          return;
        }
        const weight = state.sizes[id] > 0 ? state.sizes[id] : DEFAULT_WEIGHT[id] || 160;
        section.style.flex = `${weight} 1 0`;
        growable.push(section);
      });
      placeSashes(growable);
    }

    /** resize 가능한 인접 section 쌍의 아래 section에 pointer sash를 붙인다. */
    function placeSashes(growable) {
      rootEl.querySelectorAll(".sash").forEach((sash) => sash.remove());
      for (let index = 1; index < growable.length; index += 1) {
        const sash = document.createElement("div");
        sash.className = "sash";
        sash.addEventListener("pointerdown", (event) => startResize(event, sash, growable[index - 1], growable[index]));
        growable[index].insertBefore(sash, growable[index].firstChild);
      }
    }

    /** sash pointer drag 중 두 section의 높이를 최소값 안에서만 교환한다. */
    function startResize(event, sash, above, below) {
      event.preventDefault();
      event.stopPropagation();
      sash.setPointerCapture(event.pointerId);
      const startY = event.clientY;
      const startAbove = above.getBoundingClientRect().height;
      const startBelow = below.getBoundingClientRect().height;
      rootEl.querySelectorAll(".section:not(.collapsed)").forEach((section) => {
        section.style.flex = `${section.getBoundingClientRect().height} 1 0`;
      });
      sash.classList.add("active");
      document.body.classList.add("resizing");
      const onMove = (moveEvent) => {
        const delta = Math.min(startBelow - MIN_SECTION, Math.max(MIN_SECTION - startAbove, moveEvent.clientY - startY));
        above.style.flex = `${startAbove + delta} 1 0`;
        below.style.flex = `${startBelow - delta} 1 0`;
      };
      const onUp = () => {
        sash.releasePointerCapture(event.pointerId);
        sash.removeEventListener("pointermove", onMove);
        sash.removeEventListener("pointerup", onUp);
        sash.classList.remove("active");
        document.body.classList.remove("resizing");
        persistSizes();
      };
      sash.addEventListener("pointermove", onMove);
      sash.addEventListener("pointerup", onUp);
    }

    /** 현재 펼친 section의 실제 높이를 webview state에 저장한다. */
    function persistSizes() {
      rootEl.querySelectorAll(".section:not(.collapsed)").forEach((section) => {
        state.sizes[section.dataset.section] = section.getBoundingClientRect().height;
      });
      vscode.setState(state);
    }

    return { applyCollapse, applyResize, persistSizes };
  };
}());
