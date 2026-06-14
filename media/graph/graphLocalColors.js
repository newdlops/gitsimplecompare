// local-only 그래프 노드의 브랜치 색상 전파.
// - localOnlyBranches 배열의 첫 값에 의존하지 않고, ref 가 붙은 branch tip 에서 부모 방향 edge 로 색상을 내려보낸다.
(function () {
  "use strict";

  /** local-only row 색상 resolver 를 만든다. */
  function makeResolver(rows, edges) {
    const byHash = new Map();
    const edgesByFrom = new Map();
    const pendingByHash = new Map();
    const pendingBySlot = new Map();
    const branchByHash = new Map();
    const colorByHash = new Map();
    rows.forEach((row, index) => byHash.set(row.hash, { row, index }));
    (edges || []).forEach((edge) => {
      const list = edgesByFrom.get(edge.fromRow) || [];
      list.push(edge);
      edgesByFrom.set(edge.fromRow, list);
    });

    rows.forEach((row, index) => {
      const branch =
        directBranch(row) ||
        pendingBySlot.get(slotKey(row.hash, row.column)) ||
        pendingByHash.get(row.hash) ||
        fallbackBranch(row);
      if (!branch) {
        return;
      }
      branchByHash.set(row.hash, branch);
      colorByHash.set(row.hash, branchColor(branch, row.color));
      propagateBranch(rows, edgesByFrom.get(index) || [], branch, pendingByHash, pendingBySlot);
    });

    return {
      branchForRow: (row) => branchByHash.get(row.hash) || "",
      colorForRow: (row) => colorByHash.get(row.hash) || "",
    };
  }

  /** row 에 붙은 실제 branch ref 가 local-only 브랜치 목록에 있으면 그 브랜치를 우선한다. */
  function directBranch(row) {
    const branches = localOnlyBranches(row);
    if (!branches.length) {
      return "";
    }
    const refs = new Set(row.refs || []);
    return branches.find((branch) => refs.has(branch)) || "";
  }

  /** edge 를 따라 부모 row 의 같은 lane slot 으로 브랜치 색상 기준을 전파한다. */
  function propagateBranch(rows, edges, branch, pendingByHash, pendingBySlot) {
    edges.forEach((edge) => {
      const parent = rows[edge.toRow];
      if (!parent || !localOnlyBranches(parent).includes(branch)) {
        return;
      }
      pendingByHash.set(parent.hash, branch);
      pendingBySlot.set(slotKey(parent.hash, edge.toColumn), branch);
    });
  }

  /** 명확한 ref/edge 전파가 없을 때만 단일 브랜치 목록을 fallback 으로 쓴다. */
  function fallbackBranch(row) {
    const branches = localOnlyBranches(row);
    return branches.length === 1 ? branches[0] : "";
  }

  /** row 의 local-only 브랜치명 목록을 반환한다. */
  function localOnlyBranches(row) {
    return (row.localOnlyBranches || []).filter(Boolean);
  }

  /** 같은 커밋이라도 lane 이 다르면 다른 전파 후보를 가질 수 있게 key 를 만든다. */
  function slotKey(hash, column) {
    return `${hash}:${column}`;
  }

  /** 브랜치 chip 과 동일한 색상 resolver 를 사용한다. */
  function branchColor(branch, baseIndex) {
    return (
      window.GscGraphFeatures?.branchColor?.(branch, baseIndex) ||
      window.GscGraphColors?.branchColor?.(branch, baseIndex) ||
      window.GscGraphColors?.colorOf?.(baseIndex) ||
      "#abb2bf"
    );
  }

  window.GscGraphLocalColors = {
    makeResolver,
  };
})();
