// 비동기 UI 요청의 revision과 stale response 차단을 제공하는 순수 state primitive.
// - queue/PR/detail surface가 응답 도착 순서 대신 사용자가 마지막으로 시작한 요청만 적용하게 한다.
(function () {
  "use strict";

  /** revision 증가와 최신 여부 확인을 가진 request state controller를 만든다. */
  window.__gscRequestState = function createRequestState(initialRevision) {
    let revision = Number.isSafeInteger(initialRevision) && initialRevision >= 0 ? initialRevision : 0;

    /** 새 요청의 안정 revision을 만들고 이전 응답을 stale로 만든다. */
    function begin() {
      revision += 1;
      return revision;
    }

    /** revision이 현재 화면이 기다리는 최신 요청인지 확인한다. */
    function isCurrent(candidate) {
      return candidate === revision;
    }

    /** 현재 revision을 외부에서 읽어 request envelope와 debug log에 넣는다. */
    function current() {
      return revision;
    }

    /** response를 적용할 수 있을 때만 callback을 실행해 stale DOM write를 막는다. */
    function applyIfCurrent(candidate, callback) {
      if (!isCurrent(candidate)) return false;
      callback?.();
      return true;
    }

    return { applyIfCurrent, begin, current, isCurrent };
  };
}());
