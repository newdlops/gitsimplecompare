// 그래프 rebase detail 에서 파일 변경을 다른 커밋으로 옮기는 UI 보조 모듈.
// - 실제 git 적용은 extension host 의 rebase todo exec 가 담당하고, 여기서는 계획 상태만 수정한다.
(function () {
  "use strict";
  const dirtyHashes = new Set();

  window.addEventListener("message", (event) => {
    if (["graphRebasePlan", "graphRebasePaused", "graphRebaseOperation", "graphRebaseClear"].includes(event.data?.type)) {
      dirtyHashes.clear();
    }
  });

  /** 파일 row 에 들어갈 target commit 선택 UI 를 만든다. */
  function moveSelectHtml(item, file, esc) {
    const items = window.GscGraphRebaseContext?.items?.() || [];
    if (!items.some((target) => target.hash !== item.hash && target.action !== "drop")) {
      return "";
    }
    const selected = moveForFile(item, file.path)?.targetHash || "";
    const selectedItem = selected ? window.GscGraphRebaseContext.itemForHash(selected) : null;
    const tooltip = "Move this file change to another commit in this rebase plan";
    const options = [
      `<option value="">Keep here</option>`,
      selectedItem ? `<option value="${esc(selected)}" selected>${esc(targetLabel(selectedItem))}</option>` : "",
    ].join("");
    return `<select class="file-move-target" data-move-file="1" ` +
      `data-source-old-path="${esc(file.oldPath || "")}" title="${esc(tooltip)}" ` +
      `aria-label="${esc(tooltip)}" data-tooltip="${esc(tooltip)}">${options}</select>`;
  }

  /** detail section 안의 파일 이동 select 이벤트를 연결한다. */
  function bind(section, sourceHash) {
    section.addEventListener("focusin", prepareTargets);
    // native select는 pointerdown 직후 열리므로 click보다 먼저 선택지를 채운다.
    section.addEventListener("pointerdown", prepareTargets);
    section.addEventListener("change", (event) => {
        const select = event.target.closest("[data-move-file]");
        if (!select) return;
        const row = select.closest(".file-row");
        updateFileMove(
          sourceHash,
          row?.dataset.path || "",
          select.dataset.sourceOldPath || "",
          select.value || ""
        );
    });
  }

  /** 현재 상자를 열 때만 전체 대상 커밋을 만든다. 가상 행마다 커밋 수만큼 option을 복제하지 않는다. */
  function prepareTargets(event) {
    const select = event.target.closest("[data-move-file]");
    if (!select) return;
    const sourceHash = select.closest("[data-rebase-hash]")?.dataset.rebaseHash;
    const context = window.GscGraphRebaseContext;
    const source = context.itemForHash(sourceHash);
    const targets = context.items().filter((target) => target.hash !== source?.hash && target.action !== "drop");
    const key = targets.map((target) => target.hash).join(",");
    if (select.dataset.targets === key) return;
    const selected = select.value;
    const fragment = document.createDocumentFragment();
    fragment.appendChild(new Option("Keep here", ""));
    for (const target of targets) fragment.appendChild(new Option(targetLabel(target), target.hash));
    select.replaceChildren(fragment);
    select.value = selected;
    select.dataset.targets = key;
  }

  /** 원래 rebase 순서와 해시/제목으로 대상을 표시해 필터·재정렬 뒤에도 커밋을 식별하게 한다. */
  function targetLabel(target) {
    return `#${target.originalOrder + 1} ${shortHash(target.hash)} ${target.subject || ""}`.trim();
  }

  /** rebase continue 때 이번 작업 중 실제로 변경된 source/target 해시를 반환한다. */
  function changedHashes() {
    return Array.from(dirtyHashes);
  }

  /** source item 의 파일 이동 계획을 추가/변경/삭제한다. */
  function updateFileMove(sourceHash, sourcePath, sourceOldPath, targetHash) {
    const item = window.GscGraphRebaseContext?.itemForHash?.(sourceHash);
    if (!item || !sourcePath) {
      return;
    }
    const moves = (item.fileMoves || []).filter((move) => move.sourcePath !== sourcePath);
    const previous = moveForFile(item, sourcePath)?.targetHash;
    if (previous) dirtyHashes.add(previous);
    if (targetHash && targetHash !== sourceHash) {
      moves.push({
        sourceHash,
        sourcePath,
        sourceOldPath: sourceOldPath || undefined,
        targetHash,
      });
      dirtyHashes.add(targetHash);
    }
    item.fileMoves = moves;
    dirtyHashes.add(sourceHash);
    window.GscGraphRebaseContext?.render?.();
  }

  /** 파일 row 의 현재 이동 계획을 찾는다. */
  function moveForFile(item, path) {
    return (item.fileMoves || []).find((move) => move.sourcePath === path);
  }

  /** UI 표시용 축약 해시를 만든다. */
  function shortHash(hash) {
    return String(hash || "").slice(0, 7);
  }

  window.GscGraphRebaseMoves = { bind, changedHashes, moveSelectHtml };
})();
