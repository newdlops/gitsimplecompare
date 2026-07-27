// versioned webview.setState/getState를 좁은 data 계약으로 감싸는 persistence primitive.
// - unknown future version을 안전한 default로 버려 persisted UI state가 새 화면을 깨지 않게 한다.
(function () {
  "use strict";

  /** JSON-like value가 array가 아닌 object인지 판별한다. */
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /** surface별 version/default/migration과 VS Code API를 받아 state adapter를 만든다. */
  window.__gscPersistedState = function createPersistedState(options) {
    const version = options.version;
    const defaults = options.defaults;
    const api = options.api;

    /** raw persisted envelope을 현재 version data로 정규화한다. */
    function read() {
      const raw = api.getState?.();
      if (!isRecord(raw) || !Number.isInteger(raw.version) || !isRecord(raw.data)) return { ...defaults };
      if (raw.version === version) return { ...defaults, ...raw.data };
      if (raw.version > version) return { ...defaults };
      const migrated = options.migrate?.(raw.version, raw.data);
      return isRecord(migrated) ? { ...defaults, ...migrated } : { ...defaults };
    }

    /** current version envelope만 setState에 기록해 다음 open의 migration 출발점을 일정하게 한다. */
    function write(data) {
      const next = { version, data: { ...defaults, ...data } };
      api.setState?.(next);
      return next.data;
    }

    /** persisted state를 current defaults로 명시적으로 초기화한다. */
    function reset() {
      return write(defaults);
    }

    return { read, reset, write };
  };
}());
