// git graph 색상 계산 헬퍼.
// - 일반 레인 색과 local-only 브랜치 색을 한 곳에서 계산해 노드/간선/배지가 같은 색을 쓰게 한다.
(function () {
  "use strict";

  const COLORS = ["#e06c75", "#61afef", "#98c379", "#e5c07b", "#c678dd", "#56b6c2", "#d19a66", "#abb2bf"];
  const LOCAL_ONLY_COLORS = ["#ff8a4c", "#4ec9b0", "#b180d7", "#f14c4c", "#3dc9b0", "#d7ba7d", "#9cdcfe", "#ce9178"];

  /** 레인 색상 인덱스를 기본 그래프 팔레트 색으로 변환한다. */
  function colorOf(index) {
    return COLORS[Math.abs(Number(index) || 0) % COLORS.length];
  }

  /** 브랜치 이름을 안정적인 팔레트 인덱스로 바꾼다. */
  function hashText(text) {
    let hash = 0;
    const value = String(text || "local");
    for (let i = 0; i < value.length; i++) {
      hash = (hash * 31 + value.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  /** local-only 커밋을 포함하는 로컬 브랜치명에 맞는 별도 색상을 고른다. */
  function localOnlyColor(branches) {
    const branch = (branches || []).find(Boolean) || "local";
    return LOCAL_ONLY_COLORS[hashText(branch) % LOCAL_ONLY_COLORS.length];
  }

  /** 커밋 row/노드에 표시할 최종 색상을 반환한다. */
  function rowColor(row) {
    return (row.localOnlyBranches || []).length ? localOnlyColor(row.localOnlyBranches) : colorOf(row.color);
  }

  /** 간선 색상을 반환한다. local-only 자식에서 시작한 간선은 로컬 전용 색으로 이어 보인다. */
  function edgeColor(edge, rows) {
    const from = rows?.[edge.fromRow];
    return from && (from.localOnlyBranches || []).length
      ? localOnlyColor(from.localOnlyBranches)
      : colorOf(edge.color);
  }

  window.GscGraphColors = {
    colorOf,
    rowColor,
    edgeColor,
  };
})();
