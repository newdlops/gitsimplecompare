// git graph 웹뷰의 보조 UI 스크립트.
// - 로컬 브랜치 ref 배지 상태와 노드 드래그 기반 이벤트를 graph.js 와 분리해 파일 크기를 제한한다.
(function () {
  "use strict";

  const references = window.GscGraphReferenceState();

  /** HTML 특수문자를 이스케이프해 안전하게 삽입한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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
    return Boolean(branch && !branch.detailsPending && (branch.ahead > 0 || !branch.upstream || branch.gone));
  }

  /** 브랜치 이름에 대해 현재 그래프 세션에서 고정된 색상을 반환한다. */
  function branchColor(name, baseIndex) {
    return (
      references.colors.get(name) ||
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
      isSplitLocalBranch(references.branches.get(ref))
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
    const current = branches.find((branch) => references.branches.get(branch)?.current);
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

  /** ref 문자열이 원격 tag 내부 표기인지 확인한다. */
  function isRemoteTagRef(ref) {
    return ref.indexOf("remote-tag:") === 0;
  }

  /** 원격 tag 내부 표기에서 remote/name 을 분리한다. */
  function remoteTagInfo(ref) {
    const raw = ref.slice("remote-tag:".length);
    const slash = raw.indexOf("/");
    return slash < 0
      ? { remote: "", name: raw }
      : { remote: raw.slice(0, slash), name: raw.slice(slash + 1) };
  }

  /** row 에 실제 로컬 ref 와 원격 전용 tag ref 를 합쳐 표시용 ref 목록을 만든다. */
  function displayRefs(row) {
    const refs = [...(row.refs || [])];
    const seen = new Set(refs);
    (references.remoteTags.get(row.hash) || []).forEach((tag) => {
      const ref = `remote-tag:${tag.remote}/${tag.name}`;
      if (!seen.has(ref)) {
        refs.push(ref);
        seen.add(ref);
      }
    });
    return refs;
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
    if (branch.detailsPending) return [...parts, branch.pendingMessage].filter(Boolean).join(" | ");
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
      const status = references.tags.get(name);
      const title = localTagTitle(name, status);
      return `<span class="${localTagClass(status)}" role="button" tabindex="0" data-tag-name="${safeEsc(
        name
      )}" data-tag-local="1" data-tag-hash="${safeEsc(
        status?.localHash || ""
      )}" data-tooltip="${safeEsc(title)}" title="${safeEsc(title)}" aria-label="${safeEsc(title)}">` +
        `<span class="codicon codicon-tag ref-icon" aria-hidden="true"></span>` +
        `<span class="ref-label">${safeEsc(name)}</span></span>`;
    }
    if (isRemoteTagRef(ref)) {
      const info = remoteTagInfo(ref);
      const target = (references.tags.get(info.name)?.remoteTargets || []).find(
        (item) => item.remote === info.remote
      );
      const title = `Remote tag ${info.remote}/${info.name}`;
      return `<span class="ref tag tag-remote" role="button" tabindex="0" data-tag-name="${safeEsc(
        info.name
      )}" data-tag-remote="${safeEsc(info.remote)}" data-tag-hash="${safeEsc(
        target?.hash || ""
      )}" data-tooltip="${safeEsc(title)}" title="${safeEsc(title)}" aria-label="${safeEsc(title)}">` +
        `<span class="codicon codicon-cloud ref-icon" aria-hidden="true"></span>` +
        `<span class="ref-label">${safeEsc(info.remote)}/${safeEsc(info.name)}</span></span>`;
    }
    if (isVirtualRef(ref)) {
      return virtualBadge(ref, safeEsc);
    }
    const branch = references.branches.get(ref);
    if (branch) {
      const attrs = branch.current
        ? ` role="button" tabindex="0" data-branch-name="${safeEsc(branch.name)}" data-branch-kind="local" aria-label="${safeEsc(
            `Branch actions for ${branch.name}`
          )}"`
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

  /** 로컬 tag 상태를 CSS class 조합으로 변환한다. */
  function localTagClass(status) {
    if (!status || !status.remoteTargets?.length) return "ref tag tag-local";
    return status.remoteTargets.some((target) => target.hash === status.localHash)
      ? "ref tag tag-synced"
      : "ref tag tag-diverged";
  }

  /** 로컬 tag hover tooltip 내용을 만든다. */
  function localTagTitle(name, status) {
    if (!status || !status.remoteTargets?.length) return `Local tag ${name}`;
    const remotes = status.remoteTargets.map((target) => target.remote).join(", ");
    const pushed = status.remoteTargets.some((target) => target.hash === status.localHash);
    return pushed
      ? `Local and remote tag ${name} | ${remotes}`
      : `Local tag ${name} differs from remote | ${remotes}`;
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
    if (revertableCurrentBranch(detail)) {
      actions.push(actionButton("revert-commit", "debug-reverse-continue", "Revert commit on current branch", "Revert"));
    }
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
    // 시간이 걸리는 액션은 busyId(=버튼 id)를 함께 보내, 확장이 처리하는 동안 해당 버튼에 스피너를 표시하고
    // 완료/취소 시 해제하게 한다. 즉시 끝나는 복사 액션은 스피너를 붙이지 않는다.
    const bindBusy = (id, message) => bind(id, () => Object.assign(message(), { busyId: id }));
    bind("copy-hash-inline", () => ({ type: "copyCommitHash", hash: detail.hash }));
    bind("copy-message-inline", () => ({ type: "copyCommitMessage", message: detail.message }));
    bindBusy("checkout-commit", () => ({ type: "checkoutCommit", hash: detail.hash }));
    bindBusy("create-branch", () => ({ type: "createBranch", hash: detail.hash }));
    bindBusy("create-tag", () => ({ type: "createTag", hash: detail.hash }));
    bindBusy("cherry-pick", () => ({ type: "cherryPick", hash: detail.hash }));
    bindBusy("revert-commit", () => ({
      type: "revertCommit",
      hash: detail.hash,
      parents: detail.parents || [],
    }));
    bindBusy("undo-commit", () => ({ type: "undoCommit", hash: detail.hash }));
    bindBusy("delete-branch", () => deleteBranchMessage(detail.hash));
  }

  /** 현재 checkout 된 로컬 브랜치가 이 커밋을 포함하면 revert 액션을 허용한다. */
  function revertableCurrentBranch(detail) {
    return !detail.loading && (detail.branches || []).some((branch) =>
      branch.current && branch.kind === "local"
    );
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
      refs.some((ref) => references.branches.has(ref)) || localOnly ? "local-node" : "",
      localOnly ? "local-only-node" : "",
      refs.some(isTagRef) ? "tag-node" : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  /** 노드 drag 상태를 custom event 로 흘려보내 후속 기능이 연결될 수 있게 한다. */
  function emitDrag(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  /** Graph 컨테이너에 한 번만 drag를 위임한다. 새 페이지와 교체된 행/노드에 개별 listener를 다시 만들지 않는다. */
  function attachNodeDrag(root) {
    if (!root) {
      return;
    }
    attachBranchCheckout(root);
    attachRefActionMenu(root);
    attachGraphContextMenu(root);
    if (root.dataset.nodeDragBound === "1") return;
    root.dataset.nodeDragBound = "1";
    root.addEventListener("pointerdown", handleGraphDrag);
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

  /** @param event 컨테이너로 전달된 pointerdown @returns 기존 ref/버튼/가상 행을 제외하고 실제 node 또는 row의 drag를 시작한다. */
  function handleGraphDrag(event) {
    const root = event.currentTarget, target = eventTargetElement(event);
    const node = target?.closest?.(".node");
    if (node && root.contains(node)) { startNodeDrag(event, node); return; }
    const row = target?.closest?.(".row:not([data-reflog-virtual])");
    if (!row || !root.contains(row) || target.closest(".ref,button,.rebase-row-actions")) return;
    const rowNode = nodeForHash(root, row.dataset.hash || "");
    if (rowNode) startNodeDrag(event, rowNode, row);
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
      window.GscGraphPostMessage?.({
        type: "tagAction",
        tag,
        target: target.dataset.tagHash || undefined,
        remote: target.dataset.tagRemote || undefined,
      });
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
    const baseTransform = node.getAttribute("transform") || "";
    node.classList.add("dragging-node");
    dragHandle.classList.add("dragging-row");
    dragHandle.setPointerCapture?.(event.pointerId);
    emitDrag("gsc-node-drag-start", { hash, x: startX, y: startY });

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      node.setAttribute("transform", joinSvgTransforms(baseTransform, `translate(${dx} ${dy})`));
      emitDrag("gsc-node-drag", { hash, dx, dy });
    };
    const onUp = (upEvent) => {
      const dx = upEvent.clientX - startX;
      const dy = upEvent.clientY - startY;
      node.classList.remove("dragging-node");
      restoreSvgTransform(node, baseTransform);
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

  /**
   * 기존 SVG transform 과 이번 drag 이동 transform 을 합친다.
   * - rebase preview 로 이미 translate 된 node 를 다시 드래그할 때 기존 위치를 덮어쓰지 않기 위함이다.
   * @param base 기존 transform 속성값
   * @param delta 이번 pointer drag 로 추가할 transform
   */
  function joinSvgTransforms(base, delta) {
    return base ? `${base} ${delta}` : delta;
  }

  /**
   * 드래그 종료 후 node transform 을 시작 시점 값으로 되돌린다.
   * @param node transform 을 복구할 SVG node
   * @param base 시작 시점 transform 속성값
   */
  function restoreSvgTransform(node, base) {
    if (base) {
      node.setAttribute("transform", base);
    } else {
      node.removeAttribute("transform");
    }
  }

  /** 해시로 SVG 노드를 찾는다. Native selector로 pointerdown 때 모든 node의 배열·dataset 읽기를 피한다. */
  function nodeForHash(root, hash) {
    if (window.CSS?.escape) return root.querySelector(`.node[data-hash="${window.CSS.escape(hash)}"]`);
    return Array.from(root.querySelectorAll(".node")).find(
      (node) => node.dataset.hash === hash
    );
  }

  /** undo commit 을 허용할 수 있는 현재 local HEAD 브랜치인지 확인한다. */
  function undoableHeadBranch(hash) {
    const branch = Array.from(references.branches.values()).find((item) => item.current);
    return Boolean(
      branch &&
        !branch.detailsPending &&
        branch.hash === hash &&
        (branch.ahead > 0 || !branch.upstream || branch.gone)
    );
  }

  /** 특정 커밋에 붙은 로컬 브랜치 목록을 찾는다. */
  function branchesAtHash(hash) {
    return Array.from(references.branches.values()).filter(
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
    displayRefs,
    nodeClass,
    refBadge,
    rowColor,
    setLocalBranches: references.setLocalBranches,
    setLocalBranchIdentities: references.setLocalBranchIdentities,
    setTagStatus: references.setTagStatus,
    /** 마지막 브랜치/태그 메시지의 영향 범위를 반환한다. null이면 전체 행을 확인해야 한다. */
    referenceChanges: () => references.changes,
  };
})();
