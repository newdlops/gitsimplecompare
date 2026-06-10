// git 그래프 웹뷰의 클라이언트 스크립트(브라우저 컨텍스트에서 실행).
// - 확장에서 받은 GraphData 를 SVG(간선/노드) + 텍스트 행으로 렌더링한다.
// - 노드 클릭 → 상세 요청, 파일 클릭 → diff 열기 요청을 확장으로 보낸다.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  // 레이아웃 상수(픽셀)
  const ROW_H = 24; // 한 행 높이
  const LANE_W = 14; // 레인(열) 간격
  const NODE_R = 4; // 노드 반지름
  const MARGIN = 12; // 그래프 좌측 여백

  // 레인 색상 팔레트(색상 인덱스를 순환 사용)
  const COLORS = [
    "#e06c75", "#61afef", "#98c379", "#e5c07b",
    "#c678dd", "#56b6c2", "#d19a66", "#56b6c2",
  ];

  const graphEl = document.getElementById("graph");
  const detailEl = document.getElementById("detail");

  let currentRows = []; // 마지막으로 렌더링한 행 데이터(선택/상세 요청에 사용)
  let selectedHash = null;

  // SVG_NS: SVG 요소 생성용 네임스페이스
  const SVG_NS = "http://www.w3.org/2000/svg";

  /** 레인 인덱스를 x 좌표로 변환한다. */
  function laneX(col) {
    return MARGIN + col * LANE_W;
  }

  /** 행 인덱스를 y 좌표(행 중앙)로 변환한다. */
  function rowY(row) {
    return row * ROW_H + ROW_H / 2;
  }

  /** 색상 인덱스를 팔레트 색으로 변환한다. */
  function colorOf(idx) {
    return COLORS[idx % COLORS.length];
  }

  /** HTML 특수문자를 이스케이프해 안전하게 삽입한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 네임스페이스를 지정해 SVG 요소를 만든다. */
  function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    for (const key in attrs) {
      el.setAttribute(key, attrs[key]);
    }
    return el;
  }

  /**
   * 한 간선의 SVG path d 문자열을 만든다.
   * - 자식 노드에서 부모의 레인으로 굽고, 레인을 따라 내려간 뒤 부모 노드로 굽는다.
   */
  function edgePath(edge, rowCount) {
    const fx = laneX(edge.fromColumn);
    const fy = rowY(edge.fromRow);
    const cx = laneX(edge.column);
    const toRow = Math.min(edge.toRow, rowCount); // 로드 밖이면 바닥
    const tx = laneX(edge.toColumn);
    const ty = rowY(toRow);

    let d = `M ${fx} ${fy} `;
    // 자식 → 레인 진입(열이 다르면 반 행 높이로 굽힘)
    if (edge.fromColumn !== edge.column) {
      const my = fy + ROW_H / 2;
      d += `C ${fx} ${my}, ${cx} ${my}, ${cx} ${fy + ROW_H} `;
    }
    // 레인을 따라 부모 근처까지 직선
    const bottom = edge.toColumn !== edge.column ? ty - ROW_H : ty;
    d += `L ${cx} ${bottom} `;
    // 레인 → 부모 노드 진입
    if (edge.toColumn !== edge.column) {
      const my = ty - ROW_H / 2;
      d += `C ${cx} ${my}, ${tx} ${my}, ${tx} ${ty} `;
    }
    return d;
  }

  /**
   * 그래프 전체(SVG 간선/노드 + 텍스트 행)를 렌더링한다.
   * @param data GraphData
   */
  function renderGraph(data) {
    currentRows = data.rows;
    graphEl.innerHTML = "";

    if (!data.rows.length) {
      graphEl.innerHTML = '<p style="padding:16px;opacity:0.6">No commits.</p>';
      return;
    }

    const graphWidth = MARGIN * 2 + data.laneCount * LANE_W;
    const height = data.rows.length * ROW_H;
    graphEl.style.height = height + "px";

    // 1) SVG: 간선 먼저, 노드 나중에(노드가 위에 오도록)
    const svg = svgEl("svg", { width: graphWidth, height: height });
    for (const edge of data.edges) {
      svg.appendChild(
        svgEl("path", {
          d: edgePath(edge, data.rows.length),
          fill: "none",
          stroke: colorOf(edge.color),
          "stroke-width": "1.5",
        })
      );
    }
    for (let r = 0; r < data.rows.length; r++) {
      const row = data.rows[r];
      svg.appendChild(
        svgEl("circle", {
          cx: laneX(row.column),
          cy: rowY(r),
          r: NODE_R,
          fill: colorOf(row.color),
          stroke: "var(--vscode-editor-background)",
          "stroke-width": "1",
        })
      );
    }
    graphEl.appendChild(svg);

    // 2) 텍스트 행(그래프 폭만큼 왼쪽 여백)
    for (let r = 0; r < data.rows.length; r++) {
      graphEl.appendChild(buildRow(data.rows[r], r, graphWidth));
    }
  }

  /**
   * 커밋 한 행의 DOM(참조 배지 + 제목 + 작성자/날짜)을 만든다.
   * @param row       GraphRow
   * @param index     행 인덱스
   * @param leftInset 그래프 폭(좌측 여백)
   */
  function buildRow(row, index, leftInset) {
    const el = document.createElement("div");
    el.className = "row" + (row.hash === selectedHash ? " selected" : "");
    el.style.top = index * ROW_H + "px";
    el.style.left = leftInset + "px";
    el.style.right = "0";
    el.dataset.hash = row.hash;

    const refs = (row.refs || [])
      .map(
        (ref) =>
          `<span class="ref${ref === "HEAD" ? " head" : ""}">${esc(ref)}</span>`
      )
      .join("");
    const date = formatDate(row.dateIso);
    el.innerHTML =
      refs +
      `<span class="subject">${esc(row.subject)}</span>` +
      `<span class="meta">${esc(row.authorName)} · ${esc(date)}</span>`;

    el.addEventListener("click", () => selectCommit(row.hash));
    return el;
  }

  /** ISO 날짜를 YYYY-MM-DD HH:mm 형태로 짧게 표시한다. */
  function formatDate(iso) {
    if (!iso) {
      return "";
    }
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
      return iso;
    }
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
      d.getHours()
    )}:${p(d.getMinutes())}`;
  }

  /**
   * 커밋을 선택 상태로 만들고 상세를 요청한다.
   * @param hash 선택할 커밋 해시
   */
  function selectCommit(hash) {
    selectedHash = hash;
    const rows = graphEl.querySelectorAll(".row");
    rows.forEach((el) =>
      el.classList.toggle("selected", el.dataset.hash === hash)
    );
    vscode.postMessage({ type: "selectCommit", hash: hash });
  }

  /**
   * 커밋 상세를 오른쪽 패널에 렌더링한다.
   * @param detail CommitDetail
   */
  function renderDetail(detail) {
    const parent = detail.parents && detail.parents[0] ? detail.parents[0] : "";
    const files = (detail.files || [])
      .map(
        (f) =>
          `<li class="file" data-path="${esc(f.path)}">` +
          `<span class="status">${esc(f.status)}</span>` +
          `<span class="path">${esc(f.path)}</span>` +
          `<span class="stat"><span class="add">+${f.additions}</span> ` +
          `<span class="del">-${f.deletions}</span></span></li>`
      )
      .join("");

    detailEl.innerHTML =
      `<h2>${esc(detail.message.split("\n")[0])}</h2>` +
      `<div class="commit-meta">${esc(detail.hash.slice(0, 10))} · ` +
      `${esc(detail.authorName)} &lt;${esc(detail.authorEmail)}&gt; · ` +
      `${esc(formatDate(detail.authorDateIso))}</div>` +
      `<div class="actions"><button id="rebase-from">Rebase from here</button></div>` +
      `<div class="message">${esc(detail.message)}</div>` +
      `<ul class="files">${files}</ul>`;

    detailEl.querySelectorAll(".file").forEach((el) => {
      el.addEventListener("click", () =>
        vscode.postMessage({
          type: "openFileDiff",
          hash: detail.hash,
          parent: parent,
          path: el.dataset.path,
        })
      );
    });
    // "이 커밋부터 rebase" 버튼 → 확장에 rebase 패널 열기 요청
    const rebaseBtn = detailEl.querySelector("#rebase-from");
    if (rebaseBtn) {
      rebaseBtn.addEventListener("click", () =>
        vscode.postMessage({ type: "rebaseFrom", hash: detail.hash })
      );
    }
  }

  // 확장에서 오는 메시지 처리
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "graph") {
      renderGraph(msg.data);
    } else if (msg.type === "commitDetail") {
      renderDetail(msg.detail);
    } else if (msg.type === "error") {
      detailEl.innerHTML = `<p class="placeholder">⚠ ${esc(msg.message)}</p>`;
    }
  });

  // 준비 완료를 알려 초기 그래프 데이터를 받는다.
  vscode.postMessage({ type: "ready" });
})();
