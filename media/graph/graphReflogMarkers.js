// 그래프 reflog 노드 보조 형상 렌더러.
// - reflog 로 연결된 commit circle 주변에 diamond marker 를 덧그려 일반 노드와 구분한다.
(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  /** reflog hash 의 앞뒤 공백을 제거한다. */
  function cleanHash(hash) {
    return String(hash || "").trim();
  }

  /**
   * commit circle 주변에 reflog 전용 diamond shape 를 추가한다.
   * @param node  기준이 되는 SVG commit circle
   * @param hash  reflog 항목 commit hash
   * @param title hover tooltip 으로 보여줄 reflog 설명
   * @param flow  브랜치 흐름과의 관계(flow/dropped/timeline)
   */
  function appendNodeShape(node, hash, title, flow) {
    if (!node) {
      return;
    }
    const svg = node.closest("svg");
    const cx = Number(node.getAttribute("cx"));
    const cy = Number(node.getAttribute("cy"));
    const radius = Number(node.getAttribute("r") || 6) + 5;
    if (!svg || Number.isNaN(cx) || Number.isNaN(cy)) {
      return;
    }
    const kind = flow === "dropped" || flow === "timeline" ? flow : "flow";
    const shape = kind === "timeline"
      ? timelineShape(cx, cy, radius)
      : diamondShape(cx, cy, radius);
    shape.setAttribute("class", `reflog-node-shape reflog-node-shape-${kind}`);
    shape.setAttribute("data-hash", cleanHash(hash));
    const nodeTitle = document.createElementNS(SVG_NS, "title");
    nodeTitle.textContent = title || "Reflog entry";
    shape.appendChild(nodeTitle);
    svg.appendChild(shape);
  }

  /** 브랜치 흐름에 붙어 있는 reflog commit 을 감싸는 다이아몬드 형상을 만든다. */
  function diamondShape(cx, cy, radius) {
    const shape = document.createElementNS(SVG_NS, "polygon");
    shape.setAttribute("points", `${cx},${cy - radius} ${cx + radius},${cy} ${cx},${cy + radius} ${cx - radius},${cy}`);
    return shape;
  }

  /** 시간순 reflog 지점임을 나타내는 사각 링 형상을 만든다. */
  function timelineShape(cx, cy, radius) {
    const size = radius * 1.5;
    const shape = document.createElementNS(SVG_NS, "rect");
    shape.setAttribute("x", String(cx - size / 2));
    shape.setAttribute("y", String(cy - size / 2));
    shape.setAttribute("width", String(size));
    shape.setAttribute("height", String(size));
    shape.setAttribute("rx", "1.5");
    return shape;
  }

  window.GscGraphReflogMarkers = { appendNodeShape };
})();
