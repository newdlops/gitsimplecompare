// Git graph commit row와 GitHub Pull Request의 연결 표시/이동을 담당한다.
// - PR drawer 렌더링과 분리해 merge 결과 commit까지 일관된 hash 규칙으로 매칭한다.
(function () {
  "use strict";

  let focusRequestSequence = 0;
  let pendingFocusRequest;

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
    root.querySelectorAll(".pr-badges").forEach((el) => el.remove());
    root.querySelectorAll(".pr-row").forEach((el) => el.classList.remove("pr-row"));
    root.querySelectorAll(".node.pr-node").forEach((el) => {
      el.classList.remove("pr-node", ...prColorClasses());
    });
    const byHash = pullRequestsByHash(pullRequests);
    root.querySelectorAll(".row[data-hash]").forEach((row) => {
      const prs = byHash.get(row.dataset.hash || "") || [];
      if (!prs.length) {
        return;
      }
      row.classList.add("pr-row");
      row.insertBefore(badges(prs, commentCount), row.firstChild);
      const node = root.querySelector(`.node[data-hash="${cssEscape(row.dataset.hash || "")}"]`);
      node?.classList.add("pr-node", prColorClass(prs[0]?.number));
    });
  }

  /**
   * commit hash마다 연결된 PR 목록을 빠르게 찾는 map을 만든다.
   * @param {Array<object>} pullRequests graph에 매칭할 PR 배열
   * @returns {Map<string, Array<object>>} 전체 commit OID를 key로 갖는 PR 목록 map
   */
  function pullRequestsByHash(pullRequests) {
    const map = new Map();
    for (const pr of pullRequests || []) {
      for (const hash of matchingHashes(pr)) {
        const list = map.get(hash) || [];
        list.push(pr);
        map.set(hash, list);
      }
    }
    return map;
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
      const count = Number(commentCount?.(pr) ?? pr.commentCount) || 0;
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
    const row = pr ? findPullRequestRow(pr) : null;
    if (!row) {
      clearFocusedPullRequest();
      if (pr) {
        requestCommitVisibility(rowHashes(pr));
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
   * @returns {void}
   */
  function requestCommitVisibility(hashes) {
    const candidates = uniqueHashes(hashes);
    if (!candidates.length) {
      return;
    }
    const requestId = `pr-focus-${++focusRequestSequence}`;
    pendingFocusRequest = { requestId, hashes: candidates };
    window.GscGraphPostMessage?.({ type: "ensureCommitVisible", requestId, hashes: candidates });
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
    pendingFocusRequest = undefined;
    if (message.found && message.hash) {
      requestAnimationFrame(() => focusCommitRow(message.hash, true));
    }
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
    return null;
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
    row.classList.add("pr-focused-row");
    const hash = row.dataset.hash || "";
    document.querySelector(`.node[data-hash="${cssEscape(hash)}"]`)?.classList.add("pr-focused-node");
    row.scrollIntoView({ block: "center", inline: "nearest" });
  }

  /**
   * 이전 PR/commit 이동 결과의 row와 node 강조를 모두 제거한다.
   * @returns {void}
   */
  function clearFocusedPullRequest() {
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
  };
})();
