// compact graph 의 접힌 lane 표시를 담당하는 렌더 보조 모듈.
// - 색상만으로 구분하기 어려운 접힌 branch lane 에 dash/stack marker 를 추가한다.
(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  /** SVG 요소를 생성하고 속성을 적용한다. */
  function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    for (const key in attrs) {
      el.setAttribute(key, attrs[key]);
    }
    return el;
  }

  /** compact edge 여부에 따라 path 속성을 만든다. */
  function edgeAttrs(edge) {
    if (!edge?.compacted) {
      return {
        "stroke-width": "1.5",
        class: "edge",
      };
    }
    return {
      "stroke-width": "2",
      "stroke-dasharray": compactDash(edge),
      "stroke-linecap": "round",
      class: "compact-edge",
    };
  }

  /** 원래 lane 번호를 dash 패턴에 반영해 색상 외 구분점을 만든다. */
  function compactDash(edge) {
    const seed = Math.abs(edge.originalColumn == null ? edge.column : edge.originalColumn) % 3;
    return seed === 0 ? "2 4" : seed === 1 ? "5 3" : "1 3";
  }

  /** compact lane 으로 접힌 node 옆에 작은 stack marker 를 그린다. */
  function nodeMarker(options) {
    const row = options?.row;
    if (!row?.compacted) {
      return undefined;
    }
    const x = options.x + options.radius + 3;
    const y = options.y;
    const marker = svgEl("g", {
      class: "compact-node-marker",
      "data-original-column": String(row.originalColumn ?? row.column),
    });
    [-3, 0, 3].forEach((dy, index) => appendMarkerLine(marker, {
      x: x + index,
      y: y + dy,
      color: options.color,
    }));
    return marker;
  }

  /** stack marker 의 외곽선/색상선을 한 쌍으로 추가한다. */
  function appendMarkerLine(marker, options) {
    marker.appendChild(svgEl("line", {
      x1: options.x,
      y1: options.y,
      x2: options.x + 5,
      y2: options.y,
      stroke: "var(--vscode-editor-background)",
      "stroke-width": "2.8",
      "stroke-linecap": "round",
    }));
    marker.appendChild(svgEl("line", {
      x1: options.x,
      y1: options.y,
      x2: options.x + 5,
      y2: options.y,
      stroke: options.color,
      "stroke-width": "1.2",
      "stroke-linecap": "round",
    }));
  }

  /** row tooltip 에 compact lane 정보를 덧붙인다. */
  function titlePart(row) {
    return row?.compacted
      ? `compact lane: original lane ${(row.originalColumn ?? row.column) + 1}`
      : "";
  }

  window.GscGraphCompactRender = {
    edgeAttrs,
    nodeMarker,
    titlePart,
  };
})();
