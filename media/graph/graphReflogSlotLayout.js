// reflog/dangling object 가상 row 를 실제 graph row 사이 어디에 끼울지 계산한다.
// - 렌더러는 DOM 생성만 맡고, parent/drop/date 기반 위치 추정은 이 모듈로 분리한다.
(function () {
  "use strict";

  /**
   * reflog 항목을 실제 그래프 row 사이에 끼울 삽입 슬롯으로 변환한다.
   * @param {Array<object>} markers graphReflog.js 에서 만든 reflog marker 후보
   * @param {Element[]} rows 현재 렌더된 실제 commit row 목록
   * @param {number} rowHeight 현재 graph row 높이
   * @returns {Array<object>} y 좌표가 계산된 slot 목록
   */
  function layoutSlots(markers, rows, rowHeight) {
    let insertedBefore = 0;
    return (markers || [])
      .map((marker) => markerSlot(marker, rows || [], rowHeight))
      .filter(Boolean)
      .sort((a, b) => a.insertAt - b.insertAt || a.marker.index - b.marker.index)
      .map((slot) => {
        const insertedIndex = slot.insertAt + insertedBefore++;
        return {
          ...slot,
          marker: {
            ...slot.marker,
            y: insertedIndex * rowHeight + rowHeight / 2,
          },
        };
      });
  }

  /**
   * 한 reflog marker 를 어느 commit row 앞에 끼울지 계산한다.
   * @param {object} marker reflog 이벤트 marker
   * @param {Element[]} rows 현재 렌더된 실제 commit row 목록
   * @param {number} rowHeight 현재 graph row 높이
   */
  function markerSlot(marker, rows, rowHeight) {
    if (!marker?.hash) {
      return undefined;
    }
    const rowCount = rows.length;
    const fromIndex = rowIndex(marker.fromRow, rowHeight);
    const toIndex = rowIndex(marker.toRow, rowHeight);
    let insertAt;
    if (marker.flow === "object") {
      insertAt = objectInsertAt(marker, rows, rowHeight);
    } else if (fromIndex != null && toIndex != null && fromIndex !== toIndex) {
      insertAt = Math.min(fromIndex, toIndex) + 1;
    } else if (toIndex != null) {
      insertAt = toIndex + 1;
    } else if (fromIndex != null) {
      insertAt = fromIndex + 1;
    } else {
      insertAt = dateInsertAt(marker.dateIso, rows);
    }
    if (insertAt == null) {
      return undefined;
    }
    return { marker, insertAt: Math.min(Math.max(0, insertAt), rowCount) };
  }

  /**
   * dangling object 를 현재 graph 흐름의 가장 가까운 위치에 끼운다.
   * @param {object} marker object marker
   * @param {Element[]} rows 현재 렌더된 commit row 목록
   * @param {number} rowHeight graph row 높이
   */
  function objectInsertAt(marker, rows, rowHeight) {
    const parentIndex = minRowIndex(marker.parentRows, rowHeight);
    if (parentIndex != null) {
      return parentIndex;
    }
    const dropIndex = minRowIndex(marker.dropRows, rowHeight);
    if (dropIndex != null) {
      return dropIndex + 1;
    }
    return dateInsertAt(marker.dateIso, rows);
  }

  /**
   * 여러 row 후보 중 graph 상단에 가장 가까운 row index 를 고른다.
   * @param {Element[]} rows 후보 row 목록
   * @param {number} rowHeight graph row 높이
   */
  function minRowIndex(rows, rowHeight) {
    const indexes = (rows || [])
      .map((row) => rowIndex(row, rowHeight))
      .filter((index) => index != null);
    return indexes.length ? Math.min(...indexes) : undefined;
  }

  /**
   * commit date 기준으로 들어갈 row index 를 추정한다.
   * - 현재 로드된 날짜 범위보다 오래된 항목은 하단에 붙이지 않는다.
   * - 무한스크롤로 older commit 이 추가될 때 marker 가 계속 도망가는 경험을 막기 위해,
   *   실제 날짜 범위 안에 들어왔을 때만 가상 row 를 만든다.
   * @param {string} dateIso object commit date
   * @param {Element[]} rows 현재 렌더된 commit row 목록
   */
  function dateInsertAt(dateIso, rows) {
    const time = Date.parse(dateIso || "");
    if (!Number.isFinite(time) || !rows.length) {
      return undefined;
    }
    for (let index = 0; index < rows.length; index += 1) {
      const rowTime = Date.parse(rows[index].dataset.dateIso || "");
      if (Number.isFinite(rowTime) && time >= rowTime) {
        return index;
      }
    }
    return undefined;
  }

  /**
   * commit row DOM 에서 원래 row index 를 계산한다.
   * @param {Element | null | undefined} row commit row
   * @param {number} rowHeight graph row 높이
   */
  function rowIndex(row, rowHeight) {
    if (!row) {
      return undefined;
    }
    return Math.max(0, Math.round(baseTop(row) / rowHeight));
  }

  /**
   * commit row 의 원래 top 좌표를 읽고 저장한다.
   * @param {Element} row commit row
   */
  function baseTop(row) {
    row.dataset.reflogBaseTop = row.dataset.reflogBaseTop || row.style.top || `${row.offsetTop}px`;
    return parseFloat(row.dataset.reflogBaseTop) || 0;
  }

  window.GscGraphReflogSlotLayout = { layoutSlots };
})();
