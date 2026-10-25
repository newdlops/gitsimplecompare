// 큰 Graph의 실제 행을 작은 렌더링 묶음으로 나눈다.
// - 모든 행·배지·텍스트는 DOM에 남겨 검색과 접근성 트리를 유지한다.
// - 바깥/안쪽 top을 상쇄해 기존 row.offsetTop과 SVG의 전역 좌표도 그대로 유지한다.
(function () {
  "use strict";

  const GROUP_SIZE = 32;
  const SMALL_GRAPH_LIMIT = 600;
  const states = new WeakMap();

  /**
   * 일반 캔버스와 이 모듈이 만든 행 컨테이너만 인정한다.
   * @param root 현재 Graph 캔버스
   * @param container 행의 부모로 확인할 DOM
   * @returns 다른 캔버스나 임의의 중첩 요소를 제외한 소유 여부
   */
  function isRowContainer(root, container) {
    return !!container && (container === root ||
      (container.classList.contains("graph-row-group-content") &&
        container.parentElement?.classList.contains("graph-row-group") &&
        container.parentElement.parentElement === root));
  }

  /**
   * 직접 행과 같은 캔버스의 묶음 안에 있는 행을 동일하게 취급한다.
   * @param root 행을 소유해야 하는 캔버스
   * @param row 캐시 또는 selector에서 얻은 행. 없으면 false다.
   * @returns 삭제되거나 다른 캔버스로 이동한 행은 false
   */
  function owns(root, row) {
    return isRowContainer(root, row?.parentElement);
  }

  /**
   * 전체 교체 전에 observer와 이전 DOM의 강한 참조를 해제한다.
   * @param root 비우거나 새 모델로 교체할 캔버스
   * @returns 상태가 없어도 안전하게 끝난다. 행 자체는 호출자가 제거한다.
   */
  function reset(root) {
    const state = states.get(root);
    state?.observer?.disconnect();
    state?.groups.clear();
    state?.measured.clear();
    states.delete(root);
  }

  /**
   * 그룹 경계가 같을 때 style mutation과 후속 observer 호출을 만들지 않는다.
   * @param element 위치를 소유한 요소
   * @param key top 또는 height
   * @param pixels 전역 좌표로 계산한 CSS pixel 값
   * @returns 필요한 style만 변경한다.
   */
  function setPixels(element, key, pixels) {
    const value = pixels + "px";
    if (element.style[key] !== value) element.style[key] = value;
  }

  /**
   * 실제 첫/마지막 행을 감싸되 행의 전역 offsetTop은 바꾸지 않는다.
   * reflog가 top을 이동해도 이 범위를 다시 계산하므로 묶음 경계에서 행이 잘리지 않는다.
   * @param group 현재 캔버스에 붙은 한 렌더링 묶음
   * @param rowHeight graph.js와 공유하는 한 행의 CSS pixel 높이
   * @returns layout getter 없이 inline top만 읽고 변경된 경계만 쓴다.
   */
  function positionGroup(group, rowHeight) {
    const content = group.firstElementChild;
    const first = content?.firstElementChild, last = content?.lastElementChild;
    if (!first || !last) return;
    // 검색 outline이 첫/마지막 행의 바깥에 그려질 여유도 함께 확보한다.
    const start = parseFloat(first.style.top) - 2;
    const bottom = parseFloat(last.style.top) + rowHeight + 2;
    if (!Number.isFinite(start) || !Number.isFinite(bottom)) return;
    setPixels(group, "top", start);
    setPixels(group, "height", bottom - start);
    setPixels(content, "top", -start);
  }

  /**
   * 부분 교체와 reflog 위치 변경을 한 microtask의 그룹 갱신으로 합친다.
   * @param root observer가 읽을 현재 캔버스
   * @param state 그룹 높이와 observer 수명을 소유하는 상태
   * @returns 아직 관찰을 시작하지 않은 observer. 최초 DOM 조립 뒤 연결한다.
   */
  function createObserver(root, state) {
    return new MutationObserver(records => {
      const changed = new Set();
      for (const record of records) {
        const target = record.target.nodeType === Node.ELEMENT_NODE
          ? record.target : record.target.parentElement;
        // 그룹 자신의 top/height 쓰기와 색상 변경은 다시 위치 계산을 예약하지 않는다.
        if (record.type === "attributes" && !target?.classList.contains("row")) continue;
        const group = target?.closest(".graph-row-group");
        if (group?.parentElement === root) changed.add(group);
      }
      changed.forEach(group => positionGroup(group, state.rowHeight));
    });
  }

  /**
   * 한 인덱스 범위의 묶음을 한 번만 만들어 기존 행 identity를 유지한다.
   * @param root 그룹을 붙일 캔버스
   * @param state 이 캔버스의 그룹 Map
   * @param index 실제 모델 행 인덱스
   * @returns 행을 추가할 바깥 그룹. 첫 자식이 행 컨테이너다.
   */
  function groupFor(root, state, index) {
    const key = Math.floor(index / GROUP_SIZE);
    let group = state.groups.get(key);
    if (!group) {
      group = document.createElement("div");
      group.className = "graph-row-group";
      const content = document.createElement("div");
      content.className = "graph-row-group-content";
      group.append(content);
      state.groups.set(key, group);
      root.append(group);
    }
    return group;
  }

  /**
   * 새 Graph 세대의 상태를 만들되 아직 조립 중인 DOM은 관찰하지 않는다.
   * @param root 수명을 소유할 캔버스
   * @param rowHeight 실제 renderer와 같은 행 높이
   * @returns 전체 교체 시 reset으로 해제할 상태
   */
  function createState(root, rowHeight) {
    const state = { groups: new Map(), measured: new Set(), rowHeight, observer: undefined };
    state.observer = createObserver(root, state);
    states.set(root, state);
    return state;
  }

  /**
   * 작은 페이지는 기존 DOM을 쓰고 큰 누적 이력만 그룹으로 나눈다.
   * 처음 임계값을 넘으면 기존 행을 이동하므로 같은 버튼의 키보드 포커스도 복구한다.
   * @param root 실제 Graph 캔버스
   * @param fragment 새로 생성한 모델 행들. 호출 후 비워진다.
   * @param totalRows 모델의 전체 행 수. SVG/가상 reflog 행은 포함하지 않는다.
   * @param rowHeight graph.js의 고정 행 높이
   * @returns 행 순서·identity·전역 top을 유지한 채 필요한 묶음만 만든다.
   */
  function append(root, fragment, totalRows, rowHeight) {
    let state = states.get(root);
    if (state && [...state.groups.values()].some(group => group.parentElement !== root)) {
      reset(root);
      state = undefined;
    }
    if ((!state && totalRows <= SMALL_GRAPH_LIMIT) || !Number.isFinite(rowHeight) || rowHeight <= 0) {
      root.append(fragment);
      return;
    }
    const firstGrouping = !state;
    const previousGroups = firstGrouping ? [...root.querySelectorAll(":scope > .graph-row-group")] : [];
    const existing = root.querySelectorAll(firstGrouping
      ? ":scope .row:not([data-reflog-virtual])" : ":scope > .row:not([data-reflog-virtual])");
    const pending = [...existing, ...fragment.children];
    if (!pending.length) return;
    state ||= createState(root, rowHeight);
    const focused = document.activeElement, restoreFocus = root.contains(focused);
    const changed = new Set();
    for (const row of pending) {
      const group = groupFor(root, state, Number(row.dataset.index));
      group.firstElementChild.append(row);
      changed.add(group);
    }
    previousGroups.forEach(group => group.remove());
    changed.forEach(group => positionGroup(group, state.rowHeight));
    if (firstGrouping) state.observer.observe(root, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["style"],
    });
    if (restoreFocus && document.activeElement !== focused && root.contains(focused)) {
      focused.focus({ preventScroll: true });
    }
  }

  /**
   * 가장 긴 후보 행의 그룹만 화면 밖에서도 자연 폭을 정확히 측정한다.
   * 그룹 폭 자체는 캔버스 100%여서 가로 스크롤된 화면에서도 새 행을 올바르게 드러낸다.
   * @param root 폭을 조절할 현재 캔버스
   * @param rows RowSync가 고른 최대 24개의 폭 후보
   * @returns 이전 후보의 강제 표시를 해제하고 새 후보 그룹만 유지한다.
   */
  function measure(root, rows) {
    const state = states.get(root);
    if (!state) return;
    const next = new Set();
    for (const row of rows) {
      const group = row.closest(".graph-row-group");
      if (group?.parentElement === root) next.add(group);
    }
    state.measured.forEach(group => {
      if (!next.has(group)) group.classList.remove("graph-width-measure-group");
    });
    next.forEach(group => {
      if (!state.measured.has(group)) group.classList.add("graph-width-measure-group");
    });
    state.measured = next;
  }

  window.GscGraphRowGroups = { append, owns, isRowContainer, measure, reset };
})();
