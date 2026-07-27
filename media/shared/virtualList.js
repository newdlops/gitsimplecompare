// fixed-height list의 bounded DOM window와 focused-row pin을 계산하는 순수 primitive.
// - 실제 renderer는 반환된 range만 DOM에 만들고, queue/file/diff adapter가 자기 key·row height를 제공한다.
(function () {
  "use strict";

  /** viewport와 overscan으로 기본 visible index range를 계산한다. */
  function baseRange(itemCount, rowHeight, viewportHeight, scrollTop, overscan) {
    if (itemCount <= 0) return { start: 0, end: 0 };
    const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan);
    const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight);
    return { start: first, end: Math.min(itemCount, Math.max(first + 1, first + visible + overscan * 2)) };
  }

  /** item count와 row metric을 검증하고 update 가능한 virtual window controller를 만든다. */
  window.__gscVirtualList = function createVirtualList(options) {
    const itemCount = Math.max(0, Number(options.itemCount) || 0);
    const rowHeight = Math.max(1, Number(options.rowHeight) || 1);
    const overscan = Math.max(0, Number(options.overscan) || 0);

    /** focus된 index가 range 밖이면 별도 pin으로 반환해 DOM window가 멀리까지 커지지 않게 한다. */
    function windowFor(viewportHeight, scrollTop, focusedIndex) {
      const range = baseRange(itemCount, rowHeight, viewportHeight, scrollTop, overscan);
      if (!Number.isInteger(focusedIndex) || focusedIndex < 0 || focusedIndex >= itemCount) return { ...range, pinned: [] };
      return { ...range, pinned: focusedIndex < range.start || focusedIndex >= range.end ? [focusedIndex] : [] };
    }

    /** 전체 scroll height를 알려 renderer가 spacer를 정확히 만들게 한다. */
    function totalHeight() {
      return itemCount * rowHeight;
    }

    return { totalHeight, windowFor };
  };
}());
