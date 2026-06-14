// compact graph 의 접힌 lane 표시를 담당하는 렌더 보조 모듈.
// - 색상만으로 구분하기 어려운 접힌 branch lane 에 dash/stack marker 를 추가한다.
(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const MIN_ELIDE_ROWS = 6;
  const STUB_ROWS = 1.35;
  const DASH_PATTERNS = [
    "2 4", "7 2", "1 3", "9 3 2 3", "4 2 1 2", "12 3",
    "3 5", "6 2 2 2", "1 5", "10 2 1 2", "5 1", "2 2 8 2",
    "8 4", "3 1 1 3", "11 2", "1 2 4 2",
  ];
  const STROKE_WIDTHS = [
    "2", "1.65", "2.35", "1.85", "2.15", "1.75", "2.45", "1.95",
    "2.2", "1.7", "2.55", "1.9", "2.3", "1.8", "2.05", "2.4",
  ];

  /** SVG 요소를 생성하고 속성을 적용한다. */
  function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    for (const key in attrs) {
      el.setAttribute(key, attrs[key]);
    }
    return el;
  }

  /** compact edge 여부에 따라 path 속성을 만든다. */
  function edgeAttrs(edge, branchKey, edgeIndex, branchName) {
    const common = {
      class: "edge lane-hover-target",
      "data-lane-key": branchKey || laneKey(edge),
      "data-edge-index": String(edgeIndex ?? ""),
      "data-lane-from-row": String(edge.fromRow),
      "data-lane-to-row": String(edge.toRow),
      ...branchTooltipAttrs(branchName),
    };
    if (!edge?.compacted) {
      return {
        ...common,
        "stroke-width": "1.5",
      };
    }
    const variant = laneVariant(edge);
    return {
      ...common,
      "stroke-width": STROKE_WIDTHS[variant],
      "stroke-dasharray": DASH_PATTERNS[variant],
      "stroke-dashoffset": String(variant),
      "stroke-linecap": "round",
      class: "compact-edge lane-hover-target",
      "data-lane-variant": String(variant),
    };
  }

  /** 얇은 시각 lane 위에 넓은 투명 hit path 를 깔기 위한 속성을 만든다. */
  function edgeHitAttrs(edge, branchKey, edgeIndex, branchName) {
    return {
      class: "lane-hover-hit lane-hover-target",
      "data-lane-key": branchKey || laneKey(edge),
      "data-edge-index": String(edgeIndex ?? ""),
      "data-lane-from-row": String(edge.fromRow),
      "data-lane-to-row": String(edge.toRow),
      ...branchTooltipAttrs(branchName),
      "stroke-width": "10",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    };
  }

  /** 긴 compact edge 는 중간 세로 구간을 생략하고 양끝 연결 marker 로 대체한다. */
  function edgeElement(options) {
    const edge = options?.edge;
    if (!edge?.compacted || !shouldElide(options)) {
      return undefined;
    }
    const y = edgeY(options);
    const topEnd = markerRowY(y.start + options.rowHeight * STUB_ROWS, options.rowHeight);
    const bottomStart = markerRowY(y.end - options.rowHeight * STUB_ROWS, options.rowHeight);
    const pair = markerPairId(edge);
    const group = svgEl("g", {
      class: "compact-edge-elided",
      "data-original-column": String(edge.originalColumn ?? edge.column),
      "data-compact-pair": pair,
      "data-lane-key": options.branchKey || laneKey(edge),
      "data-edge-index": String(options.edgeIndex ?? ""),
    });
    const attrs = edgeAttrs(edge, options.branchKey, options.edgeIndex, options.branchName);
    appendPath(group, topStubPath(options, y, topEnd), options.color, attrs);
    appendPath(group, bottomStubPath(options, y, bottomStart), options.color, attrs);
    group.appendChild(continuationMarker({
      x: options.laneX,
      y: topEnd,
      direction: "down",
      color: options.color,
      edge,
      markerId: `${pair}-top`,
      pair,
      targetId: `${pair}-bottom`,
      targetY: bottomStart,
    }));
    group.appendChild(continuationMarker({
      x: options.laneX,
      y: bottomStart,
      direction: "up",
      color: options.color,
      edge,
      markerId: `${pair}-bottom`,
      pair,
      targetId: `${pair}-top`,
      targetY: topEnd,
    }));
    return group;
  }

  /** 모든 lane/path 렌더링 이후 marker 를 SVG 최상단으로 올려 marker 위로 선이 지나가지 않게 한다. */
  function raiseMarkers(svg) {
    if (!svg) {
      return;
    }
    Array.from(svg.querySelectorAll(".compact-continuation")).forEach((marker) => {
      svg.appendChild(marker);
    });
  }

  /** edge 를 생략할 만큼 길고 compact lane 에 있는지 판단한다. */
  function shouldElide(options) {
    const y = edgeY(options);
    return y.end - y.start > options.rowHeight * MIN_ELIDE_ROWS;
  }

  /** edge 의 실제 세로 lane 시작/종료 y 좌표를 계산한다. */
  function edgeY(options) {
    const edge = options.edge;
    return {
      start: edge.fromColumn !== edge.column
        ? options.fromY + options.rowHeight
        : options.fromY,
      end: edge.toColumn !== edge.column
        ? options.toY - options.rowHeight
        : options.toY,
    };
  }

  /** 자식 node 에서 생략 시작 marker 까지의 위쪽 stub path 를 만든다. */
  function topStubPath(options, y, topEnd) {
    const edge = options.edge;
    let d = `M ${options.fromX} ${options.fromY} `;
    if (edge.fromColumn !== edge.column) {
      const my = options.fromY + options.rowHeight / 2;
      d += `C ${options.fromX} ${my}, ${options.laneX} ${my}, ${options.laneX} ${y.start} `;
    }
    return d + `L ${options.laneX} ${topEnd} `;
  }

  /** 생략 종료 marker 에서 부모 node 까지의 아래쪽 stub path 를 만든다. */
  function bottomStubPath(options, y, bottomStart) {
    const edge = options.edge;
    let d = `M ${options.laneX} ${bottomStart} L ${options.laneX} ${y.end} `;
    if (edge.toColumn !== edge.column) {
      const my = options.toY - options.rowHeight / 2;
      d += `C ${options.laneX} ${my}, ${options.toX} ${my}, ${options.toX} ${options.toY} `;
    }
    return d;
  }

  /** edge path 를 공통 속성으로 추가한다. */
  function appendPath(group, d, color, attrs) {
    group.appendChild(svgEl("path", {
      d,
      fill: "none",
      stroke: color,
      ...edgeHitAttrsFrom(attrs),
    }));
    group.appendChild(svgEl("path", {
      d,
      fill: "none",
      stroke: color,
      ...attrs,
    }));
  }

  /** 이미 계산한 edge 속성에서 투명 hit path 에 필요한 속성만 복사한다. */
  function edgeHitAttrsFrom(attrs) {
    return {
      class: "lane-hover-hit lane-hover-target",
      "data-lane-key": attrs["data-lane-key"],
      "data-edge-index": attrs["data-edge-index"],
      "data-lane-from-row": attrs["data-lane-from-row"],
      "data-lane-to-row": attrs["data-lane-to-row"],
      ...copyTooltipAttrs(attrs),
      "stroke-width": "10",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    };
  }

  /** 생략된 lane 이 반대편에서 이어진다는 클릭 가능한 marker 를 만든다. */
  function continuationMarker(options) {
    const label = laneLabel(options.edge);
    const width = Math.max(28, 14 + label.length * 7);
    const markerX = options.x;
    const variant = laneVariant(options.edge);
    const marker = svgEl("g", {
      class: `compact-continuation compact-continuation-${options.direction} compact-variant-${variant}`,
      role: "button",
      tabindex: "0",
      "aria-label": `Jump to the other side of compact lane ${label}`,
      "data-compact-marker-id": options.markerId,
      "data-compact-target-id": options.targetId,
      "data-compact-jump-y": String(options.targetY),
      "data-compact-pair": options.pair,
      "data-original-column": String(options.edge.originalColumn ?? options.edge.column),
    });
    const title = svgEl("title", {});
    title.textContent = `Jump to opposite marker for compact lane ${label}`;
    marker.appendChild(title);
    marker.appendChild(svgEl("rect", {
      class: "compact-continuation-hit",
      x: markerX - width / 2,
      y: options.y - 9,
      width,
      height: 18,
      rx: 4,
      fill: "transparent",
    }));
    marker.appendChild(svgEl("rect", {
      class: "compact-continuation-mask",
      x: markerX - width / 2 - 5,
      y: options.y - 9,
      width: width + 10,
      height: 18,
      rx: 6,
      fill: "var(--vscode-editor-background)",
    }));
    marker.appendChild(svgEl("rect", {
      class: "compact-continuation-pill",
      x: markerX - width / 2,
      y: options.y - 7,
      width,
      height: 14,
      rx: 4,
      fill: "var(--vscode-editorWidget-background, var(--vscode-editor-background))",
      stroke: options.color,
      "stroke-width": "1.4",
    }));
    const text = svgEl("text", {
      class: "compact-continuation-label",
      x: markerX,
      y: options.y + 3,
      "text-anchor": "middle",
      fill: "var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground))",
      "font-size": "9",
      "font-family": "var(--vscode-font-family)",
    });
    text.textContent = label;
    marker.appendChild(text);
    return marker;
  }

  /** marker 가 node 중심 row 에 놓이지 않도록 가장 가까운 row 사이 경계로 보정한다. */
  function markerRowY(rawY, rowHeight) {
    return Math.round(rawY / rowHeight) * rowHeight;
  }
  /** lane tooltip 에 표시할 브랜치명을 SVG data 속성으로 만든다. */
  function branchTooltipAttrs(branchName) {
    if (!branchName) {
      return {};
    }
    const prefix = branchName.includes(",") ? "Branches" : "Branch";
    const text = `${prefix}: ${branchName}`;
    return {
      "data-tooltip": text,
      "aria-label": text,
    };
  }

  /** 이미 만든 edge attrs 에서 tooltip 관련 속성만 값이 있을 때 복사한다. */
  function copyTooltipAttrs(attrs) {
    return attrs["data-tooltip"]
      ? { "data-tooltip": attrs["data-tooltip"], "aria-label": attrs["aria-label"] }
      : {};
  }

  /** compact lane 의 시각 변형 인덱스를 원래 lane 기준으로 계산한다. */
  function laneVariant(edge) {
    return Math.abs(edge.originalColumn == null ? edge.column : edge.originalColumn) % DASH_PATTERNS.length;
  }

  /** marker 에 표시할 원래 lane 라벨을 만든다. */
  function laneLabel(edge) {
    return `L${(edge.originalColumn ?? edge.column) + 1}`;
  }

  /** lane hover/pin 이 같은 branch lane 만 묶도록 안정적인 key 를 만든다. */
  function laneKey(edge) {
    return [
      edge.originalColumn ?? edge.column,
      edge.color ?? "x",
    ].join(":");
  }

  /** 클릭한 edge 에서 시간 순방향으로만 하이라이트할 수 있도록 탐색 모델을 만든다. */
  function makeLaneHighlightModel(edges, branchNames) {
    const list = edges || [];
    const fingerprints = list.map((edge, index) => branchNames?.[index] || String(edge.color ?? "x"));
    const futureByRow = new Map();
    const pastByRow = new Map();
    list.forEach((edge, index) => {
      addRowBucket(futureByRow, rowKey(fingerprints[index], edge.toRow), index);
      addRowBucket(pastByRow, rowKey(fingerprints[index], edge.fromRow), index);
    });
    return { edges: list, fingerprints, futureByRow, pastByRow };
  }

  /** 클릭 edge 를 기준으로 branch 시작점부터 시간 순방향 합류점까지 같은 branch edge 를 수집한다. */
  function collectBranchRange(model, startIndex) {
    const edgeIndexes = new Set();
    const rows = new Set();
    collectForwardBranch(model, startIndex, edgeIndexes, rows);
    collectBackwardBranch(model, startIndex, edgeIndexes, rows);
    return { edgeIndexes, rows };
  }

  /** 클릭 edge 부터 부모→자식 방향으로 같은 branch edge 를 수집한다. */
  function collectForwardBranch(model, startIndex, edgeIndexes, rows) {
    const stack = [startIndex];
    while (stack.length) {
      const index = stack.pop();
      const edge = model?.edges?.[index];
      if (!edge || edgeIndexes.has(index)) {
        continue;
      }
      edgeIndexes.add(index);
      rows.add(edge.fromRow);
      rows.add(edge.toRow);
      if (edge.fromColumn !== edge.column) {
        continue;
      }
      const nextIndexes = model.futureByRow.get(rowKey(model.fingerprints[index], edge.fromRow)) || [];
      nextIndexes.forEach((next) => {
        if (!edgeIndexes.has(next)) {
          stack.push(next);
        }
      });
    }
  }

  /** 클릭 edge 부터 branch 시작점까지 자식→부모 방향으로 같은 branch edge 를 수집한다. */
  function collectBackwardBranch(model, startIndex, edgeIndexes, rows) {
    const stack = [startIndex];
    const visited = new Set();
    while (stack.length) {
      const index = stack.pop();
      const edge = model?.edges?.[index];
      if (!edge || visited.has(index)) {
        continue;
      }
      visited.add(index);
      edgeIndexes.add(index);
      rows.add(edge.fromRow);
      rows.add(edge.toRow);
      if (edge.toColumn !== edge.column) {
        continue;
      }
      const nextIndexes = model.pastByRow.get(rowKey(model.fingerprints[index], edge.toRow)) || [];
      nextIndexes.forEach((next) => {
        if (!visited.has(next)) {
          stack.push(next);
        }
      });
    }
  }

  /** Map 안의 row bucket 에 edge index 를 추가한다. */
  function addRowBucket(map, key, index) {
    (map.get(key) || map.set(key, []).get(key)).push(index);
  }

  /** row 기준 edge bucket key 를 만든다. */
  function rowKey(fingerprint, row) {
    return `${fingerprint}@${row}`;
  }

  /** 하나의 생략 edge 양끝 marker 를 묶는 안정적인 id 를 만든다. */
  function markerPairId(edge) {
    return [
      "compact",
      edge.originalColumn ?? edge.column,
      edge.fromRow,
      edge.toRow,
      edge.originalFromColumn ?? edge.fromColumn,
      edge.originalToColumn ?? edge.toColumn,
    ].join("-");
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

  /** graph 영역에 compact continuation marker 클릭/키보드 점프를 연결한다. */
  function bindNavigation(graphEl, root) {
    if (!graphEl || !root || root.dataset.compactNavigationBound === "1") {
      return;
    }
    root.dataset.compactNavigationBound = "1";
    root.addEventListener("click", (event) => handleJumpEvent(event, graphEl, root), true);
    root.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        handleJumpEvent(event, graphEl, root);
      }
    }, true);
  }

  /** lane path hover/click 에 따라 연결 node 강조와 고정 토글을 연결한다. */
  function bindLaneHighlight(root) {
    if (!root || root.dataset.laneHighlightBound === "1") {
      return;
    }
    root.dataset.laneHighlightBound = "1";
    root.addEventListener("mouseover", (event) => {
      const target = laneEventTarget(event);
      if (target) {
        setLaneHighlight(root, target, "hover");
      }
    }, true);
    root.addEventListener("mouseout", (event) => {
      const target = laneEventTarget(event);
      const next = event.relatedTarget?.closest?.(".lane-hover-target[data-edge-index]");
      if (!target || next?.dataset.edgeIndex === target.dataset.edgeIndex) {
        return;
      }
      clearLaneHighlight(root, "hover");
    }, true);
    root.addEventListener("click", (event) => {
      const target = laneEventTarget(event);
      if (!target) {
        return;
      }
      event.stopPropagation();
      togglePinnedLane(root, target);
    }, true);
  }

  /** lane hover/click 을 받을 실제 SVG path 를 찾는다. */
  function laneEventTarget(event) {
    return event.target.closest?.(".lane-hover-target[data-edge-index]");
  }

  /** 클릭한 lane key 를 고정하거나 이미 고정된 lane 이면 해제한다. */
  function togglePinnedLane(root, target) {
    const edgeIndex = target.dataset.edgeIndex || "";
    const current = root.dataset.pinnedEdgeIndex || "";
    clearLaneHighlight(root, "pinned");
    if (current === edgeIndex) {
      root.dataset.pinnedEdgeIndex = "";
      return;
    }
    root.dataset.pinnedEdgeIndex = edgeIndex;
    setLaneHighlight(root, target, "pinned");
  }

  /** 지정 lane key 와 연결된 path/node 에 강조 클래스를 부여한다. */
  function setLaneHighlight(root, target, mode) {
    const svg = target.ownerSVGElement;
    const model = svg?.__gscLaneHighlightModel;
    const startIndex = Number(target.dataset.edgeIndex);
    if (!model || !Number.isFinite(startIndex)) {
      return;
    }
    clearLaneHighlight(root, mode);
    const edgeClass = mode === "pinned" ? "lane-edge-pinned" : "lane-edge-highlight";
    const nodeClass = mode === "pinned" ? "lane-node-pinned" : "lane-node-highlight";
    const branchRange = collectBranchRange(model, startIndex);
    branchRange.edgeIndexes.forEach((edgeIndex) => {
      root.querySelectorAll(`.lane-hover-target[data-edge-index="${edgeIndex}"]`).forEach((item) => {
        item.classList.add(edgeClass);
      });
    });
    branchRange.rows.forEach((row) => {
      root.querySelectorAll(`.node[data-row="${row}"]`).forEach((node) => {
        node.classList.add(nodeClass);
      });
    });
  }

  /** hover/pin 모드별 lane 강조 클래스를 제거한다. */
  function clearLaneHighlight(root, mode) {
    const edgeClass = mode === "pinned" ? "lane-edge-pinned" : "lane-edge-highlight";
    const nodeClass = mode === "pinned" ? "lane-node-pinned" : "lane-node-highlight";
    root.querySelectorAll(`.${edgeClass},.${nodeClass}`).forEach((item) => {
      item.classList.remove(edgeClass, nodeClass);
    });
  }

  /** marker 이벤트를 반대편 marker 로 스크롤하고 하이라이트한다. */
  function handleJumpEvent(event, graphEl, root) {
    const marker = event.target.closest?.("[data-compact-jump-y]");
    if (!marker) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const y = Number(marker.dataset.compactJumpY);
    if (!Number.isFinite(y)) {
      return;
    }
    graphEl.scrollTo({
      top: Math.max(0, y - graphEl.clientHeight / 2),
      behavior: "smooth",
    });
    highlightOpposite(root, marker.dataset.compactTargetId, marker.dataset.compactPair);
  }

  /** 반대편 marker 와 같은 pair marker 를 잠깐 강조한다. */
  function highlightOpposite(root, targetId, pair) {
    root.querySelectorAll(".compact-jump-highlight,.compact-jump-pair").forEach((item) => {
      item.classList.remove("compact-jump-highlight", "compact-jump-pair");
    });
    root.querySelectorAll(`[data-compact-pair="${cssEscape(pair)}"]`).forEach((item) => {
      item.classList.add("compact-jump-pair");
    });
    const target = root.querySelector(`[data-compact-marker-id="${cssEscape(targetId)}"]`);
    if (target) {
      target.classList.add("compact-jump-highlight");
      target.focus?.({ preventScroll: true });
    }
    window.setTimeout(() => {
      root.querySelectorAll(".compact-jump-highlight,.compact-jump-pair").forEach((item) => {
        item.classList.remove("compact-jump-highlight", "compact-jump-pair");
      });
    }, 1600);
  }

  /** CSS.escape 가 없는 환경에서도 dataset 값 selector 를 안전하게 만든다. */
  function cssEscape(value) {
    if (window.CSS?.escape) {
      return window.CSS.escape(String(value || ""));
    }
    return String(value || "").replace(/["\\]/g, "\\$&");
  }

  window.GscGraphCompactRender = {
    bindLaneHighlight,
    bindNavigation,
    edgeAttrs,
    edgeElement,
    edgeHitAttrs,
    laneKey,
    makeLaneHighlightModel,
    nodeMarker,
    raiseMarkers,
    titlePart,
  };
})();
