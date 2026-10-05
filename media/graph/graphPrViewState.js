// PR drawer의 완료 캐시·요청 identity·프레임 병합과 DOM 부분 갱신을 담당한다.
(function () {
  "use strict";

  /**
   * 같은 저장소·PR head/base의 상세를 최대 32개/8MiB/30초만 보관한다.
   * @param post host 메시지 함수. 현재 화면의 큰 상세는 완료 캐시와 별도로 표시를 유지한다.
   */
  function create(post) {
    let context = "", sequence = 0, bytes = 0, current;
    const cache = new Map(), pending = new Map();
    /** 저장소·인증 문맥이 바뀌면 이전 완료 값과 요청을 모두 비운다. */
    function setContext(next) {
      if (next === context) return;
      context = next; cache.clear(); bytes = 0; current = undefined; pending.clear();
    }
    /** 저장소·PR ref를 구분해 파일 결과를 공유하고 댓글 갱신은 완료 값의 TTL로 제한한다. */
    function key(pr) {
      return JSON.stringify([context, pr?.number, pr?.headHash, pr?.baseHash, pr?.baseRefName]);
    }
    /** 완료 값을 LRU로 읽는다. 선택 중인 큰 결과는 화면 전환 전까지 별도로 유지한다. */
    function get(pr) {
      const identity = key(pr), item = current?.key === identity ? current : cache.get(identity);
      if (!item || Date.now() - item.at >= 30000) return undefined;
      if (cache.has(identity)) { cache.delete(identity); cache.set(identity, item); }
      return item.value;
    }
    /** 오래된 응답은 무시하고 성공 값만 제한된 완료 캐시에 저장한다. 실패는 현재 화면에서만 유지한다. */
    function accept(message, pr, value) {
      const request = pending.get(Number(message.number));
      if (!request || (message.requestId && message.requestId !== request.requestId) || request.key !== key(pr)) return false;
      pending.delete(Number(message.number));
      current = { key: request.key, value, at: Date.now(), bytes: JSON.stringify(value).length * 2 };
      if (value.status === "ready" && current.bytes <= 8 * 1024 * 1024) {
        const old = cache.get(current.key); if (old) bytes -= old.bytes;
        cache.delete(current.key); cache.set(current.key, current); bytes += current.bytes;
        while (cache.size > 32 || bytes > 8 * 1024 * 1024) {
          const first = cache.keys().next().value; bytes -= cache.get(first).bytes; cache.delete(first);
        }
      }
      return true;
    }
    /** 같은 번호의 진행 요청을 공유하고 다른 ref의 요청은 새 ID로 교체한다. */
    function request(pr) {
      if (!pr || get(pr)) return;
      const number = Number(pr.number), identity = key(pr);
      if (pending.get(number)?.key === identity) return;
      const requestId = `pr-detail-${++sequence}`;
      pending.set(number, { key: identity, requestId });
      post({ type: "refreshPullRequestDetail", number, requestId });
    }
    /** 닫기·선택 변경·host 취소는 완료 값을 유지하면서 진행 요청 identity만 해제한다. */
    function cancel(number, requestId) {
      if (number === undefined) { pending.clear(); return; }
      const item = pending.get(Number(number));
      if (!requestId || item?.requestId === requestId) pending.delete(Number(number));
    }
    /** 실패·만료를 사용자가 즉시 다시 조회할 수 있게 해당 PR 완료 값을 제거한다. */
    function retry(pr) {
      const identity = key(pr), item = cache.get(identity);
      if (item) { bytes -= item.bytes; cache.delete(identity); }
      if (current?.key === identity) current = undefined;
      cancel(pr?.number);
    }
    return { setContext, get, accept, request, cancel, retry,
      stats: () => ({ entries: cache.size, bytes, pending: pending.size }) };
  }

  let frame = 0, latest;
  /** 같은 프레임의 PR/graph 상태 변경은 마지막 화면 상태로 한 번만 그린다. */
  function schedule(callback) {
    latest = callback;
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; const next = latest; latest = undefined; next?.(); });
  }

  /**
   * 기존 DOM에서 변경된 노드·속성만 반영해 검색 입력·포커스·스크롤·파일 트리를 유지한다.
   * @param root 현재 drawer 루트, html 기존 renderer가 만든 같은 시각 언어의 완성 HTML
   */
  function updateHtml(root, html) {
    const template = document.createElement("template"); template.innerHTML = html;
    syncChildren(root, template.content);
  }

  /** 목록 카드·검색 입력·파일 노드의 안정된 identity를 찾아 정렬 변경 뒤에도 같은 DOM을 재사용한다. */
  function nodeKey(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (node.id) return `id:${node.id}`;
    if (node.matches(".pr-file-row")) return `file:${node.dataset.path}`;
    if (node.matches(".pr-file-folder")) return `folder:${node.querySelector(":scope > [data-pr-file-folder]")?.dataset.prFileFolder}`;
    for (const name of ["data-show-pr", "data-pr-search-input", "data-pr-search-clear", "data-pr-search-more", "data-pr-file-folder"]) {
      if (node.hasAttribute(name)) return `${name}:${node.getAttribute(name)}`;
    }
    return "";
  }

  /** 같은 태그는 속성·텍스트를 갱신하고 실제 내용이 같은 subtree는 탐색하지 않는다. */
  function syncNode(current, next) {
    if (current.isEqualNode(next)) return;
    if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) { current.replaceWith(next.cloneNode(true)); return; }
    if (current.nodeType !== Node.ELEMENT_NODE) { current.nodeValue = next.nodeValue; return; }
    for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    for (const attribute of [...next.attributes]) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    if (current instanceof HTMLInputElement && !window.GscGraphPrSearch?.isComposing?.() && current.value !== next.value) current.value = next.value;
    syncChildren(current, next);
  }

  /** keyed child는 이동해 재사용하고 추가/삭제 항목만 생성·제거한다. */
  function syncChildren(current, next) {
    const keyed = new Map([...current.childNodes].map(node => [nodeKey(node), node]).filter(([key]) => key));
    let cursor = current.firstChild;
    for (const child of [...next.childNodes]) {
      const key = nodeKey(child);
      let match = key ? keyed.get(key) : cursor && !nodeKey(cursor) ? cursor : undefined;
      if (!match) { match = child.cloneNode(true); current.insertBefore(match, cursor); }
      else if (match !== cursor) current.insertBefore(match, cursor);
      const following = match.nextSibling;
      syncNode(match, child);
      cursor = following;
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  }

  window.GscGraphPrViewState = { create, schedule, updateHtml };
})();
