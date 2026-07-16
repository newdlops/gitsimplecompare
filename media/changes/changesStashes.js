// Changes 웹뷰 Stashes 섹션 렌더/이벤트 모듈.
// - stash 메타데이터는 즉시 표시하고 파일 목록은 사용자가 항목을 펼칠 때만 host 에 요청한다.
(function () {
  "use strict";

  const T = Object.assign(
    {
      noStashes: "No stashes.",
      moreActions: "More Actions...",
      applyStash: "Apply Stash",
      popStash: "Pop Stash",
      dropStash: "Drop Stash",
      branchStash: "Create Branch from Stash",
      collapseSection: "Collapse {0}",
      expandSection: "Expand {0}",
    },
    window.__gscI18n || {}
  );

  // 렌더가 갱신되어 DOM 이 교체되어도 hash 기반 동일 stash의 조회 결과와 진행 상태를 재사용한다.
  const loadingKeys = new Set();
  const filesByKey = new Map();
  let renderFileIcon = () => "";
  let webviewApi;

  /**
   * HTML 본문과 data-* 속성에 넣을 문자열의 특수문자를 이스케이프한다.
   * @param {unknown} text 화면에 출력하거나 속성에 보관할 값
   * @returns {string} HTML 문맥에서 안전하게 사용할 수 있는 문자열
   */
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * git 파일 상태를 stash 파일 행에서 사용할 codicon 클래스로 변환한다.
   * @param {string | undefined} status git name-status 형식의 한 글자 상태
   * @returns {string} 상태 의미에 맞는 codicon CSS 클래스
   */
  function statusCodicon(status) {
    switch (status) {
      case "A":
        return "codicon-diff-added";
      case "D":
        return "codicon-diff-removed";
      case "R":
      case "C":
        return "codicon-diff-renamed";
      case "U":
        return "codicon-warning";
      default:
        return "codicon-diff-modified";
    }
  }

  /**
   * stash 펼침 상태를 저장할 때 사용할 안정적인 식별자를 고른다.
   * @param {object} stash hash/ref/index를 포함하는 stash payload
   * @returns {string} 렌더 사이에서도 동일한 stash를 식별하는 키
   */
  function stashKey(stash) {
    return stash.hash || stash.ref || String(stash.index || "");
  }

  /**
   * 현재 펼침 상태에 맞춰 disclosure 컨트롤의 다음 동작 문구를 만든다.
   * @param {string} label stash 메시지 또는 ref처럼 사용자가 식별할 수 있는 이름
   * @param {boolean} expanded 현재 stash 파일 목록이 펼쳐져 있는지 여부
   * @returns {string} 클릭 시 수행될 Collapse/Expand 동작을 설명하는 문구
   */
  function disclosureTooltip(label, expanded) {
    const template = expanded ? T.collapseSection : T.expandSection;
    return String(template).replace("{0}", label);
  }

  /**
   * stash 헤더의 tooltip과 접근성 속성을 현재 펼침 상태에 맞게 함께 갱신한다.
   * @param {HTMLElement} header disclosure 역할을 하는 stash 헤더 요소
   * @param {boolean} expanded 파일 목록이 펼쳐져 있으면 true
   * @returns {void} DOM 속성만 갱신하므로 반환값은 없다
   */
  function syncDisclosure(header, expanded) {
    const label = header.dataset.disclosureLabel || header.textContent?.trim() || "Stash";
    const tooltip = disclosureTooltip(label, expanded);
    header.title = tooltip;
    header.dataset.tooltip = tooltip;
    header.setAttribute("aria-label", tooltip);
    header.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  /**
   * stash에 포함된 파일 하나를 클릭 가능한 diff 행 HTML로 만든다.
   * @param {string} ref 파일 비교에 사용할 stash ref
   * @param {object} change status와 path를 가진 파일 변경 payload
   * @param {(path: string) => string} renderFileIcon 현재 파일 아이콘 테마 HTML 생성 함수
   * @returns {string} 파일명·디렉터리·상태 아이콘을 포함한 행 HTML
   */
  function fileHtml(ref, change, renderFileIcon) {
    const path = change.path || "";
    const slash = path.lastIndexOf("/");
    const fileName = slash >= 0 ? path.slice(slash + 1) : path;
    const directory = slash >= 0 ? path.slice(0, slash) : "";
    return (
      `<div class="row file stash-file" data-status="${esc(change.status)}" ` +
      `data-ref="${esc(ref)}" data-path="${esc(path)}" title="${esc(path)}">` +
      `<span class="twistie"></span>` +
      `<span class="icon codicon ${statusCodicon(change.status)}"></span>` +
      renderFileIcon(path) +
      `<span class="name">${esc(fileName)}</span>` +
      (directory ? `<span class="dir">${esc(directory)}</span>` : "") +
      `</div>`
    );
  }

  /**
   * stash 메타데이터와 이미 조회된 파일 목록을 접기 가능한 항목 HTML로 만든다.
   * @param {object} stash ref/hash/message와 지연 조회 상태를 가진 stash payload
   * @param {Record<string, boolean>} expandedByKey stash별 펼침 상태 저장소
   * @param {(path: string) => string} renderFileIcon 파일 아이콘 HTML 생성 함수
   * @returns {string} disclosure 헤더와 자식 파일 컨테이너를 포함한 HTML
   */
  function itemHtml(stash, expandedByKey, renderFileIcon) {
    const key = stashKey(stash);
    const expanded = expandedByKey[key] === true;
    const cachedFiles = filesByKey.get(key);
    const filesLoaded = cachedFiles !== undefined;
    const chevron = expanded ? "codicon-chevron-down" : "codicon-chevron-right";
    const meta = [stash.branch, stash.date].filter(Boolean).join(" · ");
    const files = expanded && filesLoaded
      ? cachedFiles.map((file) => fileHtml(stash.ref, file, renderFileIcon)).join("")
      : "";
    const tooltip = disclosureTooltip(stash.message || stash.ref, expanded);
    return (
      `<div class="stash${expanded ? "" : " collapsed"}" data-ref="${esc(stash.ref)}" ` +
      `data-key="${esc(key)}" data-hash="${esc(stash.hash)}" ` +
      `data-msg="${esc(stash.message)}" data-files-loaded="${filesLoaded ? "true" : "false"}">` +
      `<div class="row stash-header" role="button" tabindex="0" ` +
      `data-disclosure-label="${esc(stash.message || stash.ref)}" ` +
      `title="${esc(tooltip)}" data-tooltip="${esc(tooltip)}" ` +
      `aria-label="${esc(tooltip)}" aria-expanded="${expanded ? "true" : "false"}">` +
      `<span class="twistie codicon ${chevron}"></span>` +
      `<span class="icon codicon codicon-archive"></span>` +
      `<span class="name">${esc(stash.message)}</span>` +
      (meta ? `<span class="stash-meta">${esc(meta)}</span>` : "") +
      `<span class="row-actions"><button class="row-action codicon codicon-ellipsis" ` +
      `type="button" data-act="stashMenu" title="${esc(T.moreActions)}" ` +
      `aria-label="${esc(T.moreActions)}"></button></span>` +
      `</div><div class="children stash-files">${files}</div></div>`
    );
  }

  /**
   * Stashes 섹션의 본문을 렌더하고 저장된 stash별 펼침 상태를 반영한다.
   * @param {object[]} stashes extension host가 보낸 stash 메타데이터 목록
   * @param {{expandedByKey?: Record<string, boolean>, fileIconHtml?: (path: string) => string}} context 렌더 의존성
   * @returns {string} 섹션 본문에 삽입할 stash 목록 또는 빈 상태 HTML
   */
  function body(stashes, context) {
    const rows = Array.isArray(stashes) ? stashes : [];
    renderFileIcon = context?.fileIconHtml || (() => "");
    const validKeys = new Set(rows.map(stashKey));
    for (const key of filesByKey.keys()) {
      if (!validKeys.has(key)) {
        filesByKey.delete(key);
      }
    }
    if (!rows.length) {
      return `<p class="empty">${esc(T.noStashes)}</p>`;
    }
    const expandedByKey = context?.expandedByKey || {};
    return rows.map((stash) => itemHtml(stash, expandedByKey, renderFileIcon)).join("");
  }

  /**
   * stash 관련 요청을 VS Code extension host 메시지 형식으로 전송한다.
   * @param {ReturnType<typeof acquireVsCodeApi>} vscode 웹뷰 메시지 API
   * @param {string} type host가 분기할 메시지 종류
   * @param {object} extra ref/path/message 등 요청별 추가 필드
   * @returns {void} 메시지만 전송하므로 반환값은 없다
   */
  function post(vscode, type, extra) {
    vscode.postMessage(Object.assign({ type }, extra));
  }

  /**
   * stash 헤더의 인라인 메뉴와 컨텍스트 메뉴가 공유할 액션 노드를 만든다.
   * @param {ReturnType<typeof acquireVsCodeApi>} vscode 웹뷰 메시지 API
   * @param {string} ref 액션 대상 stash ref
   * @param {string} message 삭제 확인 등에 사용할 stash 메시지
   * @returns {object[]} 공용 메뉴 렌더러가 소비하는 액션·구분선 노드 목록
   */
  function menuNodes(vscode, ref, message) {
    return [
      { label: T.applyStash, onClick: () => post(vscode, "applyStash", { ref }) },
      { label: T.popStash, onClick: () => post(vscode, "popStash", { ref }) },
      { separator: true },
      { label: T.branchStash, onClick: () => post(vscode, "branchStash", { ref }) },
      { separator: true },
      { label: T.dropStash, onClick: () => post(vscode, "dropStash", { ref, message }) },
    ];
  }

  /**
   * 아직 파일을 읽지 않은 stash 하나의 지연 조회를 host에 요청한다.
   * @param {HTMLElement | null} stash data-ref와 파일 로드 상태를 가진 stash 루트 요소
   * @param {ReturnType<typeof acquireVsCodeApi>} vscode 웹뷰 메시지 API
   * @returns {void} 중복 요청이면 아무 작업도 하지 않고 즉시 반환한다
   */
  function requestFiles(stash, vscode) {
    const key = stash?.dataset.key;
    if (
      !stash ||
      !key ||
      filesByKey.has(key) ||
      stash.dataset.filesLoading === "true" ||
      !stash.dataset.ref ||
      loadingKeys.has(key)
    ) {
      return;
    }
    loadingKeys.add(key);
    stash.dataset.filesLoading = "true";
    stash.setAttribute("aria-busy", "true");
    post(vscode, "loadStashFiles", {
      ref: stash.dataset.ref,
      stashKey: key,
    });
  }

  /**
   * 실제로 보이는 Stashes 섹션 안에서 펼쳐진 항목만 파일 지연 조회 대상으로 삼는다.
   * @param {HTMLElement} rootEl Changes 웹뷰 전체 렌더 루트
   * @param {ReturnType<typeof acquireVsCodeApi>} vscode 웹뷰 메시지 API
   * @returns {void} 조건을 만족하는 각 stash에 필요한 요청만 전송한다
   */
  function requestExpanded(rootEl, vscode) {
    rootEl
      .querySelectorAll('.section[data-section="stashes"]:not(.collapsed) .stash:not(.collapsed)')
      .forEach((stash) => requestFiles(stash, vscode));
  }

  /**
   * 웹뷰 메모리에 캐시한 파일 목록을 현재 펼쳐진 stash의 children 컨테이너에 그린다.
   * @param {HTMLElement} stash data-key와 data-ref를 가진 현재 렌더의 stash 요소
   * @returns {boolean} 캐시가 있어 파일 DOM을 갱신했으면 true, 아직 조회 전이면 false
   */
  function renderCachedFiles(stash) {
    const files = filesByKey.get(stash.dataset.key);
    const container = stash.querySelector(".stash-files");
    if (!files || !container) {
      return false;
    }
    container.innerHTML = files
      .map((file) => fileHtml(stash.dataset.ref, file, renderFileIcon))
      .join("");
    stash.dataset.filesLoaded = "true";
    if (webviewApi) {
      bindFiles(container, webviewApi);
    }
    return true;
  }

  /**
   * 사용자 입력으로 stash 한 건의 펼침 상태와 disclosure UI를 토글한다.
   * @param {HTMLElement} header 클릭 또는 키보드 입력을 받은 stash 헤더
   * @param {ReturnType<typeof acquireVsCodeApi>} vscode 웹뷰 상태·메시지 API
   * @param {object} state vscode.getState에서 복원한 Changes 웹뷰 상태
   * @returns {void} 상태와 DOM을 갱신하고 필요한 경우 파일 조회를 시작한다
   */
  function toggleItem(header, vscode, state) {
    const stash = header.closest(".stash");
    if (!stash) {
      return;
    }
    const key = stash.dataset.key || stash.dataset.ref || stash.dataset.hash;
    const expanded = state.stashExpanded[key] !== true;
    state.stashExpanded[key] = expanded;
    vscode.setState(state);
    stash.classList.toggle("collapsed", !expanded);
    syncDisclosure(header, expanded);
    const twistie = header.querySelector(".twistie");
    twistie?.classList.toggle("codicon-chevron-down", expanded);
    twistie?.classList.toggle("codicon-chevron-right", !expanded);
    if (expanded) {
      if (!renderCachedFiles(stash)) {
        requestFiles(stash, vscode);
      }
    } else {
      const container = stash.querySelector(".stash-files");
      if (container) {
        // 접힌 9k-file stash의 DOM을 즉시 버려 이후 layout/render 비용을 남기지 않는다.
        container.replaceChildren();
      }
    }
  }

  /**
   * stash disclosure 헤더에 포인터·키보드·우클릭 메뉴 동작을 연결한다.
   * @param {HTMLElement} rootEl 현재 Changes 웹뷰 렌더 루트
   * @param {ReturnType<typeof acquireVsCodeApi>} vscode 웹뷰 상태·메시지 API
   * @param {object} state stashExpanded를 포함하는 웹뷰 상태
   * @param {object} menus 공용 컨텍스트 메뉴를 여는 함수 모음
   * @returns {void} 현재 DOM의 각 stash 헤더에 이벤트를 등록한다
   */
  function bindHeaders(rootEl, vscode, state, menus) {
    rootEl.querySelectorAll(".stash-header").forEach((header) => {
      header.addEventListener("click", (event) => {
        if (!event.target.closest(".row-actions")) {
          toggleItem(header, vscode, state);
        }
      });
      header.addEventListener("keydown", (event) => {
        if ((event.key === "Enter" || event.key === " ") && event.target === header) {
          event.preventDefault();
          header.click();
        }
      });
      header.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const stash = header.closest(".stash");
        if (stash) {
          menus.openContextMenu?.(
            event.clientX,
            event.clientY,
            menuNodes(vscode, stash.dataset.ref, stash.dataset.msg)
          );
        }
      });
    });
  }

  /**
   * stash 행의 더 보기 버튼에 기존 공용 드롭다운의 열기/닫기 토글을 연결한다.
   * @param {HTMLElement} rootEl 현재 Changes 웹뷰 렌더 루트
   * @param {ReturnType<typeof acquireVsCodeApi>} vscode 웹뷰 메시지 API
   * @param {object} menus 공용 드롭다운 상태와 열기/닫기 함수 모음
   * @returns {void} 현재 DOM의 각 stash 메뉴 버튼에 이벤트를 등록한다
   */
  function bindActionMenus(rootEl, vscode, menus) {
    rootEl.querySelectorAll('.stash .row-action[data-act="stashMenu"]').forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const stash = button.closest(".stash");
        if (!stash) {
          return;
        }
        if (menus.isDropdownAnchor?.(button)) {
          menus.closeDropdown?.();
        } else {
          menus.openDropdown?.(
            button,
            menuNodes(vscode, stash.dataset.ref, stash.dataset.msg)
          );
        }
      });
    });
  }

  /**
   * 이미 조회되어 렌더된 stash 파일 행을 해당 stash 부모와의 diff 열기 요청에 연결한다.
   * @param {HTMLElement} rootEl 현재 Changes 웹뷰 렌더 루트
   * @param {ReturnType<typeof acquireVsCodeApi>} vscode 웹뷰 메시지 API
   * @returns {void} 파일 행 클릭 이벤트만 등록하므로 반환값은 없다
   */
  function bindFiles(rootEl, vscode) {
    rootEl.querySelectorAll(".stash-file").forEach((file) => {
      file.addEventListener("click", () =>
        post(vscode, "openStashFile", {
          ref: file.dataset.ref,
          path: file.dataset.path,
        })
      );
    });
  }

  /**
   * Stashes 섹션의 disclosure, 메뉴, 파일 diff 이벤트를 현재 렌더에 한 번에 연결한다.
   * @param {HTMLElement} rootEl Changes 웹뷰 전체 렌더 루트
   * @param {ReturnType<typeof acquireVsCodeApi>} vscode 웹뷰 상태·메시지 API
   * @param {{state: object, menus?: object}} context 저장 상태와 메인 웹뷰 공용 메뉴 표면
   * @returns {void} 이벤트를 연결한 뒤 저장 상태상 펼쳐진 항목의 지연 조회를 확인한다
   */
  function bind(rootEl, vscode, context) {
    webviewApi = vscode;
    const state = context?.state || {};
    state.stashExpanded = state.stashExpanded || {};
    const menus = context?.menus || {};
    bindHeaders(rootEl, vscode, state, menus);
    bindActionMenus(rootEl, vscode, menus);
    bindFiles(rootEl, vscode);
    requestExpanded(rootEl, vscode);
  }

  /**
   * host의 파일 조회 완료를 받아 hash 기반 캐시에 저장하고 현재 펼친 DOM에만 파일을 그린다.
   * @param {MessageEvent} event extension host가 웹뷰로 보낸 메시지 이벤트
   * @returns {void} stashFilesLoadComplete가 아닌 메시지는 그대로 무시한다
   */
  function handleHostMessage(event) {
    if (event.data?.type !== "stashFilesLoadComplete") {
      return;
    }
    const requestedKey = event.data.stashKey;
    const result = event.data.result;
    if (requestedKey) {
      loadingKeys.delete(requestedKey);
    }
    if (result?.key && Array.isArray(result.files)) {
      filesByKey.set(result.key, result.files);
    }
    document.querySelectorAll(".stash").forEach((stash) => {
      if (
        stash.dataset.key === requestedKey ||
        stash.dataset.ref === event.data.ref
      ) {
        delete stash.dataset.filesLoading;
        stash.removeAttribute("aria-busy");
      }
      if (result?.key === stash.dataset.key) {
        stash.dataset.filesLoaded = "true";
        if (!stash.classList.contains("collapsed")) {
          renderCachedFiles(stash);
        }
      }
    });
  }

  window.addEventListener("message", handleHostMessage);
  window.__gscStashes = { body, bind, requestExpanded };
})();
