// 전체 diff 예산으로 지연된 본문을 명시 파일 요청으로 읽는다. 실패·취소 후 부분 선택을 허용하지 않는다.
(function () {
  "use strict";
  /** @param {object} options 기존 번역·escape·post 경계를 주입한다. @returns {object} 현재 세대의 파일 상세 상태 */
  function create({ T, esc, post }) {
    let generation;
    const loading = new Set(), errors = new Map();
    return {
      /** 새 전체 snapshot은 이전 파일 요청·오류를 모두 무효화한다. */
      reset(value) { generation = value; loading.clear(); errors.clear(); },
      /** 현재 snapshot 응답만 받으며 소비 완료한 파일의 로딩 상태를 해제한다. */
      receive(message) {
        if (message.generation !== generation) return false;
        loading.delete(message.path);
        if (message.type === "fileDetailsError") errors.set(message.path, message.message);
        else errors.delete(message.path);
        return true;
      },
      /** 지연 항목에는 로딩 또는 재시도 상태를 표시하고, 실제 본문을 받기 전에는 선택 UI를 만들지 않는다. */
      render(file, container) {
        if (!file.deferred) return false;
        const error = errors.get(file.path), label = error ? T.loadFileChanges : T.loadingFileChanges;
        container.innerHTML = `<p class="empty" role="${error ? "alert" : "status"}">${esc(error || label)}</p>` +
          (error ? `<button type="button" class="gsc-button" title="${esc(label)}" aria-label="${esc(label)}">${esc(label)}</button>` : "");
        /** 같은 파일의 중복 조회를 막고 재시도는 사용자의 버튼 동작에 연결한다. */
        const request = () => {
          if (loading.has(file.path)) return;
          errors.delete(file.path); loading.add(file.path);
          post({ type: "loadFileDetails", path: file.path, generation });
          this.render(file, container);
        };
        if (error) container.querySelector("button").addEventListener("click", request);
        else if (!loading.has(file.path)) request();
        return true;
      },
    };
  }
  window.__gscSplitDeferredFiles = { create };
})();
