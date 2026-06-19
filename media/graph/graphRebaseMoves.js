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
    const targets = items.filter((target) => target.hash !== item.hash && target.action !== "drop");
    if (targets.length === 0) {
      return "";
    }
    const selected = moveForFile(item, file.path)?.targetHash || "";
    const tooltip = "Move this file change to another commit in this rebase plan";
    const options = [
      `<option value="">Keep here</option>`,
      ...targets.map((target, index) => {
        const label = `#${index + 1} ${shortHash(target.hash)} ${target.subject || ""}`.trim();
        return `<option value="${esc(target.hash)}"${target.hash === selected ? " selected" : ""}>${esc(label)}</option>`;
      }),
    ].join("");
    return `<select class="file-move-target" data-move-file="1" ` +
      `data-source-old-path="${esc(file.oldPath || "")}" title="${esc(tooltip)}" ` +
      `aria-label="${esc(tooltip)}" data-tooltip="${esc(tooltip)}">${options}</select>`;
  }

  /** detail section 안의 파일 이동 select 이벤트를 연결한다. */
  function bind(section, sourceHash, refresh) {
    section.querySelectorAll("[data-move-file]").forEach((select) => {
      select.addEventListener("change", () => {
        const row = select.closest(".file-row");
        updateFileMove(
          sourceHash,
          row?.dataset.path || "",
          select.dataset.sourceOldPath || "",
          select.value || ""
        );
        refresh();
      });
    });
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
