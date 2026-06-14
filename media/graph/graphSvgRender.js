// git graph 의 SVG edge/node 렌더링 모듈.
// - graph.js 의 상태/이벤트 처리와 실제 SVG drawing 책임을 분리한다.
(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  /** 네임스페이스를 지정해 SVG 요소를 만든다. */
  function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    for (const key in attrs) {
      el.setAttribute(key, attrs[key]);
    }
    return el;
  }

  /** GraphData rows/edges 를 하나의 SVG 요소로 렌더링한다. */
  function render(options) {
    const edgeBranchNames = makeEdgeBranchNames(options.rows, options.edges);
    const highlightModel = window.GscGraphCompactRender?.makeLaneHighlightModel?.(options.edges, edgeBranchNames);
    const svg = svgEl("svg", {
      width: options.graphWidth,
      height: options.bodyHeight,
    });
    svg.__gscLaneHighlightModel = highlightModel;
    for (let edgeIndex = 0; edgeIndex < options.edges.length; edgeIndex++) {
      appendEdge(svg, options.edges[edgeIndex], edgeIndex, edgeBranchNames[edgeIndex], options);
    }
    for (let rowIndex = 0; rowIndex < options.rows.length; rowIndex++) {
      appendNode(svg, options.rows[rowIndex], rowIndex, options);
    }
    window.GscGraphCompactRender?.raiseMarkers?.(svg);
    return svg;
  }

  /** 하나의 edge path 또는 생략된 compact edge 를 SVG 에 추가한다. */
  function appendEdge(svg, edge, edgeIndex, branchName, options) {
    const edgeColor = options.edgeDisplayColor(edge);
    const compactEdge = window.GscGraphCompactRender?.edgeElement?.({
      edge,
      edgeIndex,
      branchName,
      color: edgeColor,
      fromX: options.laneX(edge.fromColumn),
      fromY: options.rowY(edge.fromRow),
      laneX: options.laneX(edge.column),
      toX: options.laneX(edge.toColumn),
      toY: options.rowY(Math.min(edge.toRow, options.rows.length)),
      rowHeight: options.rowHeight,
    });
    if (compactEdge) {
      svg.appendChild(compactEdge);
      return;
    }
    const edgeAttrs = window.GscGraphCompactRender?.edgeAttrs?.(edge, undefined, edgeIndex, branchName) || {
      "stroke-width": "1.5",
    };
    const edgeHitAttrs = window.GscGraphCompactRender?.edgeHitAttrs?.(edge, undefined, edgeIndex, branchName);
    const d = edgePath(edge, options);
    if (edgeHitAttrs) {
      svg.appendChild(svgEl("path", {
        d,
        fill: "none",
        stroke: edgeColor,
        ...edgeHitAttrs,
      }));
    }
    svg.appendChild(svgEl("path", {
      d,
      fill: "none",
      stroke: edgeColor,
      ...edgeAttrs,
    }));
  }

  /** 하나의 commit node 와 필요한 보조 marker 를 SVG 에 추가한다. */
  function appendNode(svg, row, rowIndex, options) {
    const nodeColor = options.rowDisplayColor(row);
    const nodeClass = window.GscGraphFeatures?.nodeClass(row) || "node";
    const localOnly = nodeClass.includes("local-only-node");
    if (localOnly) {
      svg.appendChild(localOnlyRing(row, rowIndex, nodeColor, options));
    }
    const node = svgEl("circle", {
      cx: options.laneX(row.column),
      cy: options.rowY(rowIndex),
      r: options.nodeRadius,
      fill: nodeColor,
      stroke: "var(--vscode-editor-background)",
      "stroke-width": "1",
      class: nodeClass,
      "data-hash": row.hash,
      "data-row": String(rowIndex),
      "data-column": String(row.column),
      "aria-label": options.rowTitle(row),
      style: nodeStyle(nodeColor, localOnly),
    });
    const title = svgEl("title", {});
    title.textContent = options.rowTitle(row);
    node.appendChild(title);
    svg.appendChild(node);
    const marker = window.GscGraphCompactRender?.nodeMarker?.({
      x: options.laneX(row.column),
      y: options.rowY(rowIndex),
      radius: options.nodeRadius,
      row,
      color: nodeColor,
    });
    if (marker) {
      svg.appendChild(marker);
    }
  }

  /** branch tip ref 를 lane edge 로 전파해 hover tooltip 에 쓸 이름을 계산한다. */
  function makeEdgeBranchNames(rows, edges) {
    const names = new Array((edges || []).length).fill("");
    const edgesByFrom = new Map();
    const slotNames = new Map();
    (edges || []).forEach((edge, index) => {
      const list = edgesByFrom.get(edge.fromRow) || [];
      list.push({ edge, index });
      edgesByFrom.set(edge.fromRow, list);
    });
    (rows || []).forEach((row, rowIndex) => {
      const slot = slotKey(rowIndex, row.column);
      const direct = branchNameForRow(row);
      const name = direct || slotNames.get(slot) || "";
      if (direct) {
        slotNames.set(slot, direct);
      }
      (edgesByFrom.get(rowIndex) || []).forEach(({ edge, index }) => {
        if (edge.fromColumn !== edge.column || !name) {
          return;
        }
        names[index] = name;
        if (edge.toRow < rows.length) {
          slotNames.set(slotKey(edge.toRow, edge.toColumn), name);
        }
      });
    });
    (edges || []).forEach((edge, index) => {
      if (names[index]) {
        return;
      }
      const toName = edge.toRow < rows.length
        ? branchNameForRow(rows[edge.toRow]) || slotNames.get(slotKey(edge.toRow, edge.toColumn)) || ""
        : "";
      names[index] = edge.fromColumn !== edge.column
        ? toName
        : slotNames.get(slotKey(edge.fromRow, edge.fromColumn)) || toName;
    });
    return names;
  }

  /** row 에 직접 붙은 branch ref 이름을 tooltip 에 표시할 문자열로 정리한다. */
  function branchNameForRow(row) {
    const refs = branchRefs(row?.refs);
    const localOnly = (row?.localOnlyBranches || []).filter(Boolean);
    const directLocalOnly = localOnly.filter((branch) => refs.includes(branch));
    const localRefs = refs.filter((ref) => !ref.includes("/"));
    const fallback = !refs.length && localOnly.length === 1 ? localOnly[0] : "";
    return directLocalOnly[0] || localRefs[0] || refs[0] || fallback;
  }

  /** HEAD/tag/가상 ref 를 제외하고 실제 branch ref 만 남긴다. */
  function branchRefs(refs) {
    return (refs || []).filter((ref) =>
      ref && ref !== "HEAD" && !ref.startsWith("tag:") && !ref.startsWith("virtual:")
    );
  }

  /** 같은 row 안에서도 lane column 이 다르면 다른 branch 전파 후보로 분리한다. */
  function slotKey(rowIndex, column) {
    return `${rowIndex}:${column}`;
  }

  /** 한 간선의 SVG path d 문자열을 만든다. */
  function edgePath(edge, options) {
    const fx = options.laneX(edge.fromColumn);
    const fy = options.rowY(edge.fromRow);
    const cx = options.laneX(edge.column);
    const toRow = Math.min(edge.toRow, options.rows.length);
    const tx = options.laneX(edge.toColumn);
    const ty = options.rowY(toRow);

    let d = `M ${fx} ${fy} `;
    if (edge.fromColumn !== edge.column) {
      const my = fy + options.rowHeight / 2;
      d += `C ${fx} ${my}, ${cx} ${my}, ${cx} ${fy + options.rowHeight} `;
    }
    const bottom = edge.toColumn !== edge.column ? ty - options.rowHeight : ty;
    d += `L ${cx} ${bottom} `;
    if (edge.toColumn !== edge.column) {
      const my = ty - options.rowHeight / 2;
      d += `C ${cx} ${my}, ${tx} ${my}, ${tx} ${ty} `;
    }
    return d;
  }

  /** local-only 노드 본체 바깥의 브랜치 색 ring 을 만든다. */
  function localOnlyRing(row, rowIndex, color, options) {
    return svgEl("circle", {
      cx: options.laneX(row.column),
      cy: options.rowY(rowIndex),
      r: options.nodeRadius + 1.8,
      fill: "none",
      stroke: color,
      "stroke-width": "1.8",
      class: "local-only-ring",
      style: `--graph-node-color: ${color}; --branch-color: ${color}`,
    });
  }

  /** 노드 색상 CSS 변수를 넣고 local-only 의 inline 우선순위를 보장한다. */
  function nodeStyle(color, localOnly) {
    const vars = `--graph-node-color: ${color}; --branch-color: ${color}`;
    return localOnly
      ? `${vars}; fill: ${color}; stroke: none`
      : vars;
  }

  window.GscGraphSvgRender = { render };
})();
