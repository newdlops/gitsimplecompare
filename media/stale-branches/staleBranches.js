// 로컬 브랜치 현황 표의 검색·stale 필터·선택을 처리한다. 삭제는 host 확인 단계에 위임한다.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const { strings: T, branches } = window.__gscStaleBranches;
  const selected = new Set();
  const search = document.getElementById("search");
  const filter = document.getElementById("filter");
  const selectVisible = document.getElementById("select-visible");
  const review = document.getElementById("review");
  const clear = document.getElementById("clear");
  const error = document.getElementById("error");
  let pending = false;

  /** 외부 문자열을 textContent로만 넣어 브랜치 이름·커밋 제목을 안전하게 표시한다. */
  function element(tag, className, content) {
    const node = document.createElement(tag);
    node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  /** 순번에 해당하는 지역화 자리표시자를 실제 수치로 바꾼다. */
  function format(text, ...values) { return text.replace(/\{(\d+)\}/g, (match, index) => String(values[index] ?? match)); }

  /**
   * 로컬 이름을 중심으로 상태·원격 대응·보호 이유·최신 커밋을 한 행에 표시한다.
   * @param {object} branch host의 표시 모델 @param {number} index 체크박스의 고유 DOM 번호
   * @returns 필터·선택 갱신 때 재사용할 행과 입력 컨트롤
   */
  function branchRow(branch, index) {
    const row = element("tr", "branch-row");
    row.dataset.branch = branch.name;
    const selection = element("td", "selection-column");
    const input = document.createElement("input");
    input.id = `local-branch-${index}`;
    input.type = "checkbox";
    input.disabled = !branch.selectable;
    input.title = branch.selectionLabel;
    input.setAttribute("aria-label", branch.selectionLabel);
    selection.title = branch.selectionLabel;
    selection.append(input);
    const identity = element("td", "branch-identity");
    const name = element("label", "branch-name", branch.name);
    name.htmlFor = input.id;
    name.title = branch.name;
    identity.append(name, element("div", "branch-meta", branch.remote));
    if (branch.protection) identity.append(element("div", "branch-protection", branch.protection));
    const status = element("td", "status-column");
    status.append(element("span", `branch-status${branch.stale ? " stale" : ""}`, branch.status));
    if (branch.stale) status.append(element("div", "branch-meta", branch.merge));
    const commit = element("td", "latest-column");
    commit.append(element("code", "branch-hash", branch.hash));
    const subject = element("div", "commit-subject", branch.subject);
    subject.title = branch.subject;
    commit.append(subject);
    row.append(selection, identity, status, commit);
    input.addEventListener("change", function selectBranch() {
      if (pending || !branch.selectable) return;
      if (input.checked) selected.add(branch.name); else selected.delete(branch.name);
      updateSelection();
    });
    return { branch, row, input, searchable: `${branch.name} ${branch.status} ${branch.remote} ${branch.protection} ${branch.subject}`.toLocaleLowerCase() };
  }

  const rows = branches.map(branchRow);
  const fragment = document.createDocumentFragment();
  for (const item of rows) fragment.append(item.row);
  document.getElementById("branches").append(fragment);

  /** 검색·상태 조건만 바꾸고 기존 선택은 유지해 필터 전환 중 삭제 대상이 조용히 바뀌지 않게 한다. */
  function applyFilter() {
    const terms = search.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    for (const item of rows) item.row.hidden = (filter.value === "stale" && !item.branch.stale) || !terms.every(term => item.searchable.includes(term));
    const visible = rows.filter(item => !item.row.hidden).length;
    document.getElementById("shown").textContent = format(T.shown, visible, rows.length);
    const empty = document.getElementById("empty");
    empty.hidden = visible > 0;
    empty.textContent = rows.length ? T.noMatches : T.noBranches;
    updateSelection();
  }

  /** 체크·부분 선택·필터 밖 선택 수와 다음 행동의 활성 상태를 현재 선택 집합에서 계산한다. */
  function updateSelection() {
    let hiddenSelected = 0;
    const visible = rows.filter(item => !item.row.hidden && item.branch.selectable);
    for (const item of rows) {
      item.input.checked = selected.has(item.branch.name);
      item.input.disabled = pending || !item.branch.selectable;
      item.row.classList.toggle("selected", item.input.checked);
      if (item.row.hidden && item.input.checked) hiddenSelected++;
    }
    const checked = visible.filter(item => selected.has(item.branch.name)).length;
    selectVisible.checked = visible.length > 0 && checked === visible.length;
    selectVisible.indeterminate = checked > 0 && checked < visible.length;
    selectVisible.disabled = pending || !visible.length;
    clear.disabled = pending || !selected.size;
    review.disabled = pending || !selected.size;
    review.title = pending ? T.opening : selected.size ? T.reviewHint : T.selectHint;
    review.dataset.tooltip = review.title;
    review.textContent = pending ? T.opening : T.review;
    review.setAttribute("aria-label", review.textContent);
    if (pending) review.setAttribute("aria-busy", "true"); else review.removeAttribute("aria-busy");
    document.getElementById("selected").textContent = format(T.selected, selected.size);
    const hidden = document.getElementById("hidden-selection");
    hidden.hidden = hiddenSelected === 0;
    hidden.textContent = format(T.hidden, hiddenSelected);
  }

  search.addEventListener("input", applyFilter);
  filter.addEventListener("change", applyFilter);
  selectVisible.addEventListener("change", function selectFiltered() {
    if (pending) return;
    for (const item of rows) {
      if (item.row.hidden || !item.branch.selectable) continue;
      if (selectVisible.checked) selected.add(item.branch.name); else selected.delete(item.branch.name);
    }
    updateSelection();
  });
  clear.addEventListener("click", function clearSelection() { selected.clear(); updateSelection(); });
  document.getElementById("cancel").addEventListener("click", function cancel() { vscode.postMessage({ type: "cancel" }); });
  review.addEventListener("click", function reviewDeletion() {
    if (pending || !selected.size) return;
    pending = true;
    error.hidden = true;
    updateSelection();
    vscode.postMessage({ type: "select", names: [...selected] });
  });
  window.addEventListener("message", function receive(event) {
    if (event.data?.type !== "error") return;
    pending = false;
    error.textContent = typeof event.data.message === "string" ? event.data.message : "";
    error.hidden = !error.textContent;
    updateSelection();
  });
  applyFilter();
})();
