// Graph 텍스트 행의 부분 갱신과 가로 스크롤 폭 측정을 담당하는 모듈.
// - branch/tag 상태가 바뀌어도 표시가 달라진 행만 교체해, 수천 행 전체 DOM 재생성을 피한다.
// - 가로 폭은 다음 animation frame 으로 모아 한 번만, 글자 수가 긴 후보 행만 측정해 강제 reflow 를 줄인다.
(function () {
  "use strict";

  /** 폭 측정 후보로 삼을 가장 긴 행 수. 배지 padding 차이를 감안해 여유 있게 잡는다. */
  const WIDTH_CANDIDATES = 24;
  const rowLookups = new WeakMap();

  /**
   * graph payload의 ref·local-only 브랜치·해시를 행 인덱스로 역조회한다. DOM이나 Git 상태를 보관하지 않는다.
   * @returns update(rows)로 교체하고 affected(changes)로 영향받는 행 집합을 읽는 API. 범위를 모르면 undefined다.
   */
  window.GscGraphRowDependencies = function createRowDependencies() {
    const byKey = new Map(), byHash = new Map();
    let ready = false, indexedRows = [];

    /** @param lookup 역조회 Map @param key 참조 또는 해시 @param index 해당 행 위치 @returns 저장만 수행한다. */
    function add(lookup, key, index) {
      const indices = lookup.get(key) || new Set();
      indices.add(index); lookup.set(key, indices);
    }

    /** @param lookup 역조회 Map @param key 삭제할 참조/해시 @param index 변경되기 전 행 위치 @returns 빈 역조회 항목까지 제거한다. */
    function remove(lookup, key, index) {
      const indices = lookup.get(key);
      indices?.delete(index);
      if (indices?.size === 0) lookup.delete(key);
    }

    /** @param row 한 모델 행 @param index 위치 @param visit add/remove 작업 @returns 한 행의 해시·ref·local-only 의존성만 처리한다. */
    function visitRow(row, index, visit) {
      visit(byHash, row.hash, index);
      (row.refs || []).forEach(ref => {
        let key = `branch:${ref}`;
        if (ref.startsWith("tag:")) key = ref;
        else if (ref.startsWith("remote-tag:")) {
          const raw = ref.slice("remote-tag:".length), slash = raw.indexOf("/");
          key = `tag:${slash < 0 ? raw : raw.slice(slash + 1)}`;
        }
        visit(byKey, key, index);
      });
      (row.localOnlyBranches || []).forEach(name => visit(byKey, `branch:${name}`, index));
    }

    /** @param rows 새 전체 모델 @param delta 검증된 작은 변경 @returns 전체 교체는 재인덱싱하고 delta는 이전 의존성을 제거한 뒤 변경·추가 행만 등록한다. */
    function update(rows, delta) {
      if (!ready || !delta || delta.rowStart !== indexedRows.length) {
        byKey.clear(); byHash.clear();
        rows.forEach((row, index) => visitRow(row, index, add));
      } else {
        delta.rowUpdates.forEach(({ index, row }) => {
          visitRow(indexedRows[index], index, remove); visitRow(row, index, add);
        });
        for (let index = delta.rowStart; index < rows.length; index++) visitRow(rows[index], index, add);
      }
      indexedRows = rows; ready = true;
    }

    /** @param changes 브랜치/태그 범위 @param additional worktree 등 독립 표시 범위 @returns 합친 영향 행. 범위를 모르면 전체 갱신이다. */
    function affected(changes, ...additional) {
      const scopes = [changes, ...additional.filter(value => value !== undefined)];
      if (!ready || scopes.some(scope => !scope?.keys || !scope?.hashes)) return undefined;
      const result = new Set();
      scopes.forEach(scope => {
        scope.keys.forEach(key => byKey.get(key)?.forEach(index => result.add(index)));
        scope.hashes.forEach(hash => byHash.get(hash)?.forEach(index => result.add(index)));
      });
      return result;
    }
    /** @param hash commit의 정확한 hash @returns 현재 모델에서 가장 앞선 행 위치. 중복 hash도 DOM 순서를 유지한다. */
    function firstIndex(hash) {
      let first;
      byHash.get(hash)?.forEach(index => { if (first === undefined || index < first) first = index; });
      return first;
    }
    return { update, affected, firstIndex };
  };

  /**
   * 행 동기화 API 를 만든다.
   * @param {object} deps graph.js 가 소유한 DOM 과 행 생성 함수
   * @param {HTMLElement} deps.graphEl 스크롤 컨테이너
   * @param {HTMLElement} deps.graphContentEl 행과 SVG 를 담는 캔버스
   * @param {(row: object, index: number, leftInset: number) => HTMLElement} deps.buildRow 행 DOM 생성 함수
   * @param {(row: object) => string} deps.rowRenderKey 행 표시가 같은지 비교할 key 계산 함수
   * @param {() => { graphWidth: number }} deps.layout 현재 그래프 폭을 돌려주는 함수
   * @returns 행 인덱싱·영향 범위 조회·부분 갱신·가로 폭 예약 API
   */
  window.GscGraphRowSync = function createGraphRowSync(deps) {
    const { graphEl, graphContentEl } = deps;
    const dependencies = window.GscGraphRowDependencies(), elements = new Map();
    const widthScores = new WeakMap();
    // 최대 24개 후보만 강하게 참조한다. 전체 행/삭제된 행을 보관하는 별도 인덱스는 만들지 않는다.
    let widthCandidates;
    let widthFrame = 0;
    let canvasViewportWidth = -1;
    // 행 교체뿐 아니라 rebase 장식·검색 강조·reflog의 제자리 수정도 다음 측정 전에 무효화한다.
    const widthObserver = new MutationObserver(invalidateWidthScores);
    widthObserver.observe(graphContentEl, {
      childList: true, characterData: true, subtree: true,
      attributes: true, attributeFilter: ["class"], attributeOldValue: true,
    });

    /** @param records 행 내용의 DOM 변경 목록 @returns 변경된 행의 점수만 버려 다른 행의 텍스트 재탐색을 피한다. */
    function invalidateWidthScores(records) {
      const changed = new Set();
      records.forEach(record => {
        const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        if (record.type === "attributes") {
          // selected/rebase/search 장식은 후보 점수를 바꾸지 않는다. 직접 자식의 row 진입/이탈만 반영한다.
          if (!window.GscGraphRowGroups.owns(graphContentEl, target) ||
            /(?:^|\s)row(?:\s|$)/.test(record.oldValue || "") === target.classList.contains("row")) return;
          if (widthCandidates?.some(entry => entry.row === target)) widthCandidates = undefined;
          widthScores.delete(target);
          if (target.classList.contains("row")) changed.add(target);
          return;
        }
        if (window.GscGraphRowGroups.isRowContainer(graphContentEl, target) && record.type === "childList") {
          record.removedNodes.forEach(node => {
            if (widthCandidates?.some(entry => entry.row === node || node.contains(entry.row))) widthCandidates = undefined;
          });
          record.addedNodes.forEach(node => {
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            if (node.classList.contains("row")) changed.add(node);
            else node.querySelectorAll(".row").forEach(row => changed.add(row));
          });
        }
        const row = target?.closest?.(".row");
        if (window.GscGraphRowGroups.owns(graphContentEl, row)) changed.add(row);
      });
      changed.forEach(row => {
        widthScores.delete(row);
        if (!widthCandidates || !window.GscGraphRowGroups.owns(graphContentEl, row)) return;
        const length = widthScore(row), candidate = widthCandidates.find(entry => entry.row === row);
        // 기존 후보의 순위가 바뀌거나 새 행이 최소 점수에 닿으면 원래 DOM 순서로 다시 고른다.
        if (candidate ? candidate.length !== length
          : widthCandidates.length < WIDTH_CANDIDATES || length >= widthCandidates[0].length) widthCandidates = undefined;
      });
    }

    /** @param row 현재 캔버스의 한 행 @returns layout 없이 읽은 텍스트·직접 자식 수 점수. 변경 전까지 약하게 재사용한다. */
    function widthScore(row) {
      let length = widthScores.get(row);
      if (length === undefined) {
        length = row.textContent.length + row.childElementCount * 2;
        widthScores.set(row, length);
      }
      return length;
    }

    /** @param index 모델 행 위치 @returns 같은 캔버스에 붙어 있는 DOM 행. 교체된 행만 selector로 다시 찾는다. */
    function elementAt(index) {
      const cached = elements.get(index);
      return window.GscGraphRowGroups.owns(graphContentEl, cached) && Number(cached.dataset.index) === index ? cached
        : graphContentEl.querySelector(`:scope .row[data-index="${index}"]:not([data-reflog-virtual])`);
    }
    // 기존 역색인과 행 캐시를 공유한다. WeakMap은 다른 캔버스나 닫힌 문서의 DOM을 강하게 보관하지 않는다.
    rowLookups.set(graphContentEl, hash => {
      const index = dependencies.firstIndex(hash), element = index === undefined ? null : elementAt(index);
      return element?.dataset.hash === hash ? element : null;
    });

    /** @param rows 새 graph 모델 @param delta 검증된 변경 @returns 작은 행 교체는 인덱스도 부분 갱신하고 페이지 추가/전체 교체는 DOM을 다시 수집한다. */
    function indexRows(rows, delta) {
      dependencies.update(rows, delta);
      if (delta && !delta.rows.length) {
        delta.rowUpdates.forEach(({ index }) => {
          const element = elementAt(index);
          if (element) elements.set(index, element); else elements.delete(index);
        });
        return;
      }
      elements.clear();
      graphContentEl.querySelectorAll(":scope .row:not([data-reflog-virtual])").forEach(element => {
        elements.set(Number(element.dataset.index), element);
      });
    }

    /**
     * 현재 행 데이터와 DOM 행을 비교해 표시가 달라진 행만 새로 만든다.
     * - 행 순서·hash 가 다르거나 render key(배지 HTML·색·local-only·선택 상태)가 다르면 교체한다.
     * @param {object[]} rows 마지막 graph payload 의 행 데이터
     * @param {Set<number>} indices 확인할 행 위치. 생략하면 전체 모델 행을 비교한다.
     * @returns {number} 교체한 행 수
     */
    function patchRows(rows, indices) {
      const graphWidth = deps.layout().graphWidth;
      let replaced = 0;
      const candidates = indices ? [...indices].map(elementAt).filter(Boolean)
        : graphContentEl.querySelectorAll(":scope .row:not([data-reflog-virtual])");
      candidates.forEach((element) => {
        const index = Number(element.dataset.index);
        const row = rows[index];
        if (!row) {
          element.remove();
          elements.delete(index);
          return;
        }
        if (row.hash === element.dataset.hash && deps.rowRenderKey(row) === element.dataset.renderKey) {
          return;
        }
        const replacement = deps.buildRow(row, index, graphWidth);
        // 상세 hydration이 키보드로 사용 중인 브랜치 chip을 교체해도 같은 실제 ref에 포커스를 유지한다.
        const focused = document.activeElement;
        const branch = element.contains(focused) ? focused?.closest?.("[data-branch-name]") : null;
        const focusName = branch?.dataset.branchName, focusKind = branch?.dataset.branchKind;
        element.replaceWith(replacement); elements.set(index, replacement);
        if (row.hash === element.dataset.hash && focusName && focusKind) {
          const target = replacement.querySelector(`[data-branch-name="${CSS.escape(focusName)}"][data-branch-kind="${CSS.escape(focusKind)}"]`);
          target?.focus({ preventScroll: true });
        }
        replaced++;
      });
      scheduleScrollableWidth();
      return replaced;
    }

    /**
     * canvas 높이를 적용하고 필요한 경우에만 측정 폭을 다시 준비한다.
     * @param contentHeight 행과 로딩 tail의 합산 높이. viewport보다 작으면 viewport 높이를 사용한다.
     * @param preserveGeometry 검증된 빈 delta일 때 같은 viewport/높이의 폭과 스크롤을 보존한다.
     */
    function resizeCanvas(contentHeight, preserveGeometry) {
      // 쓰기 전에 읽어 width 초기화로 인한 불필요한 동기 layout을 피한다.
      const viewportWidth = graphEl.clientWidth;
      const height = Math.max(contentHeight, graphEl.clientHeight) + "px";
      if (preserveGeometry && canvasViewportWidth === viewportWidth && graphContentEl.style.height === height) return;
      // 다음 폭 측정 전까지 기존 폭을 유지해 전체 교체 중 가로 스크롤이 먼저 0으로 clamp되지 않게 한다.
      const measuredWidth = graphContentEl.style.width.endsWith("px");
      if (!measuredWidth) graphContentEl.style.width = "100%";
      graphContentEl.style.minWidth = deps.layout().graphWidth + 680 + "px";
      graphContentEl.style.height = height;
      canvasViewportWidth = viewportWidth;
      // 빈 화면으로 돌아가도 이전의 큰 폭은 다음 frame에 줄인다. 새 행의 폭 예약과는 합친다.
      if (preserveGeometry || measuredWidth) scheduleScrollableWidth();
    }

    /** 다음 frame 에 가로 스크롤 폭을 한 번 측정하도록 예약한다(연속 호출은 합친다). */
    function scheduleScrollableWidth() {
      if (widthFrame) {
        return;
      }
      widthFrame = window.requestAnimationFrame(() => {
        widthFrame = 0;
        syncScrollableWidth();
      });
    }

    /**
     * 행 내용이 가로로 길 때 캔버스 폭을 가장 긴 행에 맞춰 넓힌다.
     * - 모든 행의 scrollWidth 를 읽지 않고, 글자 수가 긴 후보 행만 측정한다(글자 수는 layout 없이 읽힌다).
     */
    function syncScrollableWidth() {
      invalidateWidthScores(widthObserver.takeRecords());
      const graphWidth = deps.layout().graphWidth;
      const candidates = widestCandidates();
      window.GscGraphRowGroups.measure(graphContentEl, candidates);
      const rowsRight = candidates.reduce(
        (max, row) => Math.max(max, row.offsetLeft + row.scrollWidth + 24),
        0
      );
      const width = Math.max(graphEl.clientWidth, rowsRight, graphWidth + 680);
      if (width > 0) {
        graphContentEl.style.width = width + "px";
        graphContentEl.style.minWidth = width + "px";
      }
    }

    /** @returns 텍스트가 가장 긴 최대 24개 행. 후보 집합이 달라질 변경이 없으면 전체 DOM 탐색을 생략한다. */
    function widestCandidates() {
      if (widthCandidates) return widthCandidates.map(entry => entry.row);
      const scored = [];
      graphContentEl.querySelectorAll(":scope .row").forEach((row) => {
        const length = widthScore(row);
        if (scored.length < WIDTH_CANDIDATES) {
          scored.push({ row, length });
          scored.sort((a, b) => a.length - b.length);
        } else if (length > scored[0].length) {
          scored[0] = { row, length };
          scored.sort((a, b) => a.length - b.length);
        }
      });
      widthCandidates = scored;
      return scored.map((entry) => entry.row);
    }

    return { indexRows, elementAt, affectedRows: dependencies.affected, patchRows, resizeCanvas, scheduleScrollableWidth };
  };
  /** @param root 소유 Graph 캔버스 @param hash commit hash @returns 최신 실제 행. 미등록/미로딩 hash는 호출자가 직접 조회한다. */
  window.GscGraphRowSync.rowForHash = (root, hash) => hash ? rowLookups.get(root)?.(String(hash)) : null;
})();
