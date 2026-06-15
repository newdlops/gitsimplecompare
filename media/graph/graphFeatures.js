// git graph 웹뷰의 보조 UI 스크립트.
// - 로컬 브랜치 ref 배지 상태와 노드 드래그 기반 이벤트를 graph.js 와 분리해 파일 크기를 제한한다.
(function () {
  "use strict";

  let localBranches = new Map();
  let localBranchColors = new Map();
  let searchBound = false;

  /** HTML 특수문자를 이스케이프해 안전하게 삽입한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 확장에서 받은 로컬 브랜치 상태를 ref 이름으로 빠르게 찾을 수 있게 저장한다. */
  function setLocalBranches(branches) {
    localBranches = new Map();
    localBranchColors = new Map();
    (branches || []).forEach((branch) => {
      localBranches.set(branch.name, branch);
    });
    Array.from(localBranches.keys()).forEach((name) => {
      localBranchColors.set(
        name,
        window.GscGraphColors?.branchColor?.(name)
      );
    });
  }

  /** 로컬 브랜치 상태를 CSS class 조합으로 변환한다. */
  function branchClass(branch) {
    return [
      "ref",
      "local",
      branch.current ? "" : "branch-action",
      branch.current ? "current-local" : "",
      branch.gone ? "gone" : "",
      branch.ahead > 0 ? "ahead" : "",
      branch.behind > 0 ? "behind" : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  /** 로컬 브랜치가 remote 기준과 갈라져 별도 색으로 보여야 하는지 확인한다. */
  function isSplitLocalBranch(branch) {
    return Boolean(branch && (branch.ahead > 0 || !branch.upstream || branch.gone));
  }

  /** 브랜치 이름에 대해 현재 그래프 세션에서 고정된 색상을 반환한다. */
  function branchColor(name, baseIndex) {
    return (
      localBranchColors.get(name) ||
      window.GscGraphColors?.branchColor?.(name, baseIndex) ||
      ""
    );
  }

  /** 브랜치 이름에 맞는 chip 색상 CSS 변수를 만든다. */
  function branchStyle(name) {
    const color = branchColor(name);
    return color ? ` style="--branch-color: ${esc(color)}"` : "";
  }

  /** row 의 대표 브랜치 강조 색을 찾는다. */
  function rowColor(row) {
    const localOnlyBranch = localOnlyBranchForRow(row);
    if (localOnlyBranch) {
      return branchColor(localOnlyBranch, row.color);
    }
    const branchRef = (row.refs || []).find((ref) =>
      isSplitLocalBranch(localBranches.get(ref))
    );
    return branchRef
      ? branchColor(branchRef, row.color)
      : undefined;
  }

  /** local-only row 에서 색상 기준으로 삼을 브랜치를 고른다. */
  function localOnlyBranchForRow(row) {
    const branches = (row.localOnlyBranches || []).filter(Boolean);
    if (!branches.length) {
      return "";
    }
    const refs = new Set(row.refs || []);
    const refBranch = branches.find((branch) => refs.has(branch));
    if (refBranch) {
      return refBranch;
    }
    if (branches.length === 1) {
      return branches[0];
    }
    const current = branches.find((branch) => localBranches.get(branch)?.current);
    return current || [...branches].sort()[0];
  }

  /** ref 문자열이 tag 내부 표기인지 확인한다. */
  function isTagRef(ref) {
    return ref.indexOf("tag:") === 0;
  }

  /** tag 내부 표기에서 사용자에게 보여줄 tag 이름을 꺼낸다. */
  function tagName(ref) {
    return ref.slice("tag:".length);
  }

  /** 로컬 브랜치 배지의 hover tooltip 내용을 만든다. */
  function branchTitle(branch) {
    const parts = [];
    if (branch.current) {
      parts.push(`Current branch: ${branch.name}`);
      parts.push("Click for branch actions including clone");
    } else {
      parts.push(`Click to checkout this branch: ${branch.name}`);
      parts.push("Right-click for branch actions including clone");
    }
    if (branch.gone) {
      parts.push("upstream gone");
    } else if (branch.upstream) {
      parts.push(`upstream ${branch.upstream}`);
    }
    if (branch.ahead > 0) {
      parts.push(`ahead ${branch.ahead}`);
    }
    if (branch.behind > 0) {
      parts.push(`behind ${branch.behind}`);
    }
    if (branch.subject) {
      parts.push(branch.subject);
    }
    return parts.join(" | ");
  }

  /** 커밋 행의 ref 문자열을 브랜치/HEAD/원격 상태에 맞는 배지 HTML 로 만든다. */
  function refBadge(ref, escapeHtml) {
    const safeEsc = escapeHtml || esc;
    if (ref === "HEAD") {
      return `<span class="ref head">${safeEsc(ref)}</span>`;
    }
    if (isTagRef(ref)) {
      const name = tagName(ref);
      return `<span class="ref tag" role="button" tabindex="0" data-tag-name="${safeEsc(
        name
      )}" title="${safeEsc(`tag ${name}`)}" aria-label="${safeEsc(`tag ${name}`)}">` +
        `<span class="codicon codicon-tag ref-icon" aria-hidden="true"></span>` +
        `<span class="ref-label">${safeEsc(name)}</span></span>`;
    }
    if (isVirtualRef(ref)) {
      return virtualBadge(ref, safeEsc);
    }
    const branch = localBranches.get(ref);
    if (branch) {
      const attrs = branch.current
        ? ` data-branch-name="${safeEsc(branch.name)}" data-branch-kind="local"`
        : ` role="button" tabindex="0" data-checkout-branch="${safeEsc(
            branch.name
          )}" data-branch-name="${safeEsc(
            branch.name
          )}" data-branch-kind="local" aria-label="${safeEsc(
            `Branch actions for ${branch.name}`
          )}"`;
      return `<span class="${branchClass(branch)}" data-tooltip="${safeEsc(
        branchTitle(branch)
      )}"${attrs}${branchStyle(branch.name)}><span class="codicon codicon-git-branch ref-icon" ` +
        `aria-hidden="true"></span><span class="ref-label">${safeEsc(ref)}</span></span>`;
    }
    const remote = ref.indexOf("/") >= 0;
    const className = remote ? "ref remote branch-action" : "ref";
    const icon = remote
      ? '<span class="codicon codicon-cloud ref-icon" aria-hidden="true"></span>'
      : "";
    const attrs = remote
      ? ` role="button" tabindex="0" data-branch-name="${safeEsc(ref)}" ` +
        `data-branch-kind="remote" data-tooltip="${safeEsc(
          `Click for branch actions: ${ref}`
        )}" ` +
        `aria-label="${safeEsc(`Branch actions for remote branch ${ref}`)}"`
      : "";
    const title = remote ? "" : ` title="${safeEsc(ref)}"`;
    return `<span class="${className}"${branchStyle(ref)}${attrs}${title}>${icon}<span class="ref-label">${safeEsc(ref)}</span></span>`;
  }

  /** 커밋 상세 패널에 표시할 액션 버튼 HTML 을 만든다. */
  function commitActions(detail, safeEsc) {
    if (detail.kind) {
      return "";
    }
    const actions = [
      actionButton("checkout-commit", "debug-restart", "Checkout detached", "Checkout"),
      actionButton("create-branch", "git-branch-create", "Create branch here", "Create Branch", "create-action"),
      actionButton("create-tag", "tag", "Create tag here", "Create Tag", "create-action"),
      actionButton("cherry-pick", "git-pull-request", "Cherry-pick commit", "Cherry-pick"),
    ];
    if (undoableHeadBranch(detail.hash)) {
      actions.push(actionButton("undo-commit", "discard", "Undo latest unpushed commit and keep changes staged.", "Undo Commit"));
    }
    if (branchesAtHash(detail.hash).length > 0) {
      actions.push(actionButton("delete-branch", "trash", "Delete a local branch at this commit.", "Delete Branch"));
    }
    return actions.join("");
  }

  /** 액션 버튼 한 개의 HTML 을 만든다. */
  function actionButton(id, icon, title, label, className) {
    const cls = className ? ` class="${className}"` : "";
    return `<button id="${id}"${cls} type="button" title="${title}" aria-label="${title}">` +
      `<span class="codicon codicon-${icon}" aria-hidden="true"></span>` +
      `<span>${label}</span></button>`;
  }

  /** 커밋 상세 패널 액션 버튼을 웹뷰 메시지에 연결한다. */
  function bindCommitActions(root, detail) {
    const bind = (id, message) => {
      root.querySelector(`#${id}`)?.addEventListener("click", () =>
        window.GscGraphPostMessage?.(message())
      );
    };
    bind("copy-hash-inline", () => ({ type: "copyCommitHash", hash: detail.hash }));
    bind("copy-message-inline", () => ({ type: "copyCommitMessage", message: detail.message }));
    bind("checkout-commit", () => ({ type: "checkoutCommit", hash: detail.hash }));
    bind("create-branch", () => ({ type: "createBranch", hash: detail.hash }));
    bind("create-tag", () => ({ type: "createTag", hash: detail.hash }));
    bind("cherry-pick", () => ({ type: "cherryPick", hash: detail.hash }));
    bind("undo-commit", () => ({ type: "undoCommit", hash: detail.hash }));
    bind("delete-branch", () => deleteBranchMessage(detail.hash));
  }

  /** ongoing/staged 내부 ref 를 가상 커밋 chip 으로 만든다. */
  function virtualBadge(ref, safeEsc) {
    const kind = ref.slice("virtual:".length);
    const label = kind === "ongoing" ? "Ongoing" : "Staged";
    const icon = kind === "ongoing" ? "codicon-edit" : "codicon-checklist";
    return `<span class="ref virtual ${safeEsc(kind)}">` +
      `<span class="codicon ${icon} ref-icon" aria-hidden="true"></span>` +
      `<span class="ref-label">${safeEsc(label)}</span></span>`;
  }

  /** ref 문자열이 가상 커밋 내부 표기인지 확인한다. */
  function isVirtualRef(ref) {
    return ref.indexOf("virtual:") === 0;
  }

  /** 커밋 노드의 SVG class 를 ref/kind 기준으로 만든다. */
  function nodeClass(row) {
    const refs = row.refs || [];
    const localOnly = (row.localOnlyBranches || []).length > 0;
    return [
      "node",
      row.kind ? `${row.kind}-node` : "",
      refs.some((ref) => localBranches.has(ref)) || localOnly ? "local-node" : "",
      localOnly ? "local-only-node" : "",
      refs.some(isTagRef) ? "tag-node" : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  /** 검색 입력/후보 목록 이벤트를 한 번만 연결한다. */
  function initSearch(graphEl, root) {
    if (searchBound) {
      return;
    }
    const input = document.getElementById("graph-search-input");
    const results = document.getElementById("graph-search-results");
    if (!input || !results) {
      return;
    }
    searchBound = true;
    input.addEventListener("input", () => renderSearchResults(input, results, root));
    input.addEventListener("focus", () => renderSearchResults(input, results, root));
    results.addEventListener("click", (event) => {
      const item = event.target.closest?.("[data-hash]");
      if (!item) {
        return;
      }
      jumpToHash(graphEl, root, item.dataset.hash);
      results.hidden = true;
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest?.("#graph-search")) {
        results.hidden = true;
      }
    });
  }

  /** 그래프가 다시 그려진 뒤 열려 있는 검색 후보 목록을 현재 row 기준으로 갱신한다. */
  function updateSearchIndex(graphEl, root) {
    const input = document.getElementById("graph-search-input");
    const results = document.getElementById("graph-search-results");
    if (input && results && input.value.trim()) {
      renderSearchResults(input, results, root);
    }
  }

  /** 검색어에 맞는 commit/hash/branch 후보 목록을 렌더링한다. */
  function renderSearchResults(input, results, root) {
    const query = input.value.trim().toLowerCase();
    if (!query) {
      results.hidden = true;
      results.innerHTML = "";
      return;
    }
    const rows = searchCandidates(root, query).slice(0, 30);
    results.hidden = false;
    results.innerHTML = rows.length
      ? rows.map(searchResultHtml).join("")
      : '<div class="search-empty">No matches in loaded commits</div>';
  }

  /** 현재 로드된 row 에서 검색 후보를 만든다. */
  function searchCandidates(root, query) {
    return Array.from(root.querySelectorAll(".row")).flatMap((row) => {
      const hash = row.dataset.hash || "";
      const subject = row.dataset.subject || "";
      const refs = (row.dataset.refs || "").split("\t").filter(Boolean);
      const matches = [];
      if (hash.toLowerCase().includes(query) || subject.toLowerCase().includes(query)) {
        matches.push({
          type: "Commit",
          hash,
          label: subject || hash,
          meta: searchMeta(hash, refs),
        });
      }
      refs
        .filter((ref) => ref.toLowerCase().includes(query))
        .forEach((ref) => matches.push({
          type: ref.indexOf("tag:") === 0 ? "Tag" : "Branch",
          hash,
          label: ref.replace(/^tag:/, ""),
          meta: searchMeta(hash, refs),
        }));
      return matches;
    });
  }

  /** 검색 결과 오른쪽 메타 영역에 표시할 해시와 브랜치 요약을 만든다. */
  function searchMeta(hash, refs) {
    const branches = branchRefs(refs);
    return branches.length
      ? `${hash.slice(0, 10)} | ${branches.join(", ")}`
      : `${hash.slice(0, 10)} | no branch ref`;
  }

  /** HEAD/tag/가상 ref 를 제외하고 사용자 브랜치 ref 만 추린다. */
  function branchRefs(refs) {
    return refs.filter((ref) =>
      ref !== "HEAD" && !isTagRef(ref) && !isVirtualRef(ref)
    );
  }

  /** 검색 후보 한 줄 HTML 을 만든다. */
  function searchResultHtml(item) {
    const title = `${item.type}: ${item.label} | ${item.meta}`;
    return `<button class="search-result" type="button" data-hash="${esc(item.hash)}" ` +
      `title="${esc(title)}" aria-label="${esc(title)}">` +
      `<span class="search-kind">${esc(item.type)}</span>` +
      `<span class="search-label">${esc(item.label)}</span>` +
      `<span class="search-meta">${esc(item.meta)}</span></button>`;
  }

  /** 검색 후보 선택 시 해당 row 로 이동하고 잠깐 강조한다. */
  function jumpToHash(graphEl, root, hash) {
    const row = Array.from(root.querySelectorAll(".row")).find((item) => item.dataset.hash === hash);
    if (!row) {
      return;
    }
    graphEl.scrollTop = Math.max(0, row.offsetTop - 80);
    root.querySelectorAll(".search-hit").forEach((item) => item.classList.remove("search-hit"));
    row.classList.add("search-hit");
    window.setTimeout(() => row.classList.remove("search-hit"), 2200);
  }

  /** 노드 drag 상태를 custom event 로 흘려보내 후속 기능이 연결될 수 있게 한다. */
  function emitDrag(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  /** SVG commit node 에 pointer drag lifecycle 을 연결한다. */
  function attachNodeDrag(root) {
    if (!root) {
      return;
    }
    attachBranchCheckout(root);
    attachRefActionMenu(root);
    attachGraphContextMenu(root);
    attachRowDrag(root);
    root.querySelectorAll(".node").forEach((node) => {
      if (node.dataset.dragBound === "1") {
        return;
      }
      node.dataset.dragBound = "1";
      node.addEventListener("pointerdown", (event) => startNodeDrag(event, node));
    });
  }

  /** 브랜치/태그 chip 의 click/keyboard 보조 액션을 연결한다. 우클릭은 graphContextMenu 가 맡는다. */
  function attachRefActionMenu(root) {
    if (root.dataset.refActionBound === "1") {
      return;
    }
    root.dataset.refActionBound = "1";
    root.addEventListener("click", handleRefActionEvent, true);
    root.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        handleRefActionEvent(event);
      }
    }, true);
  }

  /** 커밋 행 전체를 노드 drag handle 로 등록한다. */
  function attachRowDrag(root) {
    root.querySelectorAll(".row").forEach((row) => {
      if (row.dataset.dragBound === "1") {
        return;
      }
      row.dataset.dragBound = "1";
      row.addEventListener("pointerdown", (event) => {
        if (event.target.closest?.(".ref,button,.rebase-row-actions")) {
          return;
        }
        const node = nodeForHash(root, row.dataset.hash || "");
        if (node) {
          startNodeDrag(event, node, row);
        }
      });
    });
  }

  /** graph 전용 context menu 를 연결하고 undo 가능 여부 계산 함수를 넘긴다. */
  function attachGraphContextMenu(root) {
    window.GscGraphContextMenu?.attach(root, {
      canUndoCommit: undoableHeadBranch,
    });
  }

  /** 브랜치/태그 chip 이벤트를 액션 메뉴 웹뷰 메시지로 변환한다. */
  function handleRefActionEvent(event) {
    const target = eventTargetElement(event)?.closest?.("[data-tag-name],[data-branch-name]");
    if (!target || target.dataset.checkoutBranch) {
      return;
    }
    const tag = target.dataset.tagName;
    const branch = target.dataset.branchName;
    event.preventDefault();
    event.stopPropagation();
    if (tag) {
      window.GscGraphPostMessage?.({ type: "tagAction", tag });
    } else if (branch) {
      const kind = target.dataset.branchKind || "local";
      if (kind === "remote") {
        window.GscGraphPostMessage?.({ type: "branchAction", branch, kind });
        return;
      }
      window.GscGraphPostMessage?.({
        type: "branchAction",
        branch,
        kind,
      });
    }
  }

  /** 로컬 브랜치 chip 의 click/keyboard action menu 를 이벤트 위임으로 연결한다. */
  function attachBranchCheckout(root) {
    if (root.dataset.branchCheckoutBound === "1") {
      return;
    }
    root.dataset.branchCheckoutBound = "1";
    root.addEventListener("click", handleBranchCheckoutEvent, true);
    root.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        handleBranchCheckoutEvent(event);
      }
    }, true);
  }

  /** 브랜치 chip 이벤트를 branchAction 웹뷰 메시지로 변환한다. */
  function handleBranchCheckoutEvent(event) {
    const target = eventTargetElement(event)?.closest?.("[data-checkout-branch]");
    if (!target) {
      return;
    }
    const branch = target.dataset.checkoutBranch;
    if (!branch) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    window.GscGraphPostMessage?.({ type: "branchAction", branch, kind: "local" });
  }

  /** 이벤트 target 을 closest 를 호출할 수 있는 Element 로 정규화한다. */
  function eventTargetElement(event) {
    return event.target?.nodeType === Node.ELEMENT_NODE
      ? event.target
      : event.target?.parentElement;
  }

  /** 하나의 node drag 를 시작하고 pointermove/up 핸들러를 등록한다. */
  function startNodeDrag(event, node, handle) {
    if (event.button != null && event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const hash = node.dataset.hash || "";
    const dragHandle = handle || node;
    node.classList.add("dragging-node");
    dragHandle.classList.add("dragging-row");
    dragHandle.setPointerCapture?.(event.pointerId);
    emitDrag("gsc-node-drag-start", { hash, x: startX, y: startY });

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      node.setAttribute("transform", `translate(${dx} ${dy})`);
      emitDrag("gsc-node-drag", { hash, dx, dy });
    };
    const onUp = (upEvent) => {
      const dx = upEvent.clientX - startX;
      const dy = upEvent.clientY - startY;
      node.classList.remove("dragging-node");
      node.removeAttribute("transform");
      dragHandle.classList.remove("dragging-row");
      dragHandle.releasePointerCapture?.(event.pointerId);
      dragHandle.removeEventListener("pointermove", onMove);
      dragHandle.removeEventListener("pointerup", onUp);
      dragHandle.removeEventListener("pointercancel", onUp);
      emitDrag("gsc-node-drag-end", { hash, dx, dy });
    };
    dragHandle.addEventListener("pointermove", onMove);
    dragHandle.addEventListener("pointerup", onUp);
    dragHandle.addEventListener("pointercancel", onUp);
  }

  /** 해시로 SVG 노드를 찾는다. CSS.escape 의존 없이 dataset 을 직접 비교한다. */
  function nodeForHash(root, hash) {
    return Array.from(root.querySelectorAll(".node")).find(
      (node) => node.dataset.hash === hash
    );
  }

  /** undo commit 을 허용할 수 있는 현재 local HEAD 브랜치인지 확인한다. */
  function undoableHeadBranch(hash) {
    const branch = Array.from(localBranches.values()).find((item) => item.current);
    return Boolean(
      branch &&
        branch.hash === hash &&
        (branch.ahead > 0 || !branch.upstream || branch.gone)
    );
  }

  /** 특정 커밋에 붙은 로컬 브랜치 목록을 찾는다. */
  function branchesAtHash(hash) {
    return Array.from(localBranches.values()).filter(
      (branch) => branch.hash === hash && !branch.current
    );
  }

  /** 상세 화면의 Delete Branch 버튼을 graph action 메시지로 변환한다. */
  function deleteBranchMessage(hash) {
    const branches = branchesAtHash(hash);
    return branches.length === 1
      ? { type: "deleteBranch", branch: branches[0].name, kind: "local" }
      : { type: "deleteBranch" };
  }

  window.GscGraphFeatures = {
    attachNodeDrag,
    bindCommitActions,
    branchColor,
    commitActions,
    initSearch,
    nodeClass,
    refBadge,
    rowColor,
    setLocalBranches,
    updateSearchIndex,
  };
})();
