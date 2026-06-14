// 그래프 rebase 메시지 정책.
// - squash 시 사용자가 원하면 합쳐지는 커밋들의 제목/본문을 기본 메시지에 포함한다.
(function () {
  "use strict";

  /** 커밋의 원래 메시지를 제목/본문 순서로 복원한다. */
  function commitMessage(item) {
    const subject = item?.subject || "";
    const body = item?.body || "";
    if (body && body !== subject) {
      return `${subject}${subject ? "\n\n" : ""}${body}`.trim();
    }
    return (body || subject || "").trim();
  }

  /** squash 대상 커밋들의 기존 메시지를 사용자가 편집할 수 있는 기본값으로 묶는다. */
  function squashMessage(items, item, includeHistory) {
    const index = items.findIndex((entry) => entry.hash === item.hash);
    const start = Math.max(0, index - 1);
    const related = includeHistory ? items.slice(start, index + 1) : [item];
    return related.map((entry, offset) => {
      const heading = `Commit ${offset + 1}: ${String(entry.hash || "").slice(0, 10)} ${entry.subject || ""}`.trim();
      const body = commitMessage(entry);
      return body ? `${heading}\n\n${body}` : heading;
    }).join("\n\n");
  }

  /** action 에 맞는 rebase 메시지 기본값을 반환한다. */
  function defaultMessage(items, item, action, includeHistory) {
    if (action === "squash") {
      return squashMessage(items, item, includeHistory);
    }
    return commitMessage(item);
  }

  window.GscGraphRebaseMessages = {
    defaultMessage,
  };
})();
