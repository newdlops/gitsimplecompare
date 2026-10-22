// Git graph commit row와 GitHub Pull Request의 연결 표시/이동을 담당한다.
// - PR drawer 렌더링과 분리해 merge 결과 commit까지 일관된 hash 규칙으로 매칭한다.
(function () {
  "use strict";

  let focusRequestSequence = 0;
  let pendingFocusRequest;
  let focusStatus;
  let focusedHash = "";
  let resolvedPullRequest;
  const badgeVersions = new WeakMap();

  /**
   * 현재 graph row에 PR badge와 강조 class를 다시 반영한다.
   * @param {Array<object>} pullRequests 목록 및 검색으로 현재 알려진 PR 배열
   * @param {(pr: object) => number} commentCount PR별 최신 댓글 수를 반환하는 함수
   * @returns {void}
   */
  function applyDecorations(pullRequests, commentCount) {
    const root = document.getElementById("graph-content");
    if (!root) {
      return;
    }
    const hasPrs = !!pullRequests?.length;
    const rows = Array.from(root.querySelectorAll(hasPrs ? ".row[data-hash]" : ".row.pr-row"));
    const byHash = pullRequestsByHash(pullRequests, new Set(rows.map(row => row.dataset.hash)));
    rows.forEach((row) => {
      const prs = byHash.get(row.dataset.hash || "") || [];
      const previous = row.querySelector(".pr-badges");
      if (!prs.length) {
        previous?.remove();
        if (row.classList.contains("pr-row")) row.classList.remove("pr-row");
        return;
      }
      if (!row.classList.contains("pr-row")) row.classList.add("pr-row");
      const version = badgeVersion(prs, commentCount);
      if (previous && badgeVersions.get(previous) === version) return;
      const focusedNumber = previous?.contains(document.activeElement) ? document.activeElement.dataset.prNumber : undefined;
      const next = badges(prs, commentCount);
      badgeVersions.set(next, version);
      if (previous) previous.replaceWith(next); else row.insertBefore(next, row.firstChild);
      if (focusedNumber) next.querySelector(`[data-pr-number="${cssEscape(focusedNumber)}"]`)?.focus({ preventScroll: true });
    });
    // SVG 노드를 한 번만 순회한다. 같은 hash의 중복 노드는 기존처럼 첫 번째만 장식한다.
    const remaining = new Set(byHash.keys());
    root.querySelectorAll(hasPrs ? ".node[data-hash]" : ".node.pr-node").forEach(node => {
      const hash = node.dataset.hash || "", pr = remaining.delete(hash) ? byHash.get(hash)?.[0] : undefined;
      const color = pr && prColorClass(pr.number);
      if (pr && node.classList.contains("pr-node") && node.classList.contains(color)) return;
      if (node.classList.contains("pr-node")) node.classList.remove("pr-node", ...prColorClasses());
      if (pr) node.classList.add("pr-node", color);
    });
    if (focusedHash) decorateFocusedRow(findCommitRow(focusedHash));
    applyFocusStatus();
  }

  /**
   * commit hash마다 연결된 PR 목록을 빠르게 찾는 map을 만든다.
   * @param {Array<object>} pullRequests graph에 매칭할 PR 배열
   * @param {Set<string>} visibleHashes 현재 DOM에 있는 commit OID. 페이지 밖 PR 이력은 map에 보관하지 않는다.
   * @returns {Map<string, Array<object>>} 표시 중인 commit OID를 key로 갖는 PR 목록 map
   */
  function pullRequestsByHash(pullRequests, visibleHashes) {
    const map = new Map();
    for (const pr of pullRequests || []) {
      for (const hash of matchingHashes(pr)) {
        if (!visibleHashes.has(hash)) continue;
        const list = map.get(hash) || [];
        list.push(pr);
        map.set(hash, list);
      }
    }
    return map;
  }

  /**
   * 화면에 표시되는 세 PR의 정보만 비교해 같은 배지를 교체하지 않도록 한다.
   * @param {Array<object>} pullRequests 해당 commit에 연결된 우선순위 순서의 PR 목록
   * @param {(pr: object) => number} commentCount PR별 최신 댓글 수를 반환하는 함수
   * @returns {string} 번호·제목·표시 댓글 수의 비교 키. 제거된 배지의 키는 WeakMap과 함께 회수된다.
   */
  function badgeVersion(pullRequests, commentCount) {
    return JSON.stringify(pullRequests.slice(0, 3).map(pr => [pr.number, pr.title,
      pr.commentCountComplete === false ? "…" : Number(commentCount?.(pr) ?? pr.commentCount) || 0]));
  }

  /**
   * PR과 연결된 graph commit OID를 중복 없이 반환한다.
   * - 원래 PR commit뿐 아니라 merge/squash/rebase 결과 OID인 mergeHash를 포함해
   *   원래 head commit이 graph 역사에서 사라진 뒤에도 merged PR badge를 표시한다.
   * @param {object} pr GitHub Pull Request 정보
   * @returns {string[]} graph row와 직접 비교할 전체 commit OID 목록
   */
  function matchingHashes(pr) {
    return uniqueHashes([
      ...(pr?.commitHashes || []),
      pr?.headHash || "",
      pr?.mergeHash || "",
    ]);
  }

  /**
   * PR 이동 버튼이 탐색할 commit OID 우선순위를 만든다.
   * - merged PR은 실제 base 역사에 남은 mergeHash를 먼저 찾고, 이후 head와 원래 commit을 역순으로 찾는다.
   * @param {object} pr 이동 대상 Pull Request 정보
   * @returns {string[]} 대표 row 탐색 순서로 정렬된 commit OID 목록
   */
  function rowHashes(pr) {
    return uniqueHashes([
      pr?.mergeHash || "",
      pr?.headHash || "",
      ...(pr?.commitHashes || []).slice().reverse(),
      ...(pr?.commitHashes || []),
    ]);
  }

  /**
   * 한 graph row에 표시할 최대 세 개의 PR badge DOM을 만든다.
   * @param {Array<object>} pullRequests 같은 commit과 연결된 PR 배열
   * @param {(pr: object) => number} commentCount PR별 최신 댓글 수를 반환하는 함수
   * @returns {HTMLSpanElement} row 맨 앞에 삽입할 badge 묶음
   */
  function badges(pullRequests, commentCount) {
    const box = document.createElement("span");
    box.className = "pr-badges";
    for (const pr of pullRequests.slice(0, 3)) {
      const button = document.createElement("button");
      const title = `Show PR #${pr.number} details`;
      const count = pr.commentCountComplete === false ? "…" : Number(commentCount?.(pr) ?? pr.commentCount) || 0;
      button.type = "button";
      button.className = `pr-row-button ${prColorClass(pr.number)}`;
      button.dataset.prNumber = String(pr.number);
      button.title = title;
      button.dataset.tooltip = title;
      button.setAttribute("aria-label", `${title}: ${pr.title}`);
      button.innerHTML = `<span class="codicon codicon-git-pull-request" aria-hidden="true"></span>` +
        `<span>#${pr.number}</span>` +
        `<span class="pr-comment-count"><span class="codicon codicon-comment-discussion" aria-hidden="true"></span>${count}</span>`;
      box.appendChild(button);
    }
    return box;
  }

  /**
   * PR의 대표 commit row로 이동하며, 아직 로드되지 않았으면 확장에 추가 로드를 요청한다.
   * @param {object|undefined} pr 이동할 Pull Request 정보
   * @returns {void}
   */
  function focusPullRequestRow(pr) {
    cancelFocus();
    const row = pr ? findPullRequestRow(pr) : null;
    if (!row) {
      clearFocusedPullRequest();
      if (pr) {
        requestCommitVisibility(rowHashes(pr), pr.number, pr);
      }
      return;
    }
    highlightCommitRow(row);
  }

  /**
   * 지정 commit row로 이동하며, 최초 탐색에서 없으면 해당 commit window 로드를 요청한다.
   * @param {string} hash 이동할 전체 commit OID
   * @param {boolean} fromVisibility 이미 추가 로드 응답을 처리 중인지 여부
   * @returns {void}
   */
  function focusCommitRow(hash, fromVisibility) {
    if (!fromVisibility) cancelFocus();
    const row = findCommitRow(hash);
    if (!row) {
      clearFocusedPullRequest();
      if (!fromVisibility) {
        requestCommitVisibility([hash]);
      }
      return;
    }
    highlightCommitRow(row);
  }

  /**
   * graph에 없는 commit 후보를 확장이 직접 읽어 오도록 메시지를 보낸다.
   * @param {string[]} hashes 우선순위대로 확인할 commit OID 후보
   * @param {number|undefined} number 진행/실패 안내를 붙일 PR 카드 번호
   * @param {object|undefined} pr 최초 요약을 다시 눌러도 이미 찾은 행을 재사용할 PR 식별 정보
   * @returns {void}
   */
  function requestCommitVisibility(hashes, number, pr) {
    const candidates = uniqueHashes(hashes);
    if (!candidates.length && !number) {
      showFocusFailure(number); return;
    }
    const requestId = `pr-focus-${++focusRequestSequence}`;
    pendingFocusRequest = { requestId, hashes: candidates, number, version: pr && pullRequestVersion(pr) };
    focusStatus = { number, loading: true, restoreFocus: document.activeElement?.dataset.focusPr === String(number) }; applyFocusStatus();
    window.GscGraphPostMessage?.({ type: "ensureCommitVisible", requestId, hashes: candidates,
      ...(number ? { pullRequestNumber: number } : {}) });
  }

  /**
   * 확장의 commit 추가 로드 응답이 최신 요청과 일치하면 발견한 row로 이동한다.
   * @param {object} message commitVisibility 웹뷰 메시지
   * @returns {void}
   */
  function handleCommitVisibility(message) {
    if (!pendingFocusRequest || message.requestId !== pendingFocusRequest.requestId) {
      return;
    }
    const request = pendingFocusRequest;
    if (!message.found || !(request.hashes.includes(message.hash) || request.number && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(message.hash))) {
      pendingFocusRequest = undefined; showFocusFailure(request.number); return;
    }
    // host 응답은 DOM 게시 뒤 오지만 너비/장식 갱신도 같은 frame에 예약될 수 있다.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (pendingFocusRequest !== request) return;
      pendingFocusRequest = undefined;
      const row = findCommitRow(message.hash);
      if (row) {
        if (request.version) resolvedPullRequest = { version: request.version, hash: message.hash };
        focusStatus = undefined; applyFocusStatus(); highlightCommitRow(row);
      }
      else showFocusFailure(request.number);
    }));
  }

  /**
   * PR hash 우선순위에서 현재 DOM에 존재하는 첫 graph row를 찾는다.
   * @param {object} pr 탐색할 Pull Request 정보
   * @returns {Element|null} 발견한 commit row 또는 null
   */
  function findPullRequestRow(pr) {
    for (const hash of rowHashes(pr)) {
      const row = findCommitRow(hash);
      if (row) {
        return row;
      }
    }
    return resolvedPullRequest?.version === pullRequestVersion(pr) ? findCommitRow(resolvedPullRequest.hash) : null;
  }

  /** 최신 한 건의 위치만 보관한다. head·상태·갱신 시각이 바뀌면 이전 요약에서 찾은 행을 재사용하지 않는다. */
  function pullRequestVersion(pr) {
    return JSON.stringify([pr.number, pr.state, pr.headHash, pr.mergeHash, pr.updatedAt, pr.headRefName, pr.baseRefName]);
  }

  /**
   * 전체 commit OID와 정확히 일치하는 현재 graph row를 찾는다.
   * @param {string} hash 찾을 전체 commit OID
   * @returns {Element|null} 발견한 row 또는 null
   */
  function findCommitRow(hash) {
    return hash
      ? document.querySelector(`#graph-content .row[data-hash="${cssEscape(hash)}"]`)
      : null;
  }

  /**
   * 발견한 commit row와 SVG node를 강조하고 viewport 중앙으로 이동한다.
   * @param {Element} row 강조할 graph commit row
   * @returns {void}
   */
  function highlightCommitRow(row) {
    clearFocusedPullRequest();
    focusedHash = row.dataset.hash || ""; decorateFocusedRow(row);
    const graph = document.getElementById("graph"), detail = document.getElementById("detail");
    // overlay drawer 아래로 스크롤만 하면 사용자는 결과를 볼 수 없다. side pane은 그대로 유지한다.
    if (detail && getComputedStyle(detail).position === "fixed") window.GscGraphDetailHost?.hide?.();
    if (graph) {
      graph.scrollTop = Math.max(0, row.offsetTop - (graph.clientHeight - row.offsetHeight) / 2);
      graph.focus({ preventScroll: true });
    }
  }

  /** metadata 갱신으로 row가 교체돼도 강조만 복원한다. 스크롤/키보드 포커스는 다시 빼앗지 않는다. */
  function decorateFocusedRow(row) {
    if (!row) return;
    row.classList.add("pr-focused-row");
    document.querySelector(`.node[data-hash="${cssEscape(row.dataset.hash || "")}"]`)?.classList.add("pr-focused-node");
  }

  /** 최신 로컬 이동·저장소 교체가 이전 비동기 응답을 무효화하고 진행/오류 UI를 해제한다. */
  function cancelFocus(resetContext) {
    if (pendingFocusRequest) window.GscGraphPostMessage?.({ type: "cancelCommitFocus", requestId: pendingFocusRequest.requestId });
    pendingFocusRequest = undefined; focusStatus = undefined; clearFocusedPullRequest(); applyFocusStatus();
    if (resetContext) resolvedPullRequest = undefined;
  }

  /** drawer를 닫을 때 진행 중 조회만 취소하며, 이동 성공 직후의 row 강조는 유지한다. */
  function cancelPendingFocus() { if (pendingFocusRequest) cancelFocus(); }

  /** 실패를 성공처럼 조용히 넘기지 않고 현재 PR 카드에서 다음 행동과 재시도를 안내한다. */
  function showFocusFailure(number) {
    focusStatus = { number, loading: false, restoreFocus: focusStatus?.restoreFocus, message: window.GscPrStackI18n?.commitNotAvailableInGraph ||
      "Could not locate the commit in the current graph. Fetch the source branch or adjust branch filters, then try again." };
    applyFocusStatus();
  }

  /** 새 PR 목록 DOM에도 같은 진행 상태를 적용하고 제목·tooltip·aria 라벨을 함께 복원한다. */
  function applyFocusStatus() {
    document.querySelectorAll("#detail [data-focus-pr]").forEach(button => {
      const busy = !!focusStatus?.loading && Number(button.dataset.focusPr) === Number(focusStatus.number);
      button.dataset.prJumpIdleTitle ||= button.title;
      const title = busy ? String(window.GscPrStackI18n?.loadingPrJump || "Locating pull request #{0} in the graph…")
        .replace("{0}", button.dataset.focusPr) : button.dataset.prJumpIdleTitle;
      button.title = title; button.dataset.tooltip = title; button.setAttribute("aria-label", title); button.disabled = busy;
      if (busy) button.setAttribute("aria-busy", "true"); else button.removeAttribute("aria-busy");
      const icon = button.querySelector(".codicon");
      if (icon) icon.className = busy ? "codicon codicon-loading" +
        (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "" : " codicon-modifier-spin") : "codicon codicon-target";
      if (!busy && focusStatus?.restoreFocus && Number(button.dataset.focusPr) === Number(focusStatus.number)
        && document.activeElement === document.body) { button.focus({ preventScroll: true }); focusStatus.restoreFocus = false; }
    });
    const host = focusStatus?.number ? document.querySelector(`#detail [data-show-pr="${cssEscape(focusStatus.number)}"]`)
      : document.querySelector("#detail [data-focus-commit]")?.closest(".pr-detail-section");
    document.querySelectorAll(".pr-jump-message").forEach(node => { if (!focusStatus?.message || node.parentElement !== host) node.remove(); });
    if (host && focusStatus?.message) {
      let notice = host.querySelector(".pr-jump-message");
      if (!notice) { notice = document.createElement("p"); notice.className = "pr-empty pr-jump-message"; notice.setAttribute("role", "status"); host.appendChild(notice); }
      if (notice.textContent !== focusStatus.message) notice.textContent = focusStatus.message;
    }
  }

  /**
   * 이전 PR/commit 이동 결과의 row와 node 강조를 모두 제거한다.
   * @returns {void}
   */
  function clearFocusedPullRequest() {
    focusedHash = "";
    document.querySelectorAll(".pr-focused-row").forEach((el) => el.classList.remove("pr-focused-row"));
    document.querySelectorAll(".pr-focused-node").forEach((el) => el.classList.remove("pr-focused-node"));
  }

  /**
   * 빈 값과 중복을 제거하면서 처음 등장한 commit OID 순서를 보존한다.
   * @param {string[]} hashes 정규화할 commit OID 후보
   * @returns {string[]} 비어 있지 않은 고유 commit OID 목록
   */
  function uniqueHashes(hashes) {
    return Array.from(new Set((hashes || []).filter(Boolean)));
  }

  /**
   * PR 번호를 안정적인 8색 palette class로 변환한다.
   * @param {number|string} number GitHub Pull Request 번호
   * @returns {string} graphPr.css palette class 이름
   */
  function prColorClass(number) {
    return `pr-color-${Math.abs(Number(number) || 0) % 8}`;
  }

  /**
   * 기존 node 장식을 초기화할 때 제거할 palette class 전체를 반환한다.
   * @returns {string[]} 여덟 개 PR palette class 이름
   */
  function prColorClasses() {
    return Array.from({ length: 8 }, (_, index) => `pr-color-${index}`);
  }

  /**
   * commit OID를 CSS attribute selector에 안전하게 넣을 문자열로 escape한다.
   * @param {string} value selector에 넣을 원문
   * @returns {string} CSS selector용 escape 문자열
   */
  function cssEscape(value) {
    return window.CSS?.escape
      ? window.CSS.escape(String(value))
      : String(value).replace(/["\\]/g, "\\$&");
  }

  window.GscGraphPrMatching = {
    applyDecorations,
    colorClass: prColorClass,
    findCommitRow,
    focusCommitRow,
    focusPullRequestRow,
    handleCommitVisibility,
    matchingHashes,
    rowHashes,
    cancelFocus,
    cancelPendingFocus,
  };
})();
