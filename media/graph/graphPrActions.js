// PR detail drawer 의 PR 단위 git action 버튼을 담당한다.
// - graphPr.js 가 이미 크므로 버튼 렌더링과 클릭 메시지를 분리한다.
(function () {
  /** PR action 버튼 클릭을 extension host 메시지로 전달한다. */
  function init() {
    document.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-pr-operation]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      window.GscGraphPostMessage?.({
        type: "pullRequestAction",
        number: Number(button.dataset.prOperation),
        action: button.dataset.prAction || undefined,
      });
    });
  }

  /** PR 단위 cherry-pick/rebase 메뉴를 여는 버튼 HTML 을 만든다. */
  function button(number) {
    const title = `PR cherry-pick/rebase actions for #${number}`;
    return `<button type="button" class="pr-icon-action" data-pr-operation="${esc(number)}" title="${esc(title)}" data-tooltip="${esc(title)}" aria-label="${esc(title)}">` +
      `<span class="codicon codicon-git-pull-request" aria-hidden="true"></span></button>`;
  }

  /** PR 카드에서 바로 실행할 rebase/squash 버튼 묶음을 만든다. */
  function directButtons(number) {
    return operationButton(number, "rebase", "git-pull-request", `Rebase PR #${number} into current branch`) +
      operationButton(number, "squash", "combine", `Squash cherry-pick PR #${number}`);
  }

  /** PR 작업 하나를 바로 실행하는 아이콘 버튼 HTML 을 만든다. */
  function operationButton(number, action, icon, title) {
    return `<button type="button" class="pr-icon-action" data-pr-operation="${esc(number)}" data-pr-action="${esc(action)}" ` +
      `title="${esc(title)}" data-tooltip="${esc(title)}" aria-label="${esc(title)}">` +
      `<span class="codicon codicon-${esc(icon)}" aria-hidden="true"></span></button>`;
  }

  /** HTML 특수문자를 escape 한다. */
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  }

  window.GscGraphPrActions = { button, directButtons };
  init();
})();
