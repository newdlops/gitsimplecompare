// Changes 웹뷰의 드롭다운·컨텍스트 메뉴 renderer.
// - 메인 Changes renderer와 분리해 menu focus, submenu, 화면 경계 배치 책임을 한 곳에서 관리한다.
(function () {
  "use strict";

  /** Changes renderer가 전달한 VS Code bridge와 action helper로 메뉴 API를 만든다. */
  window.__gscChangesMenu = function createChangesMenu({ vscode, esc, doCommit }) {
    let dropdownEl = null;

    /** 바깥 mousedown이면 메뉴를 닫되 앵커와 메뉴 내부 클릭은 유지한다. */
    function onDocDown(event) {
      if (!dropdownEl) return;
      const anchor = dropdownEl.__anchor;
      if (dropdownEl.contains(event.target) || (anchor && (anchor === event.target || anchor.contains(event.target)))) return;
      closeDropdown();
    }

    /** Escape는 메뉴를 닫고 원래 앵커로 키보드 포커스를 되돌린다. */
    function onDocKey(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeDropdown(true);
    }

    /** 열린 메뉴를 제거하고 document listener를 정리한다. */
    function closeDropdown(restoreFocus = false) {
      const anchor = dropdownEl?.__anchor;
      if (dropdownEl) {
        anchor?.setAttribute("aria-expanded", "false");
        dropdownEl.remove();
        dropdownEl = null;
      }
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onDocKey, true);
      if (restoreFocus && anchor?.isConnected) {
        // 포인터가 행을 떠났어도 focus-within으로 hover 전용 버튼을 먼저 노출한다.
        anchor.closest(".row[tabindex]")?.focus({ preventScroll: true });
        anchor.focus({ preventScroll: true });
      }
    }

    /** 구분선 요소를 만든다. */
    function menuDivider() {
      const divider = document.createElement("div");
      divider.className = "menu-sep";
      divider.setAttribute("role", "separator");
      return divider;
    }

    /** role=menuitem에 Enter/Space 활성화와 tooltip/accessibility 이름을 부여한다. */
    function bindMenuItem(item, label) {
      item.title = label;
      item.dataset.tooltip = label;
      item.setAttribute("aria-label", label);
      item.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        item.click();
      });
    }

    /** 앵커 버튼 아래에 드롭다운을 연다. */
    function openDropdown(anchor, rootNodes) {
      openMenu(rootNodes, { anchor });
    }

    /** 마우스 좌표에 컨텍스트 메뉴를 연다. */
    function openContextMenu(x, y, rootNodes) {
      openMenu(rootNodes, { x, y });
    }

    /** menuitem 사이의 키보드 이동과 submenu 진입·복귀를 연결한다. */
    function bindMenuKeyboard(stack, reposition, renderTop) {
      const menu = dropdownEl;
      menu.addEventListener("keydown", (event) => {
        // capture 단계의 Escape 또는 menuitem의 Enter가 이미 메뉴를 닫았으면 처리를 끝낸다.
        if (dropdownEl !== menu) return;
        const items = Array.from(dropdownEl.querySelectorAll('[role="menuitem"]'));
        if (!items.length) return;
        const current = items.indexOf(document.activeElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
            (current + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
          focusMenuItem(items, next);
          return;
        }
        if (event.key === "ArrowRight" && document.activeElement?.dataset.hasSubmenu === "true") {
          event.preventDefault();
          document.activeElement.click();
          return;
        }
        if (event.key === "ArrowLeft" && stack.length > 1) {
          event.preventDefault();
          stack.pop();
          renderTop();
          reposition();
        }
      });
    }

    /** roving tabindex를 갱신해 Tab은 현재 menuitem 하나만 통과하도록 만든다. */
    function focusMenuItem(items, index) {
      items.forEach((item, itemIndex) => { item.tabIndex = itemIndex === index ? 0 : -1; });
      items[index]?.focus();
    }

    /** submenu를 같은 surface에서 drill-down하고 리프 action을 host로 전달한다. */
    function openMenu(rootNodes, place) {
      closeDropdown();
      dropdownEl = document.createElement("div");
      dropdownEl.className = "menu";
      dropdownEl.setAttribute("role", "menu");
      dropdownEl.__anchor = place.anchor || null;
      dropdownEl.__anchor?.setAttribute("aria-expanded", "true");
      document.body.appendChild(dropdownEl);

      const reposition = () => place.anchor
        ? positionMenu(place.anchor.getBoundingClientRect(), true)
        : positionMenu({ left: place.x, right: place.x, top: place.y, bottom: place.y }, false);
      const stack = [{ nodes: rootNodes, title: null }];
      const renderTop = () => {
        const top = stack[stack.length - 1];
        dropdownEl.replaceChildren();
        if (stack.length > 1) {
          const back = document.createElement("div");
          const label = top.title || "";
          back.className = "menu-item menu-back";
          back.setAttribute("role", "menuitem");
          back.tabIndex = -1;
          back.innerHTML = `<span class="codicon codicon-chevron-left" aria-hidden="true"></span><span class="menu-label">${esc(label)}</span>`;
          bindMenuItem(back, label);
          back.addEventListener("click", (event) => {
            event.stopPropagation();
            stack.pop();
            renderTop();
            reposition();
          });
          dropdownEl.append(back, menuDivider());
        }
        for (const node of top.nodes) {
          if (node.separator) {
            dropdownEl.append(menuDivider());
            continue;
          }
          const hasSubmenu = Boolean(node.submenu?.length);
          const item = document.createElement("div");
          const label = node.label || "";
          item.className = "menu-item";
          item.setAttribute("role", "menuitem");
          item.tabIndex = -1;
          if (hasSubmenu) {
            item.setAttribute("aria-haspopup", "menu");
            item.dataset.hasSubmenu = "true";
          }
          item.innerHTML =
            `<span class="menu-check codicon ${node.checked ? "codicon-check" : ""}" aria-hidden="true"></span>` +
            `<span class="menu-label">${esc(label)}</span>` +
            (hasSubmenu ? '<span class="menu-sub codicon codicon-chevron-right" aria-hidden="true"></span>' : "");
          bindMenuItem(item, label);
          item.addEventListener("click", (event) => {
            event.stopPropagation();
            if (hasSubmenu) {
              stack.push({ nodes: node.submenu, title: node.label });
              renderTop();
              reposition();
            } else if (node.onClick) {
              node.onClick();
              closeDropdown();
            } else if (node.id) {
              const commitOperation = window.__gscCommitOperationForMenuId?.(node.id);
              if (commitOperation) doCommit(commitOperation);
              else vscode.postMessage({ type: "scmAction", action: node.id });
              closeDropdown();
            }
          });
          dropdownEl.append(item);
        }
        focusMenuItem(Array.from(dropdownEl.querySelectorAll('[role="menuitem"]')), 0);
      };
      bindMenuKeyboard(stack, reposition, renderTop);
      renderTop();
      reposition();
      document.addEventListener("mousedown", onDocDown, true);
      document.addEventListener("keydown", onDocKey, true);
    }

    /** 메뉴를 기준 사각형에 맞추고 화면 밖으로 나가면 위·안쪽으로 보정한다. */
    function positionMenu(rect, rightAlign) {
      if (!dropdownEl) return;
      dropdownEl.style.position = "fixed";
      dropdownEl.style.visibility = "hidden";
      dropdownEl.style.left = "0px";
      dropdownEl.style.top = "0px";
      const menuRect = dropdownEl.getBoundingClientRect();
      let left = rightAlign ? rect.right - menuRect.width : rect.left;
      left = Math.max(4, Math.min(left, window.innerWidth - 4 - menuRect.width));
      let top = rect.bottom + 2;
      if (top + menuRect.height > window.innerHeight - 4) {
        top = rect.top - menuRect.height - 2;
        if (top < 4) top = Math.max(4, window.innerHeight - 4 - menuRect.height);
      }
      dropdownEl.style.left = `${left}px`;
      dropdownEl.style.top = `${top}px`;
      dropdownEl.style.visibility = "visible";
    }

    /** 지정한 control이 현재 열린 드롭다운의 앵커인지 반환한다. */
    function isDropdownAnchor(anchor) {
      return dropdownEl?.__anchor === anchor;
    }

    /**
     * 섹션별 보기 전환과 Changes 전용 저장소 액션을 기존 SCM 메뉴에서 선택한다.
     * @param sectionId 메뉴를 연 섹션 @param payload 현재 표시 상태
     * @param scmMenu 확장이 지역화해 주입한 메뉴 트리 @param labels 보기 전환 라벨
     * @returns 현재 섹션에 맞는 메뉴 항목이며 브랜치 정리는 Changes에만 노출한다.
     */
    function accordionMenuNodes(sectionId, payload, scmMenu, labels) {
      const nodes = [];
      const viewMode = sectionId === "changes" ? payload?.changes.viewMode
        : sectionId === "compare" && payload?.compare.mode === "comparison" ? payload.compare.viewMode : undefined;
      if (viewMode) {
        nodes.push({
          label: viewMode === "list" ? labels.viewAsTree : labels.viewAsList,
          onClick: () => vscode.postMessage({ type: "toggleViewMode", section: sectionId }),
        });
      }
      if (sectionId === "changes") {
        const actions = ["configureRemoteBranch", "cleanupStaleBranches"]
          .map(id => findMenuNode(scmMenu, id)).filter(Boolean);
        if (nodes.length && actions.length) nodes.push({ separator: true });
        nodes.push(...actions);
      }
      return nodes;
    }

    /** 주입된 SCM 하위 메뉴에서도 정확한 액션 ID에 해당하는 지역화된 행을 찾는다. */
    function findMenuNode(nodes, id) {
      for (const node of nodes || []) {
        if (node?.id === id) return node;
        const found = node?.submenu && findMenuNode(node.submenu, id);
        if (found) return found;
      }
      return undefined;
    }

    return { closeDropdown, isDropdownAnchor, openDropdown, openContextMenu, accordionMenuNodes };
  };
}());
