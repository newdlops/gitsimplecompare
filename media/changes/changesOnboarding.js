// 저장소가 없는 Changes의 시작 화면. 기존 버튼·Codicon·테마 토큰을 재사용한다.
// - 입력·인증·Git 실행은 host가 담당하고 이 모듈은 상태 표시와 허용된 액션만 보낸다.
(function () {
  "use strict";
  const defaults = {
    onboardingTitle: "Start with Git Simple Compare",
    onboardingIntro: "Clone a repository, open an existing one, or start tracking this folder.",
    onboardingPreferences: "Your VS Code Git preferences stay unchanged.",
    onboardingClone: "Clone Repository…",
    onboardingGitHub: "Clone from GitHub…",
    onboardingOpen: "Open Repository…",
    onboardingInit: "Initialize Repository",
    onboardingCloneTooltip: "Clone a repository from a URL or SSH address",
    onboardingGitHubTooltip: "Choose a GitHub repository to clone",
    onboardingOpenTooltip: "Open an existing local Git repository",
    onboardingInitTooltip: "Initialize this folder or choose a folder to initialize",
    onboardingScanning: "Finding repositories…",
    onboardingRunning: "Setting up repository…",
    onboardingCloneRunning: "Cloning repository…",
    onboardingGitHubRunning: "Cloning from GitHub…",
    onboardingOpenRunning: "Opening repository…",
    onboardingInitRunning: "Initializing repository…",
    onboardingRetry: "Try Again",
    onboardingRetryTooltip: "Retry repository setup or refresh the repository list",
    onboardingDiagnose: "Check Git",
    onboardingDiagnoseTooltip: "Diagnose or select the Git executable",
    onboardingOpenCompleted: "Open Ready Repository",
    onboardingOpenCompletedTooltip: "Open the repository created in the previous step",
    onboardingComplete: "Repository ready.",
  };
  const actions = [
    ["clone", "repo-clone", "onboardingClone", "onboardingCloneTooltip"],
    ["github", "github", "onboardingGitHub", "onboardingGitHubTooltip"],
    ["open", "folder-opened", "onboardingOpen", "onboardingOpenTooltip"],
    ["init", "repo-create", "onboardingInit", "onboardingInitTooltip"],
  ];

  /**
   * 각 동작에 native 버튼·목적 tooltip과 표시 라벨에 일치하는 접근성 이름을 제공한다.
   * @param {string} action host의 허용된 액션 이름
   * @param {string} icon 기존 Codicon 이름
   * @param {string} label 표시 문구
   * @param {string} tooltip 작업의 목적을 설명할 문구
   * @param {boolean} disabled 입력이나 실제 작업이 진행 중인지 여부
   * @param {(value: unknown) => string} esc host 데이터도 안전하게 표시할 escaping 함수
   * @param {boolean} primary 기본 clone 동작인지 여부
   * @returns {string} 키보드로 조작할 수 있는 action 버튼 HTML
   */
  function button(action, icon, label, tooltip, disabled, esc, primary) {
    return '<button type="button" class="gsc-button ' + (primary ? "gsc-button--primary" : "gsc-button--secondary") +
      '" data-onboarding-action="' + esc(action) + '" title="' + esc(tooltip) + '" data-tooltip="' + esc(tooltip) +
      '" aria-label="' + esc(label) + '"' + (disabled ? " disabled" : "") + ">" +
      '<span class="codicon codicon-' + icon + '" aria-hidden="true"></span><span>' + esc(label) + "</span></button>";
  }

  /**
   * 조회·입력·진행·오류·완료 상태를 같은 작은 시작 화면에서 표시한다.
   * @param {object} state host의 실제 온보딩 상태
   * @param {object} strings 현재 언어의 문자열 사전
   * @param {(value: unknown) => string} esc escaping 함수
   * @returns {string} 저장소가 없는 뷰의 완성된 HTML
   */
  function render(state, strings, esc) {
    const T = Object.assign({}, defaults, strings);
    const phase = state?.phase || "idle";
    const busy = phase === "scanning" || phase === "running";
    const busyReason = phase === "scanning" ? T.onboardingScanning : T.onboardingRunning;
    let feedback = "";
    if (busy) {
      const running = {
        clone: T.onboardingCloneRunning, github: T.onboardingGitHubRunning,
        open: T.onboardingOpenRunning, init: T.onboardingInitRunning,
      };
      feedback = '<div class="gsc-onboarding-feedback" role="status" aria-live="polite">' +
        '<span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>' +
        '<span>' + esc(phase === "scanning" ? T.onboardingScanning : running[state.action] || T.onboardingRunning) + "</span></div>";
    } else if (phase === "error") {
      feedback = '<div class="gsc-onboarding-error" role="alert"><span class="codicon codicon-warning" aria-hidden="true"></span>' +
        '<p>' + esc(state.message || T.onboardingRetry) + "</p></div>" +
        '<div class="gsc-onboarding-recovery">' +
        button("retry", "refresh", T.onboardingRetry, T.onboardingRetryTooltip, false, esc, false) +
        button("diagnose", "tools", T.onboardingDiagnose, T.onboardingDiagnoseTooltip, false, esc, false) + "</div>";
    } else if (phase === "complete") {
      feedback = '<div class="gsc-onboarding-feedback" role="status"><span class="codicon codicon-pass" aria-hidden="true"></span>' +
        '<span>' + esc(state.message || T.onboardingComplete) + "</span></div>" +
        (state.repositoryRoot ? '<p class="gsc-onboarding-path" title="' + esc(state.repositoryRoot) + '">' +
          esc(state.repositoryRoot) + "</p>" + button("openCompleted", "folder-opened", T.onboardingOpenCompleted,
            T.onboardingOpenCompletedTooltip, false, esc, false) : "");
    }
    return '<main class="gsc-onboarding" aria-labelledby="gsc-onboarding-title" aria-busy="' + busy + '">' +
      '<span class="gsc-onboarding-mark codicon codicon-repo" aria-hidden="true"></span>' +
      '<h1 id="gsc-onboarding-title">' + esc(T.onboardingTitle) + "</h1>" +
      '<p class="gsc-onboarding-intro">' + esc(T.onboardingIntro) + "</p>" + feedback +
      '<div class="gsc-onboarding-actions">' +
      actions.map(([action, icon, label, tooltip], index) => button(action, icon, T[label],
        busy ? T[tooltip] + ". " + busyReason : T[tooltip], busy, esc, index === 0)).join("") +
      '</div><p class="gsc-onboarding-note">' + esc(T.onboardingPreferences) + "</p></main>";
  }

  /**
   * DOM에 표시한 고정 액션만 host로 보내고 busy 중의 연타는 차단한다.
   * @param {HTMLElement} root 실제 Changes root
   * @param {(type: string, payload?: object) => void} post 기존 webview 메시지 전송 함수
   * @param {object} state 현재 host의 상태. retry 대상은 host가 확정한 액션만 사용한다.
   */
  function bind(root, post, state) {
    root.querySelectorAll("[data-onboarding-action]").forEach(control => {
      control.addEventListener("click", () => {
        if (control.disabled) return;
        const action = control.dataset.onboardingAction;
        if (actions.some(item => item[0] === action)) post("repositorySetup", { action });
        else if (action === "retry") {
          if (actions.some(item => item[0] === state?.action)) post("repositorySetup", { action: state.action });
          else post("repositorySetupRetry");
        } else if (action === "diagnose") post("repositorySetupDiagnose");
        else if (action === "openCompleted") post("repositorySetupOpenCompleted");
      });
    });
  }

  /**
   * 기존 저장소 행의 표시 규칙을 재사용해 온보딩 종료 후 동일한 목록으로 전환한다.
   * @param {object[]} repositories host에서 확정한 저장소 목록
   * @param {object} T 현재 언어 사전
   * @param {(value: unknown) => string} esc escaping 함수
   * @returns {string} 기존 Repositories 섹션의 행 HTML
   */
  function repositoriesHtml(repositories, T, esc) {
    if (!repositories.length) return '<p class="empty">' + esc(T.noRepos) + "</p>";
    return repositories.map(repository =>
      '<div class="row repo' + (repository.active ? " active" : "") + '" role="button" tabindex="0" ' +
      'data-root="' + esc(repository.root) + '" title="' + esc(repository.root) + '" aria-label="' +
      esc(T.change + ": " + repository.name) + '">' +
      '<span class="icon codicon ' + (repository.active ? "codicon-pass-filled" : "codicon-repo") + '" aria-hidden="true"></span>' +
      '<span class="name">' + esc(repository.name) + "</span>" +
      (repository.branch ? '<span class="branch"><span class="codicon codicon-git-branch" aria-hidden="true"></span>' + esc(repository.branch) + "</span>" : "") +
      (repository.active ? '<span class="badge">' + esc(T.current) + "</span>" : "") + "</div>"
    ).join("");
  }

  window.__gscChangesOnboarding = { defaults, render, bind, repositoriesHtml };
})();
