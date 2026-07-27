// webview renderer가 text/순서/keyed DOM 갱신을 안전하게 공통 처리하는 primitive.
// - HTML 문자열 조립을 강요하지 않고, 각 surface가 기존 element를 보존한 채 행만 갱신할 수 있게 한다.
(function () {
  "use strict";

  /** DOM node 목록에서 keyboard focus를 잃지 않는 key 기반 순서 갱신을 수행한다. */
  function patchKeyedChildren(container, items, options) {
    const keyOf = options.keyOf;
    const create = options.create;
    const update = options.update || function () {};
    const existing = new Map();
    Array.from(container.children).forEach(function (node) {
      const key = node.getAttribute("data-gsc-key");
      if (key !== null) existing.set(key, node);
    });

    const nextNodes = [];
    (items || []).forEach(function (item, index) {
      const key = String(keyOf(item, index));
      let node = existing.get(key);
      if (node) {
        existing.delete(key);
      } else {
        node = create(item, index);
        node.setAttribute("data-gsc-key", key);
      }
      update(node, item, index);
      nextNodes.push(node);
    });

    existing.forEach(function (node) { node.remove(); });
    nextNodes.forEach(function (node, index) {
      const atIndex = container.children[index];
      if (atIndex !== node) container.insertBefore(node, atIndex || null);
    });
    return nextNodes;
  }

  /** textContent로만 문구를 넣어 외부 문자열이 markup으로 해석되지 않게 한다. */
  function setText(element, value) {
    element.textContent = value === undefined || value === null ? "" : String(value);
    return element;
  }

  /** 선택자를 만족하는 첫 요소를 찾되, 없으면 명시적으로 null을 반환한다. */
  function query(root, selector) {
    return root && typeof root.querySelector === "function" ? root.querySelector(selector) : null;
  }

  /** native element를 만들고 class, attributes, text를 필요한 범위에서만 설정한다. */
  function create(document, tagName, options) {
    const element = document.createElement(tagName);
    if (!options) return element;
    if (options.className) element.className = options.className;
    if (options.text !== undefined) setText(element, options.text);
    Object.entries(options.attributes || {}).forEach(function (entry) {
      const name = entry[0];
      const value = entry[1];
      if (value !== undefined && value !== null) element.setAttribute(name, String(value));
    });
    return element;
  }

  window.__gscDom = { create, patchKeyedChildren, query, setText };
}());
