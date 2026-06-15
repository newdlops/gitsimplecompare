// graph HEAD 점프 UI.
// - 현재 렌더 범위에 HEAD 가 없으면 확장에 HEAD 주변 graph window 로드를 요청한다.
(function () {
  "use strict";

  let requestSeq = 0;
  let pendingRequestId = "";

  /** graph 최초 로드 시 현재 렌더 범위의 HEAD row 로 스크롤한다. */
  function focusHead(graphEl, root) {
    const row = headRow(root);
    if (row) {
      graphEl.scrollTop = Math.max(0, row.offsetTop - 60);
    }
  }

  /** HEAD row 로 이동한다. 화면에 없으면 확장에 HEAD 주변 window 로드를 요청한다. */
  function jumpToHead(graphEl, root) {
    const row = headRow(root);
    if (row) {
      jumpToRow(graphEl, root, row);
      return;
    }
    pendingRequestId = `head-focus-${++requestSeq}`;
    window.GscGraphPostMessage?.({ type: "ensureHeadVisible", requestId: pendingRequestId });
  }

  /** 확장 쪽 window 로드 응답을 받아 다시 HEAD row 를 찾고 강조한다. */
  function handleMessage(event) {
    const msg = event.data;
    if (msg.type !== "commitVisibility" || !pendingRequestId || msg.requestId !== pendingRequestId) {
      return;
    }
    pendingRequestId = "";
    if (!msg.found) {
      return;
    }
    window.requestAnimationFrame(() => {
      const graphEl = document.getElementById("graph");
      const root = document.getElementById("graph-content");
      const row = rowForHash(root, msg.hash) || headRow(root);
      if (row) {
        jumpToRow(graphEl, root, row);
      }
    });
  }

  /** 현재 렌더된 graph row 중 HEAD ref 를 가진 row 를 찾는다. */
  function headRow(root) {
    return Array.from(root?.querySelectorAll(".row") || []).find((item) =>
      (item.dataset.refs || "").split("\t").includes("HEAD")
    );
  }

  /** 현재 렌더된 graph row 중 해시가 일치하는 row 를 찾는다. */
  function rowForHash(root, hash) {
    return Array.from(root?.querySelectorAll(".row") || []).find(
      (item) => item.dataset.hash === hash
    );
  }

  /** row 로 스크롤하고 검색 highlight 와 같은 강조 스타일을 잠깐 적용한다. */
  function jumpToRow(graphEl, root, row) {
    if (!graphEl || !root || !row) {
      return;
    }
    graphEl.scrollTop = Math.max(0, row.offsetTop - 80);
    root.querySelectorAll(".search-hit").forEach((item) => item.classList.remove("search-hit"));
    row.classList.add("search-hit");
    window.setTimeout(() => row.classList.remove("search-hit"), 2200);
  }

  window.addEventListener("message", handleMessage);
  window.GscGraphHeadJump = { focusHead, jumpToHead };
})();
