// Changes의 persisted section 상태와 렌더 전후 포커스/스크롤 복원을 담당한다.
(function () {
  "use strict";
  /** 호스트 브리지와 root를 받아 공유 상태 및 layout/복원 API를 만든다. payload는 복원 시점에 읽는다. */
  window.__gscChangesViewState = function createChangesViewState({ rootEl, vscode, strings: T, getLastPayload, closeDropdown, scheduleLists }) {
    let draggingSectionId = null, suppressHeaderClick = false;
    let state = vscode.getState() || {};
    state.collapsed = state.collapsed || {};
    // 새 웹뷰의 Worktrees는 기본 접힘으로 두고 실제로 펼칠 때만 별도 git worktree 조회를 시작한다.
    if (!Object.prototype.hasOwnProperty.call(state.collapsed, "worktrees")) {
      state.collapsed.worktrees = true;
    }
    state.sizes = state.sizes || {};
    state.groups = state.groups || {}; // Staged/Changes 그룹 접힘 상태
    state.folders = state.folders || {}; // 파일 트리 폴더 접힘 상태(kind:path)
    state.stashExpanded = state.stashExpanded || {}; // stash 펼침 상태(ref/hash별)
    state.historyExpanded = state.historyExpanded || {}; // history 커밋 상세 펼침 상태(hash별)
    state.commitMessageRevision = state.commitMessageRevision || 0;
    const SECTION_IDS = [
      "repos",
      "changes",
      "history",
      "compare",
      "stashes",
      "worktrees",
    ];
    state.sectionOrder = normalizeSectionOrder(state.sectionOrder);
    state.visibleSections = normalizeVisibleSections(state.visibleSections);
    const isCollapsed = (id) => !!state.collapsed[id];

    /**
     * disclosure 컨트롤의 현재 펼침 상태를 지역화된 다음 동작 tooltip 으로 바꾼다.
     * @param {string} label 사용자가 구분할 수 있는 섹션 또는 그룹 이름
     * @param {boolean} expanded 현재 본문이 펼쳐져 있으면 true
     * @returns {string} 클릭했을 때 수행될 Collapse/Expand 동작 문구
     */
    function disclosureTooltip(label, expanded) {
      const template = expanded ? T.collapseSection : T.expandSection;
      return String(template).replace("{0}", label);
    }

    /**
     * 접기/펼치기 컨트롤의 tooltip, 접근성 이름, aria-expanded 를 한 번에 동기화한다.
     * @param {HTMLElement | null} control 상태를 반영할 button 또는 동등한 컨트롤
     * @param {boolean} expanded 컨트롤이 담당하는 본문이 현재 펼쳐져 있는지 여부
     */
    function syncDisclosureControl(control, expanded) {
      if (!control) {
        return;
      }
      const label = control.dataset.disclosureLabel || control.textContent?.trim() || "Section";
      const tooltip = disclosureTooltip(label, expanded);
      control.title = tooltip;
      control.dataset.tooltip = tooltip;
      control.setAttribute("aria-label", tooltip);
      control.setAttribute("aria-expanded", expanded ? "true" : "false");
    }
    /** 지정 섹션의 접힘을 토글해 웹뷰 재연결 뒤에도 동일한 상태를 복원한다. */
    function toggleSection(id) {
      state.collapsed[id] = !state.collapsed[id];
      vscode.setState(state);
    }

    /** 저장된 섹션 순서를 현재 섹션 목록에 맞춰 정규화한다. */
    function normalizeSectionOrder(order) {
      const saved = Array.isArray(order) ? order.filter((id) => SECTION_IDS.includes(id)) : [];
      return [...saved, ...SECTION_IDS.filter((id) => !saved.includes(id))];
    }

    /** 현재 저장된 섹션 순서대로 HTML 을 이어 붙인다. */
    function orderedSections(sectionHtml) {
      return state.sectionOrder
        .filter((id) => state.visibleSections[id] !== false)
        .map((id) => sectionHtml[id] || "")
        .join("");
    }

    /** 저장된 섹션 표시 상태를 정규화하고, 모두 숨김이면 기본 섹션을 되살린다. */
    function normalizeVisibleSections(saved) {
      const visible = {};
      for (const id of SECTION_IDS) {
        visible[id] = !(saved && saved[id] === false);
      }
      if (!SECTION_IDS.some((id) => visible[id])) {
        visible.changes = true;
      }
      return visible;
    }

    // 섹션 리사이즈(네이티브 PaneView 풍) 상수: 헤더 높이 / 크기조절 섹션의 최소 높이.
    const HEADER_H = 22;
    const MIN_SECTION = 48;
    // 크기조절(grow) 대상 섹션의 기본 가중치(비율).
    const DEFAULT_WEIGHT = {
      repos: 120,
      changes: 240,
      history: 180,
      compare: 240,
      stashes: 120,
      worktrees: 140,
    };

    /** 렌더 직전 사용자가 조작 중인 일시 상태를 캡처한다. */
    function captureTransientUi() {
      const active = document.activeElement;
      const focus =
        active && rootEl.contains(active)
          ? {
              id: active.id || "",
              value: typeof active.value === "string" ? active.value : undefined,
              selectionStart:
                typeof active.selectionStart === "number"
                  ? active.selectionStart
                  : undefined,
              selectionEnd:
                typeof active.selectionEnd === "number"
                  ? active.selectionEnd
                  : undefined,
            }
          : null;
      const sectionScroll = {};
      rootEl.querySelectorAll(".section").forEach((sec) => {
        const body = sec.querySelector(".section-body");
        if (body) {
          sectionScroll[sec.dataset.section] = {
            top: body.scrollTop,
            left: body.scrollLeft,
          };
        }
      });
      return {
        rootTop: rootEl.scrollTop,
        rootLeft: rootEl.scrollLeft,
        sectionScroll,
        focus,
      };
    }

    /** 렌더 후 입력 포커스/커서와 스크롤 위치를 되돌린다. */
    function restoreTransientUi(snapshot, previousCommitMessageRevision) {
      if (!snapshot) {
        return;
      }
      rootEl.scrollTop = snapshot.rootTop || 0;
      rootEl.scrollLeft = snapshot.rootLeft || 0;
      rootEl.querySelectorAll(".section").forEach((sec) => {
        const saved = snapshot.sectionScroll[sec.dataset.section];
        const body = sec.querySelector(".section-body");
        if (saved && body) {
          body.scrollTop = saved.top || 0;
          body.scrollLeft = saved.left || 0;
        }
      });
      if (!snapshot.focus?.id) {
        return;
      }
      const next = document.getElementById(snapshot.focus.id);
      if (!next) {
        return;
      }
      const commitRevision = getLastPayload()?.commit?.messageRevision || 0;
      const hasProgrammaticCommitMessage =
        next.id === "commit-msg" && commitRevision !== previousCommitMessageRevision;
      if (hasProgrammaticCommitMessage) {
        next.focus({ preventScroll: true });
        if (typeof next.setSelectionRange === "function") {
          const end = next.value.length;
          next.setSelectionRange(end, end);
        }
        return;
      }
      if (typeof snapshot.focus.value === "string" && "value" in next) {
        next.value = snapshot.focus.value;
        if (next.id === "commit-msg") {
          vscode.postMessage({
            type: "commitMessageChange",
            message: next.value,
          });
        }
      }
      next.focus({ preventScroll: true });
      if (
        typeof next.setSelectionRange === "function" &&
        snapshot.focus.selectionStart !== undefined &&
        snapshot.focus.selectionEnd !== undefined
      ) {
        next.setSelectionRange(
          snapshot.focus.selectionStart,
          snapshot.focus.selectionEnd
        );
      }
    }

    // collapse와 sash resize는 section layout 모듈이 일관된 persisted state로 적용한다.
    const { applyCollapse, applyResize, persistSizes } = window.__gscChangesSectionLayout({
      rootEl,
      state,
      isCollapsed,
      syncDisclosureControl,
      HEADER_H,
      MIN_SECTION,
      DEFAULT_WEIGHT,
      strings: T,
      vscode,
    });


    /** 아코디언 섹션 헤더 드래그로 섹션 순서를 바꿀 수 있게 연결한다. */
    function bindSectionDrag() {
      rootEl.querySelectorAll(".section-header").forEach((header) => {
        header.draggable = true;
        header.addEventListener("dragstart", (e) => {
          if (e.target.closest(".header-actions")) {
            e.preventDefault();
            return;
          }
          const section = header.closest(".section");
          draggingSectionId = section.dataset.section;
          suppressHeaderClick = true;
          closeDropdown();
          section.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", draggingSectionId);
        });
        header.addEventListener("dragend", () => {
          clearSectionDropMarkers();
          rootEl.querySelector(".section.dragging")?.classList.remove("dragging");
          draggingSectionId = null;
          window.setTimeout(() => {
            suppressHeaderClick = false;
          }, 100);
        });
      });
      rootEl.querySelectorAll(".section").forEach((section) => {
        section.addEventListener("dragover", (e) => {
          if (!draggingSectionId || section.dataset.section === draggingSectionId) {
            return;
          }
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          markSectionDrop(section, sectionDropSide(section, e.clientY));
        });
        section.addEventListener("dragleave", (e) => {
          if (!section.contains(e.relatedTarget)) {
            section.classList.remove("drop-before", "drop-after");
          }
        });
        section.addEventListener("drop", (e) => {
          if (!draggingSectionId || section.dataset.section === draggingSectionId) {
            return;
          }
          e.preventDefault();
          moveSection(draggingSectionId, section.dataset.section, sectionDropSide(section, e.clientY));
        });
      });
    }

    /** 드래그 중인 섹션을 대상 섹션 앞/뒤로 옮기고 순서를 저장한다. */
    function moveSection(sourceId, targetId, side) {
      const source = rootEl.querySelector(`.section[data-section="${sourceId}"]`);
      const target = rootEl.querySelector(`.section[data-section="${targetId}"]`);
      if (!window.__gscChangesInformationArchitecture?.sameRegion(source, target)) {
        clearSectionDropMarkers();
        return;
      }
      const next = state.sectionOrder.filter((id) => id !== sourceId);
      const targetIndex = next.indexOf(targetId);
      if (targetIndex < 0) {
        return;
      }
      next.splice(side === "after" ? targetIndex + 1 : targetIndex, 0, sourceId);
      state.sectionOrder = normalizeSectionOrder(next);
      vscode.setState(state);
      const region = source.parentElement;
      for (const id of state.sectionOrder) {
        const section = rootEl.querySelector(`.section[data-section="${id}"]`);
        if (section && section.parentElement === region) {
          region.appendChild(section);
        }
      }
      clearSectionDropMarkers();
      applyResize();
      persistSizes();
      scheduleLists();
    }

    /** 포인터 Y 위치가 섹션 위/아래 절반 중 어디인지 반환한다. */
    function sectionDropSide(section, clientY) {
      const rect = section.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2 ? "before" : "after";
    }

    /** 섹션 drop 위치 표시선을 갱신한다. */
    function markSectionDrop(section, side) {
      clearSectionDropMarkers();
      section.classList.add(side === "before" ? "drop-before" : "drop-after");
    }

    /** 모든 섹션 drop 표시선을 제거한다. */
    function clearSectionDropMarkers() {
      rootEl.querySelectorAll(".drop-before, .drop-after").forEach((section) => {
        section.classList.remove("drop-before", "drop-after");
      });
    }
    /** 드래그 직후 생기는 헤더 click 한 번을 소비해 의도치 않은 접힘을 막는다. */
    function consumeHeaderClick() {
      if (!suppressHeaderClick) return false;
      suppressHeaderClick = false;
      return true;
    }

    return { state, isCollapsed, disclosureTooltip, syncDisclosureControl, toggleSection,
      normalizeVisibleSections, orderedSections, captureTransientUi, restoreTransientUi,
      applyCollapse, applyResize, bindSectionDrag, consumeHeaderClick };
  };
})();
