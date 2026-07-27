// 인터랙티브 rebase 계획 편집 웹뷰의 클라이언트 스크립트.
// - 커밋 목록을 드래그로 재정렬하고, 각 커밋의 동작(pick/reword/squash/fixup/drop)과
//   메시지를 편집한 뒤, 최종 계획을 확장으로 보낸다.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const listEl = document.getElementById("list");
  const statusEl = document.getElementById("operation-status");
  const startBtn = document.getElementById("start");
  const retryBtn = document.getElementById("retry");
  const T = window.__gscRebaseI18n || {};

  // 선택 가능한 동작과 표시 라벨(영어 기본; 라벨은 UI 가독성용 고정 텍스트)
  const ACTIONS = ["pick", "reword", "squash", "fixup", "drop"];
  // 메시지 입력이 필요한 동작
  const MESSAGE_ACTIONS = ["reword", "squash"];

  let dragging = null; // 현재 드래그 중인 li 요소

  /** HTML 특수문자를 이스케이프한다. */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /**
   * 커밋 한 건을 편집 가능한 행(li)으로 만든다.
   * @param commit { hash, subject, body }
   */
  function buildItem(commit) {
    const li = document.createElement("li");
    li.className = "item";
    li.draggable = true;
    li.dataset.hash = commit.hash;
    li.dataset.body =
      commit.body && commit.body.length
        ? commit.subject + "\n\n" + commit.body
        : commit.subject;

    const options = ACTIONS.map(
      (a) => `<option value="${a}">${a}</option>`
    ).join("");
    li.innerHTML =
      `<span class="handle" title="${esc(T.dragHandle)}" aria-hidden="true">⠿</span>` +
      `<div class="body">` +
      `<div class="top">` +
	      `<select class="action" title="${esc(T.chooseAction)}" aria-label="${esc(T.chooseAction)}">${options}</select>` +
      `<span class="subject">${esc(commit.subject)}</span>` +
      `<span class="hash">${esc(commit.hash.slice(0, 7))}</span>` +
	      `<span class="move-actions"><button class="move-up" type="button" title="${esc(T.moveUp)}" aria-label="${esc(T.moveUp)}" data-tooltip="${esc(T.moveUp)}">↑</button><button class="move-down" type="button" title="${esc(T.moveDown)}" aria-label="${esc(T.moveDown)}" data-tooltip="${esc(T.moveDown)}">↓</button></span>` +
      `</div>` +
	      `<textarea class="message" title="${esc(T.editMessage)}" ` +
	      `aria-label="${esc(T.editMessage)}" placeholder="${esc(T.commitMessage)}"></textarea>` +
      `</div>`;

    const select = li.querySelector(".action");
    const textarea = li.querySelector(".message");
    select.addEventListener("change", () => applyAction(li, select, textarea));
    li.querySelector(".move-up").addEventListener("click", () => moveItem(li, -1));
    li.querySelector(".move-down").addEventListener("click", () => moveItem(li, 1));
    li.addEventListener("keydown", (event) => {
      if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      moveItem(li, event.key === "ArrowUp" ? -1 : 1);
    });

    bindDrag(li);
    return li;
  }

  /**
   * 동작 선택에 따라 행의 표시(메시지 입력칸/드롭 스타일)를 갱신한다.
   * @param li       행 요소
   * @param select   동작 select
   * @param textarea 메시지 textarea
   */
  function applyAction(li, select, textarea) {
    const action = select.value;
    const needsMessage = MESSAGE_ACTIONS.indexOf(action) >= 0;
    li.classList.toggle("needs-message", needsMessage);
    li.classList.toggle("drop-action", action === "drop");
    // reword 로 처음 바꾸면 원본 메시지를 채워 편집을 돕는다.
    if (action === "reword" && !textarea.value) {
      textarea.value = li.dataset.body || "";
    }
  }

  /**
   * 행에 드래그 앤 드롭 재정렬 이벤트를 연결한다.
   * @param li 행 요소
   */
  function bindDrag(li) {
    li.addEventListener("dragstart", () => {
      dragging = li;
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      dragging = null;
    });
    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragging || dragging === li) {
        return;
      }
      // 마우스 위치가 대상의 위/아래 절반인지에 따라 앞/뒤에 삽입한다.
      const rect = li.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      listEl.insertBefore(dragging, after ? li.nextSibling : li);
    });
  }

  /** 같은 todo 목록 안에서 항목을 한 칸 이동하고 포커스를 유지해 키보드 재정렬을 가능하게 한다. */
  function moveItem(li, offset) {
    const items = Array.from(listEl.querySelectorAll(".item"));
    const index = items.indexOf(li);
    const destination = index + offset;
    if (index < 0 || destination < 0 || destination >= items.length) return;
    listEl.insertBefore(li, offset < 0 ? items[destination] : items[destination].nextSibling);
    li.querySelector(offset < 0 ? ".move-up" : ".move-down")?.focus();
  }

  /** 현재 DOM 순서대로 계획 항목 배열을 수집한다(위가 먼저=오래된 것). */
  function collectItems() {
    return Array.from(listEl.querySelectorAll(".item")).map((li) => {
      const action = li.querySelector(".action").value;
      const message = li.querySelector(".message").value;
      return { hash: li.dataset.hash, action: action, message: message };
    });
  }

  /**
   * 계획(커밋 목록)을 받아 목록을 그린다.
   * @param commits RebaseCommit 배열(오래된 것부터)
   */
  function renderPlan(commits) {
    listEl.innerHTML = "";
    for (const commit of commits) {
      listEl.appendChild(buildItem(commit));
    }
  }

  // 버튼: 시작/취소
  startBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "start", items: collectItems() });
  });
  document.getElementById("cancel").addEventListener("click", () => {
    vscode.postMessage({ type: "cancel" });
  });
  retryBtn.addEventListener("click", () => vscode.postMessage({ type: "retry" }));

  /** host operation 상태에 맞춰 실행 중 중복 제출과 오류 재시도 surface를 갱신한다. */
  function renderOperation(operation) {
    statusEl.textContent = operation.message || "";
    statusEl.className = `operation-status operation-status--${operation.state}`;
    statusEl.hidden = !operation.message;
    startBtn.disabled = operation.state === "loading" || operation.state === "running";
    retryBtn.hidden = operation.state !== "error";
  }

  // 확장에서 오는 메시지 처리
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "plan") {
      renderPlan(msg.commits);
      renderOperation({ state: "ready", message: "" });
    } else if (msg.type === "operation") {
      renderOperation(msg);
    }
  });

  // 준비 완료를 알려 계획 데이터를 받는다.
  vscode.postMessage({ type: "ready" });
})();
