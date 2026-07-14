// AI 커밋 플랜 실행 상태 전용 웹뷰 클라이언트.
// - extension host의 실행 진행 메시지를 카드별 준비 상태와 접근 가능한 진행률로 표현한다.
// - 커밋 hook 실패 정보를 안전한 textContent DOM으로 구성해 계획 안에서 바로 확인하게 한다.
(function () {
  "use strict";

  const statusEl = document.getElementById("execution-status");
  const countEl = document.getElementById("execution-count");
  const barEl = document.getElementById("execution-bar");
  const liveEl = document.getElementById("execution-live");
  const failureEl = document.getElementById("execution-failure");

  const T = Object.assign(
    {
      executionTitle: "Commit plan execution",
      preparedCount: "{0} of {1} commits prepared",
      preparingCommit: "Preparing commit {0} of {1}",
      preparedState: "Prepared",
      pendingState: "Pending",
      hookFailedState: "Hook failed",
      failedState: "Failed",
      completeState: "Complete",
      hookFailureTitle: "Commit hook failed",
      hookFailureAtCommit: "Commit {0} hook failed",
      executionFailureTitle: "Commit plan execution failed",
      executionFailureAtCommit: "Commit {0} failed",
      noFailureDetails: "No additional failure details were reported.",
      failureItemsTruncated: "{0} additional diagnostic item(s) omitted.",
      branchPreserved: "The real branch and Git index were preserved.",
    },
    window.__gscCommitPlanI18n || {}
  );

  const execution = {
    active: false,
    prepared: 0,
    total: 0,
    activeIndex: -1,
  };

  /**
   * `{0}`, `{1}` 형태의 순서형 placeholder를 전달된 값으로 치환한다.
   * 지역화 문자열에 일부 placeholder가 없어도 원문을 유지해 안전하게 표시하기 위함이다.
   * @param {unknown} template 지역화 문자열 또는 문자열로 바꿀 값
   * @param {...unknown} values placeholder 순서에 대응하는 치환 값
   * @returns {string} 모든 알려진 placeholder를 치환한 사용자 표시 문자열
   */
  function fmt(template) {
    const values = Array.prototype.slice.call(arguments, 1);
    return values.reduce(function replacePlaceholder(result, value, index) {
      return result.replaceAll(`{${index}}`, String(value));
    }, String(template == null ? "" : template));
  }

  /**
   * 알 수 없는 값이 배열이 아닌 일반 객체인지 확인한다.
   * host 메시지와 hook 진단을 신뢰하지 않고 필드 접근 전에 구조를 좁히는 데 사용한다.
   * @param {unknown} value 검사할 임의의 값
   * @returns {boolean} null/배열이 아닌 객체이면 true
   */
  function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /**
   * 알 수 없는 값을 화면에 넣을 수 있는 문자열로 정규화한다.
   * null과 undefined는 빈 문자열로 처리해 진단 영역에 불필요한 문구가 노출되지 않게 한다.
   * @param {unknown} value 변환할 값
   * @returns {string} 안전하게 정규화된 문자열
   */
  function text(value) {
    return typeof value === "string" ? value : value == null ? "" : String(value);
  }

  /**
   * 숫자 후보를 0 이상의 유한 정수로 변환하고 유효하지 않으면 대체값을 사용한다.
   * 진행 메시지가 지연되거나 부분적으로 누락돼도 progressbar 범위가 깨지지 않도록 한다.
   * @param {unknown} value host가 전달한 숫자 후보
   * @param {number} fallback 변환할 수 없을 때 사용할 값
   * @returns {number} 0 이상의 정수
   */
  function nonNegativeInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
  }

  /**
   * 현재 DOM에 렌더된 커밋 그룹 카드를 계획 순서대로 반환한다.
   * 메인 클라이언트가 계획을 다시 그릴 수 있으므로 카드 목록을 캐시하지 않고 매번 조회한다.
   * @returns {HTMLElement[]} data-index가 있는 커밋 그룹 카드 배열
   */
  function groupCards() {
    return Array.from(document.querySelectorAll(".commit-group[data-index]"));
  }

  /**
   * 커밋 카드의 data-index를 유효한 정수로 읽고 실패하면 DOM 순서를 사용한다.
   * 향후 카드 DOM이 재정렬돼도 host의 계획 순서와 실행 상태를 일치시키기 위함이다.
   * @param {HTMLElement} card 상태를 적용할 커밋 카드
   * @param {number} fallback 카드의 현재 DOM 순서
   * @returns {number} 상태 계산에 사용할 0 기반 그룹 인덱스
   */
  function cardIndex(card, fallback) {
    return nonNegativeInteger(card.dataset.index, fallback);
  }

  /**
   * 실행 상태에 대응하는 codicon 이름과 지역화 label을 계산한다.
   * icon은 장식용으로 숨기고 label을 별도로 둬 보조 기술에도 동일한 의미를 전달한다.
   * @param {string} state pending/active/prepared/hookFailed/failed/complete 중 하나
   * @param {number} index 카드의 0 기반 계획 순서
   * @returns {{icon: string, label: string}} chip 렌더링 정보
   */
  function statePresentation(state, index) {
    if (state === "active") {
      return {
        icon: "codicon-loading codicon-modifier-spin",
        label: fmt(T.preparingCommit, index + 1, Math.max(execution.total, 1)),
      };
    }
    if (state === "prepared") {
      return { icon: "codicon-pass", label: text(T.preparedState) };
    }
    if (state === "hookFailed") {
      return { icon: "codicon-error", label: text(T.hookFailedState) };
    }
    if (state === "failed") {
      return { icon: "codicon-error", label: text(T.failedState) };
    }
    if (state === "complete") {
      return { icon: "codicon-check-all", label: text(T.completeState) };
    }
    return { icon: "codicon-circle-large-outline", label: text(T.pendingState) };
  }

  /**
   * 그룹 제목에 실행 상태 chip을 찾거나 새로 만들어 반환한다.
   * 계획 카드 렌더러를 수정하지 않고 실행 모듈이 독립적으로 상태 UI를 붙일 수 있게 한다.
   * @param {HTMLElement} card chip을 포함할 커밋 카드
   * @returns {HTMLElement | null} 생성하거나 찾은 chip, 제목이 없으면 null
   */
  function ensureStateChip(card) {
    const heading = card.querySelector(".group-heading");
    if (!heading) {
      return null;
    }
    let chip = heading.querySelector(".group-execution-state");
    if (!chip) {
      chip = document.createElement("span");
      chip.className = "group-execution-state";
      const icon = document.createElement("span");
      icon.className = "codicon";
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "group-execution-state-label";
      chip.append(icon, label);
      heading.appendChild(chip);
    }
    return chip;
  }

  /**
   * 카드 한 건에 실행 상태 dataset, chip icon, label을 함께 적용한다.
   * CSS 시각 효과와 스크린리더 텍스트가 같은 상태에서 파생되도록 한 곳에서 갱신한다.
   * @param {HTMLElement} card 상태를 변경할 커밋 카드
   * @param {string} state pending/active/prepared/hookFailed/failed/complete 상태
   * @param {number} index 카드의 0 기반 계획 순서
   * @returns {void}
   */
  function setCardState(card, state, index) {
    card.dataset.executionState = state;
    if (state === "active") {
      card.setAttribute("aria-current", "step");
    } else {
      card.removeAttribute("aria-current");
    }
    const chip = ensureStateChip(card);
    if (!chip) {
      return;
    }
    chip.dataset.state = state;
    const presentation = statePresentation(state, index);
    const icon = chip.querySelector(".codicon");
    const label = chip.querySelector(".group-execution-state-label");
    if (icon) {
      icon.className = `codicon ${presentation.icon}`;
    }
    if (label) {
      label.textContent = presentation.label;
    }
    chip.title = presentation.label;
    chip.setAttribute("aria-label", presentation.label);
  }

  /**
   * 준비 개수와 현재 실행 인덱스를 기준으로 모든 카드 상태를 다시 계산한다.
   * completed 단계 전에는 prepared를 실제 커밋 완료로 오해하지 않도록 별도 상태를 유지한다.
   * @param {number} prepared 임시 저장소에서 준비·검증까지 끝난 그룹 수
   * @param {number} activeIndex 현재 준비 중인 그룹의 0 기반 인덱스, 없으면 -1
   * @returns {void}
   */
  function renderCardProgress(prepared, activeIndex) {
    groupCards().forEach(function renderCard(card, domIndex) {
      const index = cardIndex(card, domIndex);
      const state = index < prepared
        ? "prepared"
        : index === activeIndex
          ? "active"
          : "pending";
      setCardState(card, state, index);
    });
  }

  /**
   * 진행률 요소의 숫자, 접근성 속성, CSS custom property를 동기화한다.
   * progressbar가 div 또는 progress 중 어느 마크업이어도 브라우저와 CSS가 상태를 읽게 한다.
   * @param {number} prepared 준비·검증을 마친 그룹 수
   * @param {number} total 전체 계획 그룹 수
   * @returns {void}
   */
  function renderProgressBar(prepared, total) {
    if (!barEl) {
      return;
    }
    const safeTotal = Math.max(total, 0);
    const safePrepared = Math.min(Math.max(prepared, 0), safeTotal);
    const percent = safeTotal > 0 ? (safePrepared / safeTotal) * 100 : 0;
    const valueText = fmt(T.preparedCount, safePrepared, safeTotal);
    barEl.setAttribute("role", "progressbar");
    barEl.setAttribute("aria-valuemin", "0");
    barEl.setAttribute("aria-valuemax", String(safeTotal));
    barEl.setAttribute("aria-valuenow", String(safePrepared));
    barEl.setAttribute("aria-valuetext", valueText);
    barEl.style.setProperty("--execution-progress", `${percent}%`);
    barEl.dataset.progress = String(percent);
    if (barEl instanceof HTMLProgressElement) {
      barEl.max = Math.max(safeTotal, 1);
      barEl.value = safePrepared;
    }
  }

  /**
   * 실행 영역의 prepared/total 표시와 aria-live 설명을 한 번에 갱신한다.
   * 시각적 카운터와 보조 기술 알림이 동일한 진행 상태를 전달하도록 한다.
   * @param {string} liveMessage 현재 작업을 설명할 지역화 메시지
   * @returns {void}
   */
  function renderExecutionSummary(liveMessage) {
    const count = fmt(T.preparedCount, execution.prepared, execution.total);
    if (countEl) {
      countEl.textContent = count;
    }
    if (liveEl) {
      liveEl.textContent = liveMessage || count;
    }
    renderProgressBar(execution.prepared, execution.total);
  }

  /**
   * 이전 hook 또는 실행 실패 진단 DOM을 비우고 숨긴다.
   * 새 계획 실행에서 과거 실패가 남아 사용자를 혼동시키지 않도록 시작/reset에 호출한다.
   * @returns {void}
   */
  function clearFailure() {
    if (!failureEl) {
      return;
    }
    failureEl.replaceChildren();
    failureEl.hidden = true;
  }

  /**
   * context/plan 변경 시 실행 전용 UI와 카드 chip을 초기 상태로 되돌린다.
   * 새 계획에는 이전 계획의 prepared/failed 상태가 이어지지 않아야 하므로 완전히 제거한다.
   * @returns {void}
   */
  function resetExecution() {
    execution.active = false;
    execution.prepared = 0;
    execution.total = 0;
    execution.activeIndex = -1;
    if (statusEl) {
      statusEl.hidden = true;
      statusEl.removeAttribute("data-execution-state");
      statusEl.setAttribute("aria-label", text(T.executionTitle));
    }
    if (countEl) {
      countEl.textContent = "";
    }
    if (liveEl) {
      liveEl.textContent = "";
    }
    clearFailure();
    groupCards().forEach(function clearCardState(card) {
      card.removeAttribute("data-execution-state");
      const chip = card.querySelector(".group-execution-state");
      if (chip) {
        chip.remove();
      }
    });
    renderProgressBar(0, 0);
  }

  /**
   * 실패 뒤 사용자가 메시지·파일 배치·그룹 순서를 바꾸면 과거 실행 표시를 즉시 지운다.
   * 새 계획 DOM에 이전 prepared/failed 번호가 붙거나 다음 검증 오류가 과거 그룹을 가리키지 않게 한다.
   * @param {Event} event 계획 편집 컨트롤에서 bubble된 input/change/click 이벤트
   * @returns {void}
   */
  function resetAfterPlanMutation(event) {
    if (execution.active || execution.total === 0) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const mutatingControl = target.closest(
      ".commit-group textarea, .file-destination, .order-actions button"
    );
    if (mutatingControl) {
      resetExecution();
    }
  }

  /**
   * 승인된 계획 실행 시작을 표시하고 모든 그룹을 pending으로 초기화한다.
   * host의 total이 없을 때는 현재 카드 개수를 사용해 오래된 host와도 안전하게 동작한다.
   * @param {Record<string, unknown>} message executionStarted host 메시지
   * @returns {void}
   */
  function startExecution(message) {
    execution.active = true;
    execution.prepared = 0;
    execution.total = nonNegativeInteger(message.total, groupCards().length);
    execution.activeIndex = -1;
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.executionState = "running";
      statusEl.setAttribute("aria-label", text(T.executionTitle));
    }
    clearFailure();
    renderCardProgress(0, -1);
    renderExecutionSummary(fmt(T.preparedCount, 0, execution.total));
  }

  /**
   * host 진행 메시지의 current/step을 prepared 수와 active 카드로 해석해 반영한다.
   * current는 실제 branch 커밋 수가 아니라 private 준비·검증 완료 개수라는 의미를 보존한다.
   * @param {Record<string, unknown>} message executionProgress host 메시지
   * @returns {void}
   */
  function updateExecution(message) {
    const progress = isObject(message.progress) ? message.progress : {};
    const cards = groupCards();
    execution.total = nonNegativeInteger(progress.total, execution.total || cards.length);
    if (text(progress.phase) === "complete") {
      completeExecution({ message: T.completeState });
      return;
    }
    execution.active = true;
    execution.prepared = Math.min(
      nonNegativeInteger(progress.current, execution.prepared),
      execution.total
    );
    const step = text(progress.step);
    execution.activeIndex = step === "started" && execution.prepared < execution.total
      ? execution.prepared
      : -1;
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.executionState = "running";
    }
    renderCardProgress(execution.prepared, execution.activeIndex);
    const hostMessage = text(progress.message).trim();
    const liveMessage = step === "started"
      ? fmt(
          T.preparingCommit,
          execution.prepared + 1,
          execution.total,
          hostMessage
        )
      : step === "completed"
        ? fmt(T.preparedCount, execution.prepared, execution.total)
        : hostMessage || fmt(T.preparedCount, execution.prepared, execution.total);
    renderExecutionSummary(liveMessage);
  }

  /**
   * hook 진단 item 한 건을 경로/위치/검사명/메시지 순서의 한 줄 텍스트로 만든다.
   * 다양한 hook 출력 parser가 만든 필드 이름을 수용하되 객체 자체를 직렬화해 노출하지 않는다.
   * @param {unknown} item 문자열 또는 구조화된 진단 객체
   * @returns {string} 목록에 표시할 한 줄 진단, 표시할 정보가 없으면 빈 문자열
   */
  function failureItemText(item) {
    if (!isObject(item)) {
      return text(item).trim();
    }
    const path = text(item.path || item.file || item.filePath).trim();
    const line = nonNegativeInteger(item.line, -1);
    const column = nonNegativeInteger(item.column, -1);
    const location = path
      ? `${path}${line >= 0 ? `:${line}${column >= 0 ? `:${column}` : ""}` : ""}`
      : "";
    const check = text(item.checkName || item.rule || item.code).trim();
    const detail = text(item.message || item.summary || item.text).trim();
    return [location, check, detail].filter(Boolean).join(" — ");
  }

  /**
   * hook/실행 실패를 제목, 검사 식별자, 요약, 진단 목록, branch 보존 안내로 렌더한다.
   * 모든 외부 문자열은 textContent로만 삽입해 hook 출력에 HTML이 있어도 실행되지 않게 한다.
   * @param {string} fallbackMessage generic error 메시지
   * @param {unknown} value 구조화된 failure payload
   * @returns {void}
   */
  function renderFailure(fallbackMessage, value) {
    if (!failureEl) {
      return;
    }
    const failure = isObject(value) ? value : {};
    const likelyHook = failure.likelyHook === true;
    const title = document.createElement("h3");
    title.className = "execution-failure-title";
    const titleIcon = document.createElement("span");
    titleIcon.className = "codicon codicon-error";
    titleIcon.setAttribute("aria-hidden", "true");
    const titleText = execution.activeIndex >= 0
      ? fmt(
          likelyHook ? T.hookFailureAtCommit : T.executionFailureAtCommit,
          execution.activeIndex + 1
        )
      : likelyHook
        ? text(T.hookFailureTitle)
        : text(T.executionFailureTitle);
    title.append(
      titleIcon,
      document.createTextNode(titleText)
    );

    const identityValues = [failure.hookName, failure.checkName]
      .map(text)
      .map(function trimIdentity(valueText) {
        return valueText.trim();
      })
      .filter(Boolean);
    const identity = document.createElement("div");
    identity.className = "execution-failure-identity";
    identity.textContent = Array.from(new Set(identityValues)).join(" · ");
    identity.hidden = identity.textContent.length === 0;

    const summary = document.createElement("p");
    summary.className = "execution-failure-summary";
    summary.textContent =
      text(failure.summary).trim() || fallbackMessage.trim() || text(T.noFailureDetails);

    const items = Array.isArray(failure.items)
      ? failure.items.map(failureItemText).filter(Boolean)
      : [];
    const list = document.createElement("ul");
    list.className = "execution-failure-diagnostics";
    list.hidden = items.length === 0;
    items.forEach(function appendFailureItem(item) {
      const row = document.createElement("li");
      row.textContent = item;
      list.appendChild(row);
    });

    const truncatedCount = typeof failure.truncated === "number"
      ? nonNegativeInteger(failure.truncated, 0)
      : failure.truncated === true
        ? "1+"
        : 0;
    const truncated = document.createElement("p");
    truncated.className = "execution-failure-preserved execution-failure-truncated";
    truncated.textContent = fmt(T.failureItemsTruncated, truncatedCount);
    truncated.hidden = truncatedCount === 0;

    const preserved = document.createElement("p");
    preserved.className = "execution-failure-preserved execution-branch-preserved";
    preserved.textContent = text(T.branchPreserved);
    preserved.hidden = !likelyHook;

    failureEl.replaceChildren(title, identity, summary, list, truncated, preserved);
    failureEl.hidden = false;
  }

  /**
   * execute 오류에서 현재 active 카드를 failed로 바꾸고 구조화된 진단을 표시한다.
   * active 카드가 없으면 카드 상태를 억지로 추정하지 않고 계획 수준 실패로만 보여준다.
   * @param {Record<string, unknown>} message operation/message/failure가 포함된 error 메시지
   * @returns {void}
   */
  function failExecution(message) {
    execution.active = false;
    if (execution.activeIndex >= 0) {
      const cards = groupCards();
      const failedCard = cards.find(function findActiveCard(card, domIndex) {
        return cardIndex(card, domIndex) === execution.activeIndex;
      });
      if (failedCard) {
        setCardState(
          failedCard,
          message.failure?.likelyHook === true ? "hookFailed" : "failed",
          execution.activeIndex
        );
      }
    }
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.executionState = "failed";
    }
    renderFailure(text(message.message), message.failure);
    renderExecutionSummary(text(message.message) || text(T.executionFailureTitle));
  }

  /**
   * 실제 branch와 index에 모든 준비된 커밋 적용이 끝난 최종 성공 상태를 표시한다.
   * 이 메시지 전에는 complete를 사용하지 않아 private 검증과 실제 완료를 명확히 구분한다.
   * @param {Record<string, unknown>} message 완료 설명을 포함할 수 있는 host 메시지
   * @returns {void}
   */
  function completeExecution(message) {
    execution.active = false;
    execution.total = Math.max(execution.total, groupCards().length);
    execution.prepared = execution.total;
    execution.activeIndex = -1;
    groupCards().forEach(function completeCard(card, domIndex) {
      setCardState(card, "complete", cardIndex(card, domIndex));
    });
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.dataset.executionState = "complete";
    }
    clearFailure();
    renderExecutionSummary(text(message.message) || text(T.completeState));
  }

  /**
   * extension host 메시지 중 실행 시각화에 필요한 종류만 골라 상태 전이 함수로 전달한다.
   * 메인 commitPlan 클라이언트와 같은 message event를 구독하되 VS Code API를 별도로 획득하지 않는다.
   * @param {MessageEvent} event 웹뷰 window가 받은 host 메시지 이벤트
   * @returns {void}
   */
  function handleHostMessage(event) {
    const message = event.data;
    if (!isObject(message) || typeof message.type !== "string") {
      return;
    }
    if (message.type === "context" || message.type === "plan") {
      resetExecution();
      return;
    }
    if (message.type === "executionStarted") {
      startExecution(message);
      return;
    }
    if (message.type === "executionProgress") {
      updateExecution(message);
      return;
    }
    if (
      message.type === "error" &&
      message.operation === "execute" &&
      execution.active
    ) {
      failExecution(message);
      return;
    }
    if (message.type === "completed") {
      completeExecution(message);
    }
  }

  resetExecution();
  document.addEventListener("input", resetAfterPlanMutation);
  document.addEventListener("change", resetAfterPlanMutation);
  document.addEventListener("click", resetAfterPlanMutation);
  window.addEventListener("message", handleHostMessage);
})();
