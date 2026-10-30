// PR drawer의 완료 캐시·요청 identity·프레임 병합과 DOM 부분 갱신을 담당한다.
(function () {
  "use strict";

  /**
   * 같은 저장소·PR head/base의 완료 상세를 최대 32개/8MiB 보관하고 30초 뒤 백그라운드로 갱신한다.
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
    /** 같은 저장소·PR의 빠진 OID만 보완하는 변경인지 검사한다. 이미 알려진 ref 변경은 공유하지 않는다. */
    function enriches(previous, next) {
      const before = JSON.parse(previous), after = JSON.parse(next);
      return before[0] === after[0] && before[1] === after[1] && before[4] === after[4]
        && (!before[2] || before[2] === after[2]) && (!before[3] || before[3] === after[3]);
    }
    /** 같은 snapshot의 현재 값 또는 완료 캐시를 찾아 실패·부분 응답의 수명도 확인한다. */
    function itemFor(pr) {
      if (!pr) return undefined;
      const identity = key(pr), request = pending.get(Number(pr.number));
      const source = request && current?.requestId === request.requestId ? current.value.detail : undefined;
      const sameSnapshot = (!source?.headHash || !pr.headHash || source.headHash === pr.headHash)
        && (!source?.baseHash || !pr.baseHash || source.baseHash === pr.baseHash);
      if (request && request.key !== identity && sameSnapshot && enriches(request.key, identity)) request.key = identity;
      let item = current?.key === identity ? current : cache.get(identity);
      if (!item && pr.headHash && pr.baseHash) {
        const known = [current, ...cache.values()].find(candidate => candidate && enriches(candidate.key, identity)
          && candidate.value.detail?.headHash === pr.headHash && candidate.value.detail?.baseHash === pr.baseHash);
        if (known) {
          item = { ...known, key: identity };
          const stored = cache.get(known.key);
          if (stored) {
            cache.delete(known.key); bytes -= stored.bytes;
            if (stored.value.detail?.headHash === pr.headHash && stored.value.detail?.baseHash === pr.baseHash) {
              cache.set(identity, { ...stored, key: identity }); bytes += stored.bytes;
            }
          }
          if (current === known) current = item;
        }
      }
      if (!item) return undefined;
      if (item.partial && pending.get(Number(pr.number))?.requestId !== item.requestId) return cache.get(identity);
      return item;
    }
    /** TTL은 재조회 시점에만 사용한다. 이미 받은 같은 head/base의 파일은 갱신 중에도 표시한다. */
    function get(pr) {
      const identity = key(pr), item = itemFor(pr);
      if (!item) return undefined;
      if (item.value.detail?.refreshing && !pending.has(Number(pr.number))) {
        item.value = { ...item.value, detail: { ...item.value.detail, refreshing: false, reviewThreadsLoading: false } };
      }
      if (cache.has(identity)) { const stored = cache.get(identity); cache.delete(identity); cache.set(identity, stored); }
      return item.value;
    }
    /** 오래된 응답은 무시한다. 갱신 실패·부분 응답 때도 기존 완료 파일과 재시도 상태를 유지한다. */
    function accept(message, pr, value) {
      itemFor(pr);
      const request = pending.get(Number(message.number));
      if (!request || (message.requestId && message.requestId !== request.requestId) || request.key !== key(pr)) return false;
      const previous = itemFor(pr)?.value;
      if (previous?.status === "ready" && !previous.detail.filesLoading) {
        if (value.status === "error") value = { status: "ready", detail: { ...previous.detail,
          refreshing: false, reviewThreadsLoading: false, refreshError: value.message } };
        else if (message.partial && value.detail?.fileCount === previous.detail.fileCount && value.detail.files.length < previous.detail.files.length) {
          value = { ...value, detail: { ...previous.detail, refreshing: true, reviewThreadsLoading: value.detail.reviewThreadsLoading } };
        }
      }
      if (!message.partial) pending.delete(Number(message.number));
      current = { key: request.key, requestId: request.requestId, value, partial: Boolean(message.partial), at: Date.now(), bytes: JSON.stringify(value).length * 2 };
      if (!message.partial && value.status === "ready" && current.bytes <= 8 * 1024 * 1024) {
        const old = cache.get(current.key); if (old) bytes -= old.bytes;
        cache.delete(current.key); cache.set(current.key, current); bytes += current.bytes;
        while (cache.size > 32 || bytes > 8 * 1024 * 1024) {
          const first = cache.keys().next().value; bytes -= cache.get(first).bytes; cache.delete(first);
        }
      }
      return true;
    }
    /** 진행 요청을 공유하고 TTL 만료는 기존 파일을 보이는 채 갱신한다. 다른 ref는 새 ID로 구분한다. */
    function request(pr) {
      if (!pr) return;
      const item = itemFor(pr);
      if (item && Date.now() - item.at < 30000) return;
      const number = Number(pr.number), identity = key(pr);
      if (pending.get(number)?.key === identity) return;
      if (item?.value.status === "ready") current = { ...item,
        value: { ...item.value, detail: { ...item.value.detail, refreshing: true, refreshError: undefined,
          reviewThreadsError: undefined, reviewThreadsLoading: true } } };
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
    /** 완료 캐시의 재사용을 해제해 즉시 재시도하되, 이미 표시한 정상 파일은 새 응답까지 보존한다. */
    function retry(pr) {
      const identity = key(pr), item = cache.get(identity);
      if (item) { bytes -= item.bytes; cache.delete(identity); }
      if (current?.key === identity) {
        if (current.value.status === "ready") current = { ...current, at: 0, partial: false };
        else current = undefined;
      }
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
    for (const name of ["data-show-pr", "data-pr-reviewers-toggle", "data-pr-search-input", "data-pr-search-clear", "data-pr-search-more", "data-pr-file-folder"]) {
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
