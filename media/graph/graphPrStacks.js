// Git Graph 위에 PR stack parent 흐름을 직접 그리고 Add/Restack/Submit/Advance UI를 제공한다.
// - Changes accordion과 독립적이며 commit node 사이 dashed arrow와 head row chip이 항상 관계를 보여 준다.
(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const strings = window.GscPrStackI18n || {};
  let snapshot = { repository: "", stacks: [], layers: [] };
  let loadError = "";
  let activeBranch = "";

  /** stack toolbar, graph chip, detail panel 이벤트와 extension 메시지를 등록한다. */
  function init() {
    document.getElementById("graph-pr-stacks")?.addEventListener("click", showOverview);
    document.getElementById("graph-content")?.addEventListener("click", handleGraphClick, true);
    document.getElementById("detail")?.addEventListener("click", handleDetailClick, true);
    window.addEventListener("message", handleMessage);
  }

  /** extension의 snapshot/error 또는 graph 재렌더 메시지를 받아 stack 장식을 동기화한다. */
  function handleMessage(event) {
    const message = event.data || {};
    if (message.type === "pullRequestStackSnapshot") {
      snapshot = message.snapshot || { repository: "", stacks: [], layers: [] };
      loadError = "";
      updateToolbarState();
      requestAnimationFrame(renderGraphFlow);
      if (activeBranch) renderLayerDetail(activeBranch);
      return;
    }
    if (message.type === "pullRequestStackError") {
      loadError = message.message || text("unavailable");
      updateToolbarState();
      if (activeBranch === "__overview__") showOverview();
      return;
    }
    if (message.type === "graph" || message.type === "branchStatus" || message.type === "tagStatus") {
      requestAnimationFrame(renderGraphFlow);
    }
  }

  /** toolbar button에 layer 수와 데이터 오류 상태를 접근성 label로 반영한다. */
  function updateToolbarState() {
    const button = document.getElementById("graph-pr-stacks");
    if (!button) return;
    const count = Array.isArray(snapshot.layers) ? snapshot.layers.length : 0;
    const title = loadError
      ? text("unavailableReason", loadError)
      : text("manageCount", count);
    button.title = title;
    button.dataset.tooltip = title;
    button.setAttribute("aria-label", title);
    button.classList.toggle("has-stack-layers", count > 0);
    button.classList.toggle("has-stack-error", Boolean(loadError));
  }

  /** 현재 commit node 사이 PR 방향 arrow와 layer head chip을 다시 그린다. */
  function renderGraphFlow() {
    const root = document.getElementById("graph-content");
    if (!root) return;
    root.querySelector(".pr-stack-flow-overlay")?.remove();
    root.querySelectorAll(".pr-stack-layer-chip").forEach((element) => element.remove());
    root.querySelectorAll(".pr-stack-head-row").forEach((element) =>
      element.classList.remove("pr-stack-head-row")
    );
    const baseSvg = root.querySelector("svg:not(.pr-stack-flow-overlay)");
    const layers = Array.isArray(snapshot.layers) ? snapshot.layers : [];
    if (!baseSvg || !layers.length) return;
    const overlay = svgElement("svg", {
      class: "pr-stack-flow-overlay",
      width: baseSvg.getAttribute("width") || "100%",
      height: baseSvg.getAttribute("height") || "0",
      "aria-hidden": "true",
    });
    overlay.appendChild(arrowDefinitions());
    for (const layer of layers) {
      appendLayerChip(root, layer);
      appendLayerArrow(root, overlay, layer);
    }
    root.appendChild(overlay);
  }

  /** layer head commit row에 상태/PR 번호가 포함된 stack action chip을 붙인다. */
  function appendLayerChip(root, layer) {
    const row = findRow(root, layer.headHash);
    if (!row) return;
    row.classList.add("pr-stack-head-row");
    const button = document.createElement("button");
    const pullRequest = layer.pullRequest;
    const state = pullRequest?.state || (layer.local ? text("local") : text("remote"));
    const number = pullRequest?.number ? ` #${pullRequest.number}` : "";
    const title = text("showLayerFlow", layer.branch, layer.parentBranch);
    button.type = "button";
    button.className = `pr-stack-layer-chip state-${String(state).toLowerCase()}` +
      (layer.needsRestack ? " needs-restack" : "");
    button.dataset.stackBranch = layer.branch;
    button.title = title;
    button.dataset.tooltip = title;
    button.setAttribute("aria-label", title);
    button.innerHTML =
      `<span class="codicon codicon-layers" aria-hidden="true"></span>` +
      `<span class="pr-stack-chip-depth">L${Number(layer.depth) + 1}</span>` +
      `<span>${escapeHtml(number || layer.branch)}</span>` +
      (layer.needsRestack
        ? `<span class="codicon codicon-warning" aria-hidden="true"></span>`
        : "");
    row.insertBefore(button, row.firstChild);
  }

  /** graph에 head와 parent node가 모두 보이면 head→base dashed arrow를 overlay에 추가한다. */
  function appendLayerArrow(root, overlay, layer) {
    const head = findNode(root, layer.headHash);
    const parent = findNode(root, layer.parentHash);
    if (!head || !parent || layer.headHash === layer.parentHash) return;
    const headX = numberAttribute(head, "cx");
    const headY = numberAttribute(head, "cy");
    const parentX = numberAttribute(parent, "cx");
    const parentY = numberAttribute(parent, "cy");
    const railX = Math.max(headX, parentX) + 10 + Math.min(Number(layer.depth) || 0, 5) * 4;
    const path = svgElement("path", {
      class: `pr-stack-flow-path${layer.needsRestack ? " needs-restack" : ""}`,
      d: `M ${headX} ${headY} C ${railX} ${headY}, ${railX} ${parentY}, ${parentX} ${parentY}`,
      "marker-end": "url(#pr-stack-arrow-head)",
    });
    const title = svgElement("title", {});
    title.textContent = text("pullRequestFlow", layer.parentBranch, layer.branch);
    path.appendChild(title);
    overlay.appendChild(path);
  }

  /** stack chip click을 commit 선택보다 먼저 소비하고 해당 layer detail을 연다. */
  function handleGraphClick(event) {
    const chip = event.target.closest?.("[data-stack-branch]");
    if (!chip) return;
    event.preventDefault();
    event.stopPropagation();
    renderLayerDetail(chip.dataset.stackBranch || "");
  }

  /** detail 내부 stack action/open/overview 버튼을 extension 메시지 또는 내부 렌더로 연결한다. */
  function handleDetailClick(event) {
    const action = event.target.closest?.("[data-stack-action]");
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      postStackAction(action.dataset.stackAction, action.dataset.stackBranch, action.dataset.parentHash);
      return;
    }
    const layerButton = event.target.closest?.("[data-show-stack-layer]");
    if (layerButton) {
      event.preventDefault();
      renderLayerDetail(layerButton.dataset.showStackLayer || "");
      return;
    }
    const open = event.target.closest?.("[data-open-stack-pr]");
    if (open) {
      event.preventDefault();
      window.GscGraphPostMessage?.({ type: "openPullRequest", number: Number(open.dataset.openStackPr) });
      return;
    }
    if (event.target.closest?.("[data-stack-overview]")) {
      event.preventDefault();
      showOverview();
    }
  }

  /** toolbar에서 전체 stack 흐름과 네 lifecycle action을 detail panel에 표시한다. */
  function showOverview() {
    activeBranch = "__overview__";
    const root = detailRoot();
    if (!root) return;
    window.GscGraphDetailHost?.show?.(text("stackDetails"));
    const stacks = Array.isArray(snapshot.stacks) ? snapshot.stacks : [];
    root.innerHTML = `<div class="pr-stack-detail-shell">` +
      detailHeader(text("stacks"), `${snapshot.repository || text("localRepository")}`,
        actionButton("addLayer", "", "", "add", text("addLayer"))) +
      (loadError ? `<p class="pr-stack-error">${escapeHtml(loadError)}</p>` : "") +
      `<section class="pr-stack-overview-list">` +
      (stacks.length ? stacks.map(stackCard).join("") : emptyStackCard()) +
      `</section></div>`;
  }

  /** 선택 layer의 parent/head/상태와 실행 가능한 lifecycle 버튼을 detail panel에 표시한다. */
  function renderLayerDetail(branch) {
    const layer = findLayer(branch);
    if (!layer) {
      showOverview();
      return;
    }
    activeBranch = layer.branch;
    const root = detailRoot();
    if (!root) return;
    window.GscGraphDetailHost?.show?.(text("layerDetails"));
    const pr = layer.pullRequest;
    const actions = [
      actionButton("addLayer", layer.branch, layer.headHash, "add", text("addChild", layer.branch)),
      layer.local ? actionButton("restack", layer.branch, "", "debug-restart", text("restackDescendants", layer.branch)) : "",
      layer.local ? actionButton("submit", layer.branch, "", "cloud-upload", text("submitStack", layer.branch)) : "",
      pr?.state === "MERGED" && layer.childBranches?.length
        ? actionButton("advance", layer.branch, "", "git-merge", text("advanceChildren", pr.number))
        : "",
      pr?.number ? openPrButton(pr.number) : "",
    ].join("");
    root.innerHTML = `<div class="pr-stack-detail-shell">` +
      detailHeader(layer.branch, `${layer.parentBranch} ← ${layer.branch}`, actions, true) +
      `<dl class="pr-stack-layer-summary">` +
      summaryRow(text("parent"), layer.parentBranch) +
      summaryRow(text("localBranch"), layer.local ? text("yes") : text("no")) +
      summaryRow(text("pullRequest"), pr?.number ? `#${pr.number} · ${pr.state || "OPEN"}` : text("notSubmitted")) +
      summaryRow(text("restack"), layer.needsRestack ? text("restackRequired") : text("upToDate")) +
      (layer.worktreePath ? summaryRow(text("worktree"), layer.worktreePath) : "") +
      `</dl>` +
      (layer.childBranches?.length
        ? `<section class="pr-stack-child-list"><h3>${escapeHtml(text("childLayers"))}</h3>${layer.childBranches.map(childButton).join("")}</section>`
        : `<p class="pr-stack-empty">${escapeHtml(text("topLayer"))}</p>`) +
      `</div>`;
  }

  /** 연결 stack 한 개를 root base와 parent→child layer row 목록으로 렌더링한다. */
  function stackCard(stack) {
    return `<article class="pr-stack-card">` +
      `<header><span class="codicon codicon-git-branch" aria-hidden="true"></span>` +
      `<strong>${escapeHtml(stack.rootBaseRefName || text("base"))}</strong></header>` +
      `<div class="pr-stack-card-layers">${(stack.layers || []).map(layerCardRow).join("")}</div>` +
      `</article>`;
  }

  /** overview stack card 안의 layer 이동 버튼 한 행을 만든다. */
  function layerCardRow(layer) {
    const pr = layer.pullRequest;
    const label = pr?.number ? `#${pr.number} ${layer.branch}` : layer.branch;
    const title = text("showLayer", layer.branch);
    return `<button type="button" class="pr-stack-card-layer${layer.needsRestack ? " needs-restack" : ""}" ` +
      `style="--stack-depth:${Number(layer.depth) || 0}" data-show-stack-layer="${escapeHtml(layer.branch)}" ${tooltip(title)}>` +
      `<span class="pr-stack-card-rail" aria-hidden="true"></span>` +
      `<span class="codicon codicon-git-pull-request" aria-hidden="true"></span>` +
      `<span>${escapeHtml(label)}</span>` +
      `<small>${escapeHtml(pr?.state || (layer.local ? text("local") : text("remote")))}</small>` +
      `</button>`;
  }

  /** stack이 아직 없을 때 Add Layer 진입점을 포함한 빈 상태를 만든다. */
  function emptyStackCard() {
    return `<div class="pr-stack-empty-card"><span class="codicon codicon-layers" aria-hidden="true"></span>` +
      `<p>${escapeHtml(text("noLayers"))}</p>` +
      actionButton("addLayer", "", "", "add", text("addFirstLayer")) + `</div>`;
  }

  /** detail header를 제목/흐름/meta action 버튼으로 만든다. */
  function detailHeader(title, subtitle, actions, back) {
    return `<header class="pr-stack-detail-header">` +
      (back ? `<button type="button" class="pr-stack-icon-button" data-stack-overview ${tooltip(text("showAll"))}>` +
        `<span class="codicon codicon-arrow-left" aria-hidden="true"></span></button>` : "") +
      `<span class="codicon codicon-layers pr-stack-detail-icon" aria-hidden="true"></span>` +
      `<div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div>` +
      `<div class="pr-stack-detail-actions">${actions || ""}</div></header>`;
  }

  /** stack action 하나를 tooltip/aria가 있는 icon button으로 만든다. */
  function actionButton(action, branch, parentHash, icon, title) {
    return `<button type="button" class="pr-stack-icon-button" data-stack-action="${action}" ` +
      `data-stack-branch="${escapeHtml(branch || "")}" data-parent-hash="${escapeHtml(parentHash || "")}" ${tooltip(title)}>` +
      `<span class="codicon codicon-${icon}" aria-hidden="true"></span></button>`;
  }

  /** GitHub PR을 브라우저에서 여는 tooltip icon button을 만든다. */
  function openPrButton(number) {
    return `<button type="button" class="pr-stack-icon-button" data-open-stack-pr="${Number(number)}" ` +
      tooltip(text("openPullRequest", number)) + `>` +
      `<span class="codicon codicon-link-external" aria-hidden="true"></span></button>`;
  }

  /** 선택 child layer detail로 이동하는 버튼을 만든다. */
  function childButton(branch) {
    return `<button type="button" class="pr-stack-child-button" data-show-stack-layer="${escapeHtml(branch)}" ` +
      tooltip(text("showChild", branch)) + `><span class="codicon codicon-arrow-up" aria-hidden="true"></span>` +
      `<span>${escapeHtml(branch)}</span></button>`;
  }

  /** label/value 요약 행을 만든다. */
  function summaryRow(label, value) {
    return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  }

  /** stack action 메시지를 선택 branch/head 문맥과 함께 extension으로 보낸다. */
  function postStackAction(action, branch, parentHash) {
    if (!action) return;
    window.GscGraphPostMessage?.({
      type: "pullRequestStackAction",
      action,
      branch: branch || undefined,
      parentHash: parentHash || undefined,
    });
  }

  /** snapshot 전체 layer에서 branch 이름으로 한 건을 찾는다. */
  function findLayer(branch) {
    return (snapshot.layers || []).find((layer) => layer.branch === branch);
  }

  /** commit hash에 정확히 대응하는 graph text row를 찾는다. */
  function findRow(root, hash) {
    return hash ? root.querySelector(`.row[data-hash="${cssEscape(hash)}"]`) : null;
  }

  /** commit hash에 정확히 대응하는 graph SVG node를 찾는다. */
  function findNode(root, hash) {
    return hash ? root.querySelector(`.node[data-hash="${cssEscape(hash)}"]`) : null;
  }

  /** SVG element의 숫자 attribute를 좌표 계산용 number로 읽는다. */
  function numberAttribute(element, name) {
    return Number(element.getAttribute(name)) || 0;
  }

  /** SVG namespace element를 만들고 전달한 attribute를 설정한다. */
  function svgElement(name, attributes) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  /** stack dashed path 끝에 사용할 VS Code foreground색 arrow marker를 만든다. */
  function arrowDefinitions() {
    const defs = svgElement("defs", {});
    const marker = svgElement("marker", {
      id: "pr-stack-arrow-head", markerWidth: "7", markerHeight: "7",
      refX: "6", refY: "3.5", orient: "auto", markerUnits: "strokeWidth",
    });
    marker.appendChild(svgElement("path", { d: "M 0 0 L 7 3.5 L 0 7 z", class: "pr-stack-arrow-shape" }));
    defs.appendChild(marker);
    return defs;
  }

  /** 상세 패널 root를 공용 host 또는 fallback DOM에서 찾는다. */
  function detailRoot() {
    return window.GscGraphDetailHost?.root || document.getElementById("detail");
  }

  /** 버튼 tooltip/title/aria-label 세 속성을 항상 함께 만든다. */
  function tooltip(title) {
    const value = escapeHtml(title);
    return `title="${value}" data-tooltip="${value}" aria-label="${value}"`;
  }

  /** extension이 주입한 localized template의 {0} placeholder를 값으로 치환한다. */
  function text(key, ...values) {
    const template = String(strings[key] || key);
    return template.replace(/\{(\d+)\}/g, (match, index) =>
      Number(index) < values.length ? String(values[Number(index)]) : match
    );
  }

  /** HTML text/attribute 삽입 전에 특수문자를 escape한다. */
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[character]));
  }

  /** CSS attribute selector에 commit hash/branch 문자열을 안전하게 넣는다. */
  function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&");
  }

  init();
})();
