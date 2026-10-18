// Graph 텍스트 행의 부분 갱신과 가로 스크롤 폭 측정을 담당하는 모듈.
// - branch/tag 상태가 바뀌어도 표시가 달라진 행만 교체해, 수천 행 전체 DOM 재생성을 피한다.
// - 가로 폭은 다음 animation frame 으로 모아 한 번만, 글자 수가 긴 후보 행만 측정해 강제 reflow 를 줄인다.
(function () {
  "use strict";

  /** 폭 측정 후보로 삼을 가장 긴 행 수. 배지 padding 차이를 감안해 여유 있게 잡는다. */
  const WIDTH_CANDIDATES = 24;

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
    return { update, affected };
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
    let widthFrame = 0;
    // 행 교체뿐 아니라 rebase 장식·검색 강조·reflog의 제자리 수정도 다음 측정 전에 무효화한다.
    const widthObserver = new MutationObserver(invalidateWidthScores);
    widthObserver.observe(graphContentEl, { childList: true, characterData: true, subtree: true });

    /** @param records 행 내용의 DOM 변경 목록 @returns 변경된 행의 점수만 버려 다른 행의 텍스트 재탐색을 피한다. */
    function invalidateWidthScores(records) {
      records.forEach(record => {
        const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        const row = target?.closest?.(".row");
        if (row?.parentElement === graphContentEl) widthScores.delete(row);
      });
    }

    /** @param index 모델 행 위치 @returns 같은 캔버스에 붙어 있는 DOM 행. 교체된 행만 selector로 다시 찾는다. */
    function elementAt(index) {
      const cached = elements.get(index);
      return cached?.parentElement === graphContentEl && Number(cached.dataset.index) === index ? cached
        : graphContentEl.querySelector(`:scope > .row[data-index="${index}"]:not([data-reflog-virtual])`);
    }

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
      graphContentEl.querySelectorAll(":scope > .row:not([data-reflog-virtual])").forEach(element => {
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
        : graphContentEl.querySelectorAll(":scope > .row:not([data-reflog-virtual])");
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
        element.replaceWith(replacement); elements.set(index, replacement);
        replaced++;
      });
      scheduleScrollableWidth();
      return replaced;
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
      const rowsRight = widestCandidates().reduce(
        (max, row) => Math.max(max, row.offsetLeft + row.scrollWidth + 24),
        0
      );
      const width = Math.max(graphEl.clientWidth, rowsRight, graphWidth + 680);
      if (width > 0) {
        graphContentEl.style.width = width + "px";
        graphContentEl.style.minWidth = width + "px";
      }
    }

    /** 텍스트가 가장 긴 행 몇 개를 고른다. */
    function widestCandidates() {
      const scored = [];
      graphContentEl.querySelectorAll(":scope > .row").forEach((row) => {
        let length = widthScores.get(row);
        if (length === undefined) {
          length = row.textContent.length + row.childElementCount * 2;
          widthScores.set(row, length);
        }
        if (scored.length < WIDTH_CANDIDATES) {
          scored.push({ row, length });
          scored.sort((a, b) => a.length - b.length);
        } else if (length > scored[0].length) {
          scored[0] = { row, length };
          scored.sort((a, b) => a.length - b.length);
        }
      });
      return scored.map((entry) => entry.row);
    }

    return { indexRows, elementAt, affectedRows: dependencies.affected, patchRows, scheduleScrollableWidth };
  };
})();
