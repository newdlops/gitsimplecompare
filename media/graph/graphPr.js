// graph Pull Request UI.
// - PR row chip decoration, hover summary, detail drawer rendering 을 graph.js 와 분리한다.
(function () {
  "use strict";

  let overview = { available: false, pullRequests: [] };
  let activeDetail = { kind: "none" };
  let pullRequestDetails = new Map();
  let pendingDetails = new Set();
  let prListLoading = false;
  let focusRequestSeq = 0;
  let pendingFocusRequest;
  let hoverCard;

  /** PR UI 이벤트와 웹뷰 메시지 수신을 초기화한다. */
  function init() {
    document.getElementById("graph-pr-panel")?.setAttribute("hidden", "true");
    bindButton("graph-pr-list", () => showOverviewDetail(true));
    bindButton("graph-pr-preview", () => {
      window.GscGraphPostMessage?.({ type: "previewStagedPullRequest" });
    });
    document.getElementById("graph-content")?.addEventListener("click", handleGraphClick, true);
    document.getElementById("graph-content")?.addEventListener("mouseover", handleChipHover, true);
    document.getElementById("graph-content")?.addEventListener("mouseout", hideHoverCard, true);
    document.getElementById("graph-content")?.addEventListener("focusin", handleChipHover, true);
    document.getElementById("graph-content")?.addEventListener("focusout", hideHoverCard, true);
    document.getElementById("detail")?.addEventListener("click", handleDetailClick);
    document.getElementById("detail")?.addEventListener("keydown", handleDetailKeydown);
    window.addEventListener("message", handleMessage);
  }

  /** 버튼 click handler 를 연결한다. */
  function bindButton(id, handler) {
    document.getElementById(id)?.addEventListener("click", handler);
  }

  /** 확장에서 온 graph/PR 메시지를 반영한다. */
  function handleMessage(event) {
    const msg = event.data;
    if (msg.type === "pullRequestOverview") {
      prListLoading = false;
      overview = msg.overview || { available: false, pullRequests: [] };
      if (activeDetail.kind === "overview") {
        renderOverviewDetail();
      } else if (activeDetail.kind === "pr") {
        renderPullRequestDetail(activeDetail.number);
      }
      applyDecorations();
    } else if (msg.type === "pullRequestDetail") {
      pendingDetails.delete(Number(msg.number));
      pullRequestDetails.set(Number(msg.number), { status: "ready", detail: msg.detail });
      if (activeDetail.kind === "pr" && Number(activeDetail.number) === Number(msg.number)) {
        renderPullRequestDetail(activeDetail.number);
      }
    } else if (msg.type === "pullRequestDetailError") {
      pendingDetails.delete(Number(msg.number));
      pullRequestDetails.set(Number(msg.number), { status: "error", message: msg.message });
      if (activeDetail.kind === "pr" && Number(activeDetail.number) === Number(msg.number)) {
        renderPullRequestDetail(activeDetail.number);
      }
    } else if (msg.type === "commitVisibility") {
      handleCommitVisibility(msg);
    } else if (msg.type === "graph") {
      hideHoverCard();
      requestAnimationFrame(applyDecorations);
      if (activeDetail.kind === "pr") {
        requestAnimationFrame(() => renderPullRequestDetail(activeDetail.number));
      }
    }
  }

  /** graph row 안의 PR chip 클릭을 PR 상세 drawer 전환으로 처리한다. */
  function handleGraphClick(event) {
    const target = event.target.closest?.("[data-pr-number]");
    if (!target) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    hideHoverCard();
    renderPullRequestDetail(Number(target.dataset.prNumber));
  }

  /** 상세 drawer 내부 PR 버튼 클릭을 처리한다. */
  function handleDetailClick(event) {
    const show = event.target.closest?.("[data-show-pr]");
    if (show) {
      renderPullRequestDetail(Number(show.dataset.showPr));
      return;
    }
    const open = event.target.closest?.("[data-open-pr]");
    if (open) {
      window.GscGraphPostMessage?.({ type: "openPullRequest", number: Number(open.dataset.openPr) });
      return;
    }
    const preview = event.target.closest?.("[data-preview-pr]");
    if (preview) {
      window.GscGraphPostMessage?.({
        type: "previewStagedPullRequest",
        number: Number(preview.dataset.previewPr),
      });
      return;
    }
    const overviewButton = event.target.closest?.("[data-pr-overview]");
    if (overviewButton) {
      showOverviewDetail(false);
      return;
    }
    const loadMore = event.target.closest?.("[data-pr-load-more]");
    if (loadMore) {
      loadMorePullRequests();
      return;
    }
    const focus = event.target.closest?.("[data-focus-pr]");
    if (focus) {
      focusPullRequestRow(Number(focus.dataset.focusPr));
      return;
    }
    const commit = event.target.closest?.("[data-focus-commit]");
    if (commit) {
      focusCommitRow(commit.dataset.focusCommit || "");
      return;
    }
    const folder = event.target.closest?.("[data-pr-file-folder]");
    if (folder) {
      window.GscGraphPrFiles?.toggle?.(folder.dataset.prFileFolder || "");
      if (activeDetail.kind === "pr") {
        renderPullRequestDetail(activeDetail.number);
      }
    }
  }

  /** PR 목록 카드의 키보드 activation 을 graph row 이동으로 처리한다. */
  function handleDetailKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    if (event.target.closest?.("button")) {
      return;
    }
    const focus = event.target.closest?.("[data-focus-pr]");
    if (!focus) {
      return;
    }
    event.preventDefault();
    focusPullRequestRow(Number(focus.dataset.focusPr));
  }

  /** chip hover/focus 시 PR 간략 상세 카드를 표시한다. */
  function handleChipHover(event) {
    const target = event.target.closest?.("[data-pr-number]");
    if (!target) {
      return;
    }
    const pr = findPr(Number(target.dataset.prNumber));
    if (!pr) {
      return;
    }
    showHoverCard(target, pr);
  }

  /** graph row/node 에 PR badge 와 강조 class 를 반영한다. */
  function applyDecorations() {
    const root = document.getElementById("graph-content");
    if (!root) {
      return;
    }
    root.querySelectorAll(".pr-badges").forEach((el) => el.remove());
    root.querySelectorAll(".pr-row").forEach((el) => el.classList.remove("pr-row"));
    root.querySelectorAll(".node.pr-node").forEach((el) => {
      el.classList.remove("pr-node", ...prColorClasses());
    });
    const byHash = pullRequestsByHash();
    root.querySelectorAll(".row[data-hash]").forEach((row) => {
      const prs = byHash.get(row.dataset.hash || "") || [];
      if (!prs.length) {
        return;
      }
      row.classList.add("pr-row");
      row.insertBefore(badges(prs), row.firstChild);
      const node = root.querySelector(`.node[data-hash="${cssEscape(row.dataset.hash || "")}"]`);
      node?.classList.add("pr-node", prColorClass(prs[0]?.number));
    });
  }

  /** commit hash 별 PR 목록 map 을 만든다. */
  function pullRequestsByHash() {
    const map = new Map();
    for (const pr of overview.pullRequests || []) {
      for (const hash of pr.commitHashes || []) {
        const list = map.get(hash) || [];
        list.push(pr);
        map.set(hash, list);
      }
    }
    return map;
  }

  /** row 에 붙일 PR badge 묶음을 만든다. */
  function badges(prs) {
    const box = document.createElement("span");
    box.className = "pr-badges";
    for (const pr of prs.slice(0, 3)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `pr-row-button ${prColorClass(pr.number)}`;
      button.dataset.prNumber = String(pr.number);
      button.title = `Show PR #${pr.number} details`;
      button.setAttribute("aria-label", `${button.title}: ${pr.title}`);
      button.innerHTML = `<span class="codicon codicon-git-pull-request" aria-hidden="true"></span>` +
        `<span>#${pr.number}</span>` +
        `<span class="pr-comment-count"><span class="codicon codicon-comment-discussion" aria-hidden="true"></span>${commentCount(pr)}</span>`;
      box.appendChild(button);
    }
    return box;
  }

  /** toolbar PR 버튼에서 전체 PR 목록 drawer 를 연다. */
  function showOverviewDetail(refresh) {
    activeDetail = { kind: "overview" };
    renderOverviewDetail();
    window.GscGraphDetailHost?.show?.("PR details");
    if (refresh) {
      window.GscGraphPostMessage?.({ type: "refreshPullRequests" });
    }
  }

  /** PR 목록을 상세 drawer 에 렌더링한다. */
  function renderOverviewDetail() {
    const root = detailRoot();
    if (!root) {
      return;
    }
    const prs = overview.pullRequests || [];
    const previousScroll = root.querySelector(".pr-detail-shell")?.scrollTop || 0;
    const status = overview.available
      ? `${prs.length} pull requests`
      : `PR data unavailable${overview.error ? ": " + overview.error : ""}`;
    root.innerHTML = `<div class="pr-detail-shell">` +
      `<section class="pr-detail-header">` +
      `<div class="pr-detail-title"><span class="codicon codicon-git-pull-request" aria-hidden="true"></span>` +
      `<h2>Pull Requests</h2></div>` +
      `<div class="pr-detail-meta">${esc(status)}</div>` +
      `</section>` +
      `<section class="pr-detail-list">${prs.length ? prs.map(prListCard).join("") : `<p class="pr-empty">${esc(status)}</p>`}${prListFooter()}</section>` +
      `</div>`;
    const shell = root.querySelector(".pr-detail-shell");
    if (shell) { shell.addEventListener("scroll", handlePrListScroll); shell.scrollTop = previousScroll; }
  }

  /** PR 목록 drawer 스크롤이 바닥에 가까워지면 다음 PR 페이지를 요청한다. */
  function handlePrListScroll(event) {
    if (activeDetail.kind !== "overview" || prListLoading || !overview.hasMore) return;
    const el = event.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) loadMorePullRequests();
  }

  /** 다음 PR 페이지를 확장에 요청하고 footer 를 loading 상태로 바꾼다. */
  function loadMorePullRequests() {
    if (prListLoading || !overview.hasMore) return;
    prListLoading = true;
    const footer = detailRoot()?.querySelector(".pr-list-footer");
    if (footer) footer.innerHTML = `<span class="codicon codicon-loading" aria-hidden="true"></span><span>Loading more pull requests...</span>`;
    window.GscGraphPostMessage?.({ type: "loadMorePullRequests" });
  }

  /** PR 목록 하단의 pagination 상태 HTML 을 만든다. */
  function prListFooter() {
    if (prListLoading) return `<div class="pr-list-footer"><span class="codicon codicon-loading" aria-hidden="true"></span><span>Loading more pull requests...</span></div>`;
    if (overview.hasMore) {
      return `<div class="pr-list-footer"><button type="button" class="pr-icon-action" data-pr-load-more ${tooltipAttrs("Load more pull requests")}>` +
        `<span class="codicon codicon-arrow-down" aria-hidden="true"></span></button><span>More pull requests available</span></div>`;
    }
    return overview.pullRequests?.length ? `<div class="pr-list-footer"><span class="codicon codicon-check" aria-hidden="true"></span><span>All loaded</span></div>` : "";
  }

  /** PR 목록 카드 HTML 을 만든다. */
  function prListCard(pr) {
    const title = `Jump to pull request #${pr.number} row`;
    return `<article class="pr-card ${prColorClass(pr.number)}" data-focus-pr="${pr.number}" ` +
      `tabindex="0" role="button" title="${esc(title)}" aria-label="${esc(title)}">` +
      `<div class="pr-title"><span class="codicon codicon-git-pull-request" aria-hidden="true"></span>` +
      `<strong>#${pr.number}</strong><span>${esc(pr.title)}</span></div>` +
      prMetaHtml(pr) +
      `<div class="pr-actions">` +
      detailButton(pr.number) +
      openButton(pr.number, `Open pull request #${pr.number} in browser`) +
      `</div>` +
      `</article>`;
  }

  /** PR 과 연결된 graph row 중 가장 대표적인 row 로 이동하고 하이라이트한다. */
  function focusPullRequestRow(number) {
    const pr = findPr(number);
    const row = pr ? findPullRequestRow(pr) : null;
    if (!row) {
      clearFocusedPullRequest();
      if (pr) requestCommitVisibility(prRowHashes(pr));
      return;
    }
    highlightCommitRow(row);
  }

  /** commit hash 로 graph row 를 찾아 이동하고 하이라이트한다. */
  function focusCommitRow(hash, fromVisibility) {
    const row = findCommitRow(hash);
    if (!row) {
      clearFocusedPullRequest();
      if (!fromVisibility) requestCommitVisibility([hash]);
      return;
    }
    highlightCommitRow(row);
  }

  /** graph 에 없는 commit hash 후보를 확장 쪽에서 추가 로드하도록 요청한다. */
  function requestCommitVisibility(hashes) {
    const candidates = Array.from(new Set((hashes || []).filter(Boolean)));
    if (!candidates.length) {
      return;
    }
    const requestId = `pr-focus-${++focusRequestSeq}`;
    pendingFocusRequest = { requestId, hashes: candidates };
    window.GscGraphPostMessage?.({ type: "ensureCommitVisible", requestId, hashes: candidates });
  }

  /** 추가 로드 후 발견된 commit 으로 다시 점프한다. */
  function handleCommitVisibility(msg) {
    if (!pendingFocusRequest || msg.requestId !== pendingFocusRequest.requestId) {
      return;
    }
    pendingFocusRequest = undefined;
    if (msg.found && msg.hash) {
      requestAnimationFrame(() => focusCommitRow(msg.hash, true));
    }
  }

  /** PR 의 head commit 을 우선하고, 없으면 로드된 관련 commit row 를 찾는다. */
  function findPullRequestRow(pr) {
    const hashes = prRowHashes(pr);
    for (const hash of hashes) {
      const row = document.querySelector(`#graph-content .row[data-hash="${cssEscape(hash)}"]`);
      if (row) {
        return row;
      }
    }
    return null;
  }

  /** commit hash 와 일치하는 로드된 graph row 를 찾는다. */
  function findCommitRow(hash) {
    return hash ? document.querySelector(`#graph-content .row[data-hash="${cssEscape(hash)}"]`) : null;
  }

  /** 이미 찾은 graph row 를 PR/commit 이동 결과로 강조한다. */
  function highlightCommitRow(row) {
    clearFocusedPullRequest();
    row.classList.add("pr-focused-row");
    const node = document.querySelector(`.node[data-hash="${cssEscape(row.dataset.hash || "")}"]`);
    node?.classList.add("pr-focused-node");
    row.scrollIntoView({ block: "center", inline: "nearest" });
  }

  /** PR row 이동에 사용할 후보 hash 순서를 만든다. */
  function prRowHashes(pr) {
    return Array.from(new Set([
      pr.headHash || "",
      ...(pr.commitHashes || []).slice().reverse(),
      ...(pr.commitHashes || []),
    ].filter(Boolean)));
  }

  /** 이전 PR row 하이라이트를 제거한다. */
  function clearFocusedPullRequest() {
    document.querySelectorAll(".pr-focused-row").forEach((el) => el.classList.remove("pr-focused-row"));
    document.querySelectorAll(".pr-focused-node").forEach((el) => el.classList.remove("pr-focused-node"));
  }

  /** 선택한 PR 상세를 drawer 에 렌더링한다. */
  function renderPullRequestDetail(number) {
    const root = detailRoot();
    if (!root) {
      return;
    }
    const pr = findPr(number);
    if (activeDetail.kind !== "pr" || Number(activeDetail.number) !== Number(number)) {
      window.GscGraphPrFiles?.reset?.();
    }
    activeDetail = { kind: "pr", number };
    window.GscGraphDetailHost?.show?.("PR details");
    if (!pr) {
      root.innerHTML = `<p class="placeholder">Pull request #${esc(number)} is not loaded yet.</p>`;
      return;
    }
    requestPullRequestDetail(number);
    const detailState = pullRequestDetails.get(Number(number));
    root.innerHTML = `<div class="pr-detail-shell ${prColorClass(pr.number)}">` +
      `<section class="pr-detail-header">` +
      `<button type="button" class="pr-back-button" data-pr-overview ${tooltipAttrs("Show pull request list")}>` +
      `<span class="codicon codicon-arrow-left" aria-hidden="true"></span></button>` +
      `<div class="pr-detail-title"><span class="codicon codicon-git-pull-request" aria-hidden="true"></span>` +
      `<h2>#${pr.number} ${esc(pr.title)}</h2></div>` +
      prMetaHtml(pr) +
      `<div class="pr-actions">` +
      openButton(pr.number, `Open pull request #${pr.number} in browser`) +
      previewButton(pr.number, `Preview staged content against ${pr.baseRefName || "target branch"}`) +
      `</div>` +
      `</section>` +
      changedFilesSection(detailState) +
      relatedCommitsSection(pr) +
      `</div>`;
  }

  /** PR 상세에 필요한 changed files 를 아직 읽지 않았다면 확장에 요청한다. */
  function requestPullRequestDetail(number) {
    if (pullRequestDetails.has(Number(number)) || pendingDetails.has(Number(number))) {
      return;
    }
    pendingDetails.add(Number(number));
    window.GscGraphPostMessage?.({ type: "refreshPullRequestDetail", number: Number(number) });
  }

  /** PR 상세 drawer 의 changed files tree 섹션 HTML 을 만든다. */
  function changedFilesSection(state) {
    if (!state) {
      return `<section class="pr-detail-section">` +
        sectionHeading("files", "Changed files", iconCount("files", "...", "Loading changed files")) +
        `<p class="pr-empty">Loading changed files...</p></section>`;
    }
    if (state.status === "error") {
      return `<section class="pr-detail-section">` +
        sectionHeading("files", "Changed files", iconCount("warning", "!", "Changed files failed to load")) +
        `<p class="pr-empty">${esc(state.message || "Failed to load changed files.")}</p></section>`;
    }
    const detail = state.detail || { files: [], fileCount: 0, fileCommentCount: 0 };
    const note = detail.filesTruncated || detail.reviewThreadsTruncated
      ? `<p class="pr-empty">Some files or comments were omitted because this PR is very large.</p>`
      : "";
    return `<section class="pr-detail-section pr-files-section">` +
      sectionHeading("files", "Changed files",
        iconCount("files", detail.fileCount || detail.files.length, "Changed files") +
        iconCount("comment-discussion", detail.fileCommentCount || 0, "File comments")) +
      (window.GscGraphPrFiles?.render?.(detail.files || []) || `<p class="pr-empty">Changed files renderer is unavailable.</p>`) +
      note +
      `</section>`;
  }

  /** PR 상세 drawer 의 related commits 리스트 HTML 을 만든다. */
  function relatedCommitsSection(pr) {
    const hashes = prRowHashes(pr);
    return `<section class="pr-detail-section">` +
      sectionHeading("git-commit", "Related commits", iconCount("git-commit", hashes.length, "Related commits")) +
      (hashes.length ? `<div class="pr-commit-list">${hashes.map(relatedCommitButton).join("")}</div>` : `<p class="pr-empty">No related commits.</p>`) +
      `</section>`;
  }

  /** related commit 한 건을 graph row 이동 버튼으로 만든다. */
  function relatedCommitButton(hash) {
    const row = findCommitRow(hash);
    const subject = row?.dataset.subject || "Commit is not loaded in the graph yet.";
    const meta = row?.querySelector?.(".meta")?.textContent || "";
    const title = row ? `Jump to commit ${shortHash(hash)}` : `Commit ${shortHash(hash)} is not loaded in the graph`;
    return `<button type="button" class="pr-commit-item${row ? "" : " unloaded"}" data-focus-commit="${esc(hash)}" ` +
      tooltipAttrs(title) + `>` +
      `<span class="codicon codicon-git-commit" aria-hidden="true"></span>` +
      `<span class="pr-commit-hash">${esc(shortHash(hash))}</span>` +
      `<span class="pr-commit-text"><span>${esc(subject)}</span>${meta ? `<small>${esc(meta)}</small>` : ""}</span>` +
      `</button>`;
  }

  /** PR 메타 한 줄 HTML 을 만든다. */
  function prMetaHtml(pr) {
    return `<div class="pr-meta pr-meta-chips">` +
      metaChip("git-pull-request", pr.state || "OPEN", `PR state: ${pr.state || "OPEN"}`) +
      (pr.isDraft ? metaChip("edit", "Draft", "Draft pull request") : "") +
      (pr.reviewDecision ? metaChip("eye", pr.reviewDecision, `Review decision: ${pr.reviewDecision}`) : "") +
      `<span class="pr-branch-flow" ${tooltipAttrs(`${pr.headRefName} into ${pr.baseRefName}`)}>` +
      `<span class="codicon codicon-git-branch" aria-hidden="true"></span><span>${esc(pr.headRefName)}</span>` +
      `<span class="codicon codicon-arrow-right" aria-hidden="true"></span><span>${esc(pr.baseRefName)}</span></span>` +
      metaChip("files", Number(pr.fileCount) || 0, "Changed files") +
      metaChip("comment-discussion", commentCount(pr), "Total PR comments") +
      `</div>`;
  }

  /** 상세 보기 버튼 HTML 을 만든다. */
  function detailButton(number) {
    const title = `Show pull request #${number} details`;
    return `<button type="button" class="pr-icon-action" data-show-pr="${number}" ${tooltipAttrs(title)}>` +
      `<span class="codicon codicon-list-tree" aria-hidden="true"></span></button>`;
  }

  /** 브라우저 열기 버튼 HTML 을 만든다. */
  function openButton(number, title) {
    return `<button type="button" class="pr-icon-action" data-open-pr="${number}" ${tooltipAttrs(title)}>` +
      `<span class="codicon codicon-link-external" aria-hidden="true"></span></button>`;
  }

  /** staged PR preview 버튼 HTML 을 만든다. */
  function previewButton(number, title) {
    return `<button type="button" class="pr-icon-action" data-preview-pr="${number}" ${tooltipAttrs(title)}>` +
      `<span class="codicon codicon-preview" aria-hidden="true"></span></button>`;
  }

  /** 섹션 제목과 우측 icon count 묶음을 만든다. */
  function sectionHeading(icon, label, counts) {
    return `<h3 class="pr-section-heading"><span><span class="codicon codicon-${icon}" aria-hidden="true"></span>${esc(label)}</span>` +
      `<span class="pr-section-stats">${counts}</span></h3>`;
  }

  /** 숫자 요약을 아이콘 chip 으로 만든다. */
  function iconCount(icon, count, title) {
    return `<span class="pr-count-chip" ${tooltipAttrs(title)}><span class="codicon codicon-${icon}" aria-hidden="true"></span>${esc(count)}</span>`;
  }

  /** PR 메타 정보를 아이콘 chip 으로 만든다. */
  function metaChip(icon, value, title) {
    return `<span class="pr-meta-chip" ${tooltipAttrs(title)}><span class="codicon codicon-${icon}" aria-hidden="true"></span>${esc(value)}</span>`;
  }

  /** tooltip/title/aria-label 속성을 함께 만든다. */
  function tooltipAttrs(title) {
    const value = esc(title);
    return `title="${value}" data-tooltip="${value}" aria-label="${value}"`;
  }

  /** PR chip hover 카드 DOM 을 만들거나 재사용한다. */
  function ensureHoverCard() {
    if (!hoverCard) {
      hoverCard = document.createElement("div");
      hoverCard.className = "pr-hover-card";
      hoverCard.hidden = true;
      document.body.appendChild(hoverCard);
    }
    return hoverCard;
  }

  /** PR chip 근처에 간략 상세 hover 카드를 표시한다. */
  function showHoverCard(target, pr) {
    const card = ensureHoverCard();
    card.className = `pr-hover-card ${prColorClass(pr.number)}`;
    card.innerHTML = `<div class="pr-hover-title"><span class="codicon codicon-git-pull-request" aria-hidden="true"></span>` +
      `<strong>#${pr.number}</strong><span>${esc(pr.title)}</span></div>` +
      prMetaHtml(pr);
    const rect = target.getBoundingClientRect();
    card.hidden = false;
    const top = Math.min(window.innerHeight - card.offsetHeight - 8, rect.bottom + 6);
    const left = Math.min(window.innerWidth - card.offsetWidth - 8, Math.max(8, rect.left));
    card.style.top = `${Math.max(8, top)}px`;
    card.style.left = `${left}px`;
  }

  /** PR hover 카드를 숨긴다. */
  function hideHoverCard() {
    if (hoverCard) {
      hoverCard.hidden = true;
    }
  }

  /** PR 번호로 overview 안의 PR 을 찾는다. */
  function findPr(number) {
    return (overview.pullRequests || []).find((pr) => Number(pr.number) === Number(number));
  }

  /** detail root 를 반환한다. */
  function detailRoot() {
    return window.GscGraphDetailHost?.root || document.getElementById("detail");
  }

  /** PR 번호를 안정적인 팔레트 class 로 바꾼다. */
  function prColorClass(number) {
    const value = Math.abs(Number(number) || 0) % 8;
    return `pr-color-${value}`;
  }

  /** 기존 색상 class 를 지울 때 쓰는 전체 팔레트 목록을 반환한다. */
  function prColorClasses() {
    return Array.from({ length: 8 }, (_, index) => `pr-color-${index}`);
  }

  /** badge/card 에 표시할 PR 댓글 총 개수를 반환한다. */
  function commentCount(pr) {
    return Number.isFinite(Number(pr.commentCount)) ? Number(pr.commentCount) : 0;
  }

  /** 전체 commit hash 를 짧은 표시용 hash 로 줄인다. */
  function shortHash(hash) {
    return String(hash || "").slice(0, 8);
  }

  /** CSS selector 에 들어갈 값을 escape 한다. */
  function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&");
  }

  /** HTML 특수문자를 escape 한다. */
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  }

  init();
})();
