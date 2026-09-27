// Changes 작업트리(Staged/Changes) 파일 목록을 평면 행 모델 + 가상 스크롤로 렌더하는 모듈.
// - 수만 개 변경에서도 DOM 은 화면에 보이는 행(+overscan)만 유지해 렌더·클릭·스크롤이 목록 크기와 무관하게 빠르다.
// - 선택 범위, 폴더 하위 경로, 선택 유효성은 DOM 이 아니라 이 모델로 계산해 화면 밖 행도 정확히 다룬다.
// - 행 HTML 조각(아이콘/통계/액션)과 이벤트 처리는 주입받아, 메인 renderer 와 같은 모양·동작을 유지한다.
// - 웹뷰 CSP 는 HTML 로 파싱된 style 속성을 막으므로 spacer 높이·행 위치·들여쓰기는 모두 CSSOM 으로 설정한다.
(function () {
  "use strict";

  /** CSS `.row` 높이와 같아야 하는 고정 행 높이(px). */
  const ROW_HEIGHT = 22;
  /** 보이는 영역 위/아래로 미리 그려 둘 행 수. 빠른 스크롤·작은 레이아웃 이동에도 빈칸이 보이지 않게 한다. */
  const OVERSCAN_ROWS = 12;
  /** 이 이하의 작은 목록은 가상화 없이 모든 행을 그린다(같은 모델 경로, 범위만 전체). */
  const FULL_RENDER_MAX_ROWS = 300;

  /**
   * 작업트리 목록 가상화 API 를 만든다.
   * @param {object} deps 메인 renderer 가 소유한 상태·HTML 조각·이벤트 연결 함수
   * @param {HTMLElement} deps.rootEl Changes 웹뷰 root
   * @param {object} deps.state 폴더 접힘(`state.folders`)을 담은 persisted webview state
   * @param {object} deps.strings 지역화 문자열(T)
   * @param {(value: unknown) => string} deps.esc HTML escape 함수
   * @param {(status: string) => string} deps.statusCodicon 상태 codicon class 계산 함수
   * @param {(path: string) => string} deps.fileIconHtml 파일 아이콘 HTML 조각
   * @param {(change: object) => string} deps.statHtml +/- 통계 HTML 조각
   * @param {(count: number) => string} deps.conflictBadgeHtml 충돌 배지 HTML 조각
   * @param {(kind: string, isFile: boolean) => string} deps.rowActionsHtml 행 hover 액션 HTML 조각
   * @param {(container: HTMLElement) => void} deps.bindRows 행 이벤트를 container 에 위임 연결하는 함수
   * @param {(rows: HTMLElement[]) => void} deps.afterRowsRendered 새로 그린 행에 선택/진행/아이콘 상태를 적용하는 함수
   * @param {() => void} deps.persistState 폴더 접힘 변경 뒤 webview state 를 저장하는 함수
   * @returns {object} 목록 HTML 생성, mount, 모델 조회, 폴더 토글 API
   */
  window.__gscChangesWorkingList = function createChangesWorkingList(deps) {
    const { rootEl, state, strings, esc } = deps;
    /** kind(staged/unstaged) → 현재 payload 기준 그룹 모델. */
    let groups = new Map();
    let focusedKey = null;
    let restoreFocusKey = null;
    let frame = 0;
    const boundScrollers = new WeakSet();
    const boundContainers = new WeakSet();
    const observed = new Set();
    const resizeObserver =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => scheduleRender()) : null;

    /** 저장소 상대 경로와 그룹 종류로 선택/접힘 공용 key 를 만든다(기존 rowKey 형식과 동일). */
    function keyOf(kind, path) {
      return `${kind}:${path}`;
    }

    /** 노드가 가리키는 저장소 상대 경로를 반환한다. */
    function nodePath(node) {
      return node.kind === "folder" ? node.path : node.change.path;
    }

    /**
     * 새 payload 렌더를 시작한다. 이전 그룹 모델을 버리고, 작업트리 행에 있던 포커스를 기억한다.
     * - HTML 문자열을 만들기 전에 호출해야 innerHTML 교체 전의 activeElement 를 읽을 수 있다.
     */
    function beginRender() {
      restoreFocusKey = activeRowKey();
      groups = new Map();
    }

    /**
     * 그룹 하나의 모델을 만들고 가상 스크롤 컨테이너 HTML 을 반환한다.
     * - `.rows` 는 전체 높이 spacer 이고 실제 행은 mount 뒤 보이는 범위만 채운다.
     * @param {string} kind staged 또는 unstaged
     * @param {Array} nodes host 가 보낸 트리/리스트 노드
     * @param {string} viewMode tree 또는 list
     * @param {string} elementId 그룹 헤더 aria-controls 가 가리킬 id
     * @returns {string} 파일 목록 컨테이너 HTML
     */
    function groupFilesHtml(kind, nodes, viewMode, elementId) {
      const group = buildGroup(kind, nodes, viewMode);
      groups.set(kind, group);
      return (
        `<div id="${esc(elementId)}" class="files ${esc(kind)}-files wt-files" ` +
        `data-working-kind="${esc(kind)}"><div class="rows"></div></div>`
      );
    }

    /**
     * 노드 트리 전체를 한 번 순회해 key 색인·폴더 충돌 수를 만들고, 접힘을 반영한 행 목록을 펼친다.
     * @param {string} kind staged 또는 unstaged
     * @param {Array} nodes 루트 노드 배열
     * @param {string} viewMode tree 또는 list
     * @returns {object} 그룹 모델
     */
    function buildGroup(kind, nodes, viewMode) {
      const nodesByKey = new Map();
      const folderConflicts = new Map();
      /** 하위 파일 충돌 수를 누적하면서 모든 노드를 key 색인에 넣는다(접힌 폴더 포함). */
      const visit = (node) => {
        if (node.kind === "folder") {
          let conflicts = 0;
          for (const child of node.children) {
            conflicts += visit(child);
          }
          nodesByKey.set(keyOf(kind, node.path), node);
          folderConflicts.set(node, conflicts);
          return conflicts;
        }
        nodesByKey.set(keyOf(kind, node.change.path), node);
        return node.change.status === "U" ? 1 : 0;
      };
      nodes.forEach(visit);
      const group = {
        kind,
        nodes,
        viewMode,
        nodesByKey,
        folderConflicts,
        folderPaths: new Map(),
        rows: [],
        indexByKey: new Map(),
        container: null,
        rowsEl: null,
        rendered: new Map(),
      };
      flattenGroup(group);
      return group;
    }

    /**
     * 폴더 접힘 상태를 반영해 화면 순서대로 행 목록과 key → index 색인을 다시 만든다.
     * @param {object} group 행을 다시 펼칠 그룹 모델
     */
    function flattenGroup(group) {
      const rows = [];
      const indexByKey = new Map();
      /** 펼쳐진 폴더만 자식까지 내려가며 depth 를 기록한다. */
      const walk = (list, depth) => {
        for (const node of list) {
          const key = keyOf(group.kind, nodePath(node));
          indexByKey.set(key, rows.length);
          rows.push({ key, node, depth });
          if (node.kind === "folder" && !state.folders[key]) {
            walk(node.children, depth + 1);
          }
        }
      };
      walk(group.nodes, 0);
      group.rows = rows;
      group.indexByKey = indexByKey;
    }

    /**
     * innerHTML 로 막 삽입된 그룹 컨테이너를 모델과 연결하고 spacer 높이를 정한다.
     * - 호출부가 스크롤 위치를 되돌리기 전에 불러야 한다. spacer 가 없으면 scrollTop 이 0 으로 잘린다.
     * - scroll/resize 리스너는 요소마다 한 번만 연결해 부분 렌더가 반복돼도 누적되지 않는다.
     * - 행은 아직 그리지 않는다. 스크롤 복원 뒤 renderVisibleRows 로 보이는 범위를 그린다.
     * @param {ParentNode} scope 방금 innerHTML 로 교체한 범위(root 또는 Changes section body)
     */
    function attach(scope) {
      scope.querySelectorAll(".wt-files[data-working-kind]").forEach((container) => {
        const group = groups.get(container.dataset.workingKind);
        if (!group) {
          return;
        }
        group.container = container;
        group.rowsEl = container.querySelector(":scope > .rows");
        group.rowsEl.style.height = `${group.rows.length * ROW_HEIGHT}px`;
        group.rendered = new Map();
        if (!boundContainers.has(container)) {
          boundContainers.add(container);
          deps.bindRows(container);
          container.addEventListener("focusin", onFocusIn);
          container.addEventListener("focusout", onFocusOut);
        }
        observeLayout(container.closest(".group") || container);
      });
      const scroller = currentScroller();
      if (scroller) {
        if (!boundScrollers.has(scroller)) {
          boundScrollers.add(scroller);
          scroller.addEventListener("scroll", scheduleRender, { passive: true });
        }
        observeLayout(scroller);
        observeLayout(scroller.querySelector(":scope > .commit-box"));
      }
    }

    /**
     * attach 된 그룹의 보이는 행을 그리고, 새 payload 전에 작업트리 행에 있던 포커스를 되돌린다.
     * - 스크롤 위치 복원이 끝난 뒤 호출해야 올바른 범위를 계산한다.
     */
    function renderVisibleRows() {
      renderNow();
      restoreFocus();
    }

    /**
     * 크기가 바뀌면 보이는 범위가 달라지는 요소(스크롤 영역, 커밋 박스, 그룹)를 관찰한다.
     * - 렌더마다 새 요소가 생기므로 DOM 에서 빠진 이전 요소는 관찰을 해제해 분리된 노드가 쌓이지 않게 한다.
     * @param {Element | null} element 관찰할 요소
     */
    function observeLayout(element) {
      if (!resizeObserver) {
        return;
      }
      for (const previous of observed) {
        if (!previous.isConnected) {
          resizeObserver.unobserve(previous);
          observed.delete(previous);
        }
      }
      if (element && !observed.has(element)) {
        observed.add(element);
        resizeObserver.observe(element);
      }
    }

    /** Changes 섹션의 세로 스크롤 컨테이너(section body)를 찾는다. */
    function currentScroller() {
      return rootEl.querySelector('.section[data-section="changes"] > .section-body');
    }

    /** 다음 animation frame 에 보이는 범위를 다시 계산하도록 예약한다(scroll/resize 폭주를 한 번으로 합친다). */
    function scheduleRender() {
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        renderNow();
      });
    }

    /** 모든 연결된 그룹의 보이는 범위를 즉시 계산해 행을 추가/제거하고, 새 행에 후처리를 적용한다. */
    function renderNow() {
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      const scroller = currentScroller();
      const created = [];
      for (const group of groups.values()) {
        if (!group.rowsEl || !group.rowsEl.isConnected) {
          continue;
        }
        syncRows(group, visibleIndexes(group, scroller), created);
      }
      if (created.length) {
        deps.afterRowsRendered(created);
      }
    }

    /**
     * 그룹에서 지금 그려야 할 행 index 를 오름차순으로 계산한다.
     * - 작은 목록은 전부, 큰 목록은 스크롤 영역과 겹치는 범위 + overscan + 포커스 행(pin)만 반환한다.
     * - 그룹/섹션이 접혀 보이지 않으면 포커스 행만 남긴다.
     * @param {object} group 그룹 모델
     * @param {HTMLElement | null} scroller Changes section body
     * @returns {number[]} 그릴 행 index 목록
     */
    function visibleIndexes(group, scroller) {
      const count = group.rows.length;
      if (count <= FULL_RENDER_MAX_ROWS) {
        return Array.from({ length: count }, (_, index) => index);
      }
      // 새 payload 로 DOM 이 교체된 직후에는 이전 포커스 key 를, 평소에는 현재 포커스 key 를 pin 한다.
      const pinKey = restoreFocusKey || focusedKey;
      const focusedIndex =
        pinKey && group.indexByKey.has(pinKey) ? group.indexByKey.get(pinKey) : -1;
      const pinnedOnly = focusedIndex >= 0 ? [focusedIndex] : [];
      if (!scroller || group.container.offsetParent === null) {
        return pinnedOnly;
      }
      const relTop =
        scroller.getBoundingClientRect().top + scroller.clientTop - group.rowsEl.getBoundingClientRect().top;
      const visibleTop = Math.max(0, relTop);
      const visibleBottom = Math.min(count * ROW_HEIGHT, relTop + scroller.clientHeight);
      if (visibleBottom <= visibleTop) {
        return pinnedOnly;
      }
      const windowed = window
        .__gscVirtualList({ itemCount: count, rowHeight: ROW_HEIGHT, overscan: OVERSCAN_ROWS })
        .windowFor(visibleBottom - visibleTop, visibleTop, focusedIndex);
      const indexes = [];
      for (let index = windowed.start; index < windowed.end; index++) {
        indexes.push(index);
      }
      for (const pinned of windowed.pinned) {
        indexes.push(pinned);
      }
      return indexes.sort((left, right) => left - right);
    }

    /**
     * 그릴 index 목록에 맞춰 DOM 행을 재사용/추가/제거한다.
     * - 남는 행은 key 로 재사용하고 위치만 옮겨 hover·포커스가 유지된다.
     * - DOM 순서를 화면 순서와 같게 유지해 Tab 이동과 마퀴 선택의 "마지막 행" 판정이 기존과 같다.
     * @param {object} group 그룹 모델
     * @param {number[]} indexes 오름차순 행 index 목록
     * @param {HTMLElement[]} created 새로 만든 행을 모을 배열
     */
    function syncRows(group, indexes, created) {
      const wanted = new Set(indexes.map((index) => group.rows[index].key));
      for (const [key, element] of group.rendered) {
        if (!wanted.has(key)) {
          element.remove();
          group.rendered.delete(key);
        }
      }
      let cursor = group.rowsEl.firstElementChild;
      for (const index of indexes) {
        const row = group.rows[index];
        let element = group.rendered.get(row.key);
        if (element) {
          if (element.dataset.index !== String(index)) {
            element.dataset.index = String(index);
            element.style.top = `${index * ROW_HEIGHT}px`;
          }
          if (element === cursor) {
            cursor = cursor.nextElementSibling;
          } else {
            group.rowsEl.insertBefore(element, cursor);
          }
          continue;
        }
        element = createRow(group, row, index);
        group.rowsEl.insertBefore(element, cursor);
        group.rendered.set(row.key, element);
        created.push(element);
      }
    }

    /**
     * 행 하나의 DOM 요소를 만든다.
     * @param {object} group 그룹 모델
     * @param {object} row 평면 행(key/node/depth)
     * @param {number} index 그룹 안 행 위치
     * @returns {HTMLElement} 절대 위치로 배치된 행 요소
     */
    function createRow(group, row, index) {
      const template = document.createElement("template");
      template.innerHTML = rowHtml(group, row, index);
      const element = template.content.firstElementChild;
      // CSP 가 style 속성을 막으므로 위치·들여쓰기는 CSSOM 으로 준다(들여쓰기 폭은 CSS 기본값 사용).
      element.style.top = `${index * ROW_HEIGHT}px`;
      element.style.setProperty("--depth", String(row.depth));
      return element;
    }

    /**
     * 기존 중첩 트리 행과 같은 class/data 속성을 가진 평면 행 HTML 을 만든다.
     * @param {object} group 그룹 모델
     * @param {object} row 평면 행
     * @param {number} index 그룹 안 행 위치
     * @returns {string} 행 HTML
     */
    function rowHtml(group, row, index) {
      const layout = `data-index="${index}"`;
      const node = row.node;
      if (node.kind === "folder") {
        const conflictCount = group.folderConflicts.get(node) || 0;
        const collapsed = !!state.folders[row.key];
        const title = conflictCount ? `${node.path} - ${strings.conflicts}` : node.path;
        return (
          `<div class="row folder vrow${conflictCount ? " conflict" : ""}" role="button" tabindex="0" ` +
          `aria-expanded="${collapsed ? "false" : "true"}" data-folder-key="${esc(row.key)}" ` +
          `data-path="${esc(node.path)}" title="${esc(title)}" aria-label="${esc(title)}" ${layout}>` +
          `<span class="twistie codicon ${collapsed ? "codicon-chevron-right" : "codicon-chevron-down"}"></span>` +
          `<span class="icon codicon ${collapsed ? "codicon-folder" : "codicon-folder-opened"}"></span>` +
          `<span class="name">${esc(node.name)}</span>` +
          (conflictCount ? deps.conflictBadgeHtml(conflictCount) : "") +
          deps.rowActionsHtml(group.kind, false) +
          `</div>`
        );
      }
      const change = node.change;
      const slash = change.path.lastIndexOf("/");
      const fileName = slash >= 0 ? change.path.slice(slash + 1) : change.path;
      const dir = slash >= 0 ? change.path.slice(0, slash) : "";
      const conflicted = change.status === "U";
      const title = conflicted ? `${change.path} - ${strings.conflicts}` : change.path;
      return (
        `<div class="row file vrow${conflicted ? " conflict" : ""}" role="button" tabindex="0" ` +
        `aria-label="${esc(title)}" data-status="${esc(change.status)}" data-path="${esc(change.path)}" ` +
        `data-stage="${esc(group.kind)}" title="${esc(title)}" ${layout}>` +
        `<span class="twistie"></span>` +
        `<span class="icon codicon ${deps.statusCodicon(change.status)}"></span>` +
        deps.fileIconHtml(change.path) +
        `<span class="name">${esc(fileName)}</span>` +
        (group.viewMode === "list" && dir ? `<span class="dir">${esc(dir)}</span>` : "") +
        deps.statHtml(change) +
        (conflicted ? deps.conflictBadgeHtml(0) : "") +
        deps.rowActionsHtml(group.kind, true) +
        `</div>`
      );
    }

    /**
     * 작업트리 폴더 행의 접힘을 바꾸고 모델을 다시 펼친다.
     * - 누른 행 요소는 그대로 두고 아이콘/aria 만 갱신해 키보드 포커스를 잃지 않는다.
     * @param {HTMLElement} row 사용자가 토글한 폴더 행
     */
    function toggleFolder(row) {
      const key = row.dataset.folderKey;
      const kind = row.closest("[data-working-kind]")?.dataset.workingKind;
      const group = groups.get(kind);
      if (!key || !group) {
        return;
      }
      const collapsed = !state.folders[key];
      state.folders[key] = collapsed;
      deps.persistState();
      row.setAttribute("aria-expanded", collapsed ? "false" : "true");
      const twistie = row.querySelector(".twistie");
      const folderIcon = row.querySelector(".icon");
      twistie?.classList.toggle("codicon-chevron-down", !collapsed);
      twistie?.classList.toggle("codicon-chevron-right", collapsed);
      folderIcon?.classList.toggle("codicon-folder-opened", !collapsed);
      folderIcon?.classList.toggle("codicon-folder", collapsed);
      flattenGroup(group);
      group.rowsEl.style.height = `${group.rows.length * ROW_HEIGHT}px`;
      renderNow();
    }

    /**
     * 선택 key 가 가리키는 실제 파일 경로 목록을 반환한다.
     * - 폴더는 접힘·가상화와 무관하게 모델의 모든 하위 파일을 돌려준다(화면에 보이는 행만이 아니다).
     * @param {string} key `${kind}:${path}` 형식 선택 key
     * @returns {string[]} 파일 경로 목록(모르는 key 면 빈 배열)
     */
    function pathsForKey(key) {
      const kind = key.slice(0, key.indexOf(":"));
      const group = groups.get(kind);
      const node = group?.nodesByKey.get(key);
      if (!node) {
        return [];
      }
      if (node.kind === "file") {
        return [node.change.path];
      }
      let paths = group.folderPaths.get(node);
      if (!paths) {
        paths = [];
        const collect = (list) => {
          for (const child of list) {
            if (child.kind === "folder") {
              collect(child.children);
            } else {
              paths.push(child.change.path);
            }
          }
        };
        collect(node.children);
        group.folderPaths.set(node, paths);
      }
      return paths.slice();
    }

    /** 작업트리 행 요소가 가리키는 파일 경로 목록을 반환한다(폴더는 모델의 모든 하위 파일). */
    function pathsForRow(row) {
      const kind = row.closest("[data-working-kind]")?.dataset.workingKind || "";
      return pathsForKey(keyOf(kind, row.dataset.path || ""));
    }

    /** 현재 payload 에 존재하는 key 인지 확인한다(접힌 폴더 안 행 포함). */
    function hasKey(key) {
      const group = groups.get(key.slice(0, key.indexOf(":")));
      return !!group && group.nodesByKey.has(key);
    }

    /** Shift 범위 선택에 쓸, 화면 순서(Staged → Changes, 접힘 반영) 전체 key 목록을 반환한다. */
    function orderedKeys() {
      const keys = [];
      for (const kind of ["staged", "unstaged"]) {
        const group = groups.get(kind);
        if (group) {
          for (const row of group.rows) {
            keys.push(row.key);
          }
        }
      }
      return keys;
    }

    /** document.activeElement 가 작업트리 행이면 그 key 를 반환한다. */
    function activeRowKey() {
      const active = document.activeElement;
      const row = active?.closest?.(".wt-files .row");
      if (!row || row !== active) {
        return null;
      }
      const kind = row.closest("[data-working-kind]")?.dataset.workingKind || "";
      return keyOf(kind, row.dataset.path || "");
    }

    /** 행 포커스를 추적해 스크롤로 화면을 벗어나도 그 행을 계속 그려 둔다(pin). */
    function onFocusIn(event) {
      const row = event.target.closest?.(".row");
      if (row && row === event.target) {
        focusedKey = activeRowKey();
      }
    }

    /** 포커스가 작업트리 행 밖으로 나가면 pin 을 해제한다. */
    function onFocusOut(event) {
      const next = event.relatedTarget;
      if (!next || !next.closest?.(".wt-files .row")) {
        focusedKey = null;
      }
    }

    /** 새 payload 렌더 전에 작업트리 행에 있던 포커스를 같은 key 의 새 행으로 돌려준다. */
    function restoreFocus() {
      const key = restoreFocusKey;
      restoreFocusKey = null;
      if (!key) {
        return;
      }
      const group = groups.get(key.slice(0, key.indexOf(":")));
      const element = group?.rendered.get(key);
      if (element && !rootEl.contains(document.activeElement)) {
        element.focus({ preventScroll: true });
      }
    }

    return {
      beginRender,
      groupFilesHtml,
      attach,
      renderVisibleRows,
      scheduleRender,
      toggleFolder,
      pathsForKey,
      pathsForRow,
      hasKey,
      orderedKeys,
    };
  };
})();
