// 브랜치·태그 표시 상태를 보관하고 같은 메시지가 화면 전체를 다시 계산하지 않게 한다.
(function () {
  "use strict";

  /**
   * JSON 형태의 표시 레코드를 비교한다. 객체 필드 순서는 무시하고 배열의 표시 순서는 보존한다.
   * @param left 이전 값 @param right 새 값 @returns 모든 필드와 값이 같으면 true
   */
  function equalValue(left, right) {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    if (Array.isArray(left) && left.length !== right.length) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key =>
      Object.prototype.hasOwnProperty.call(right, key) && equalValue(left[key], right[key]));
  }

  /** @param previous 이전 키/값 Map @param next 새 Map @returns 키와 모든 표시 데이터가 같으면 true */
  function equalMap(previous, next) {
    return previous.size === next.size && [...next].every(([key, value]) => previous.has(key) && equalValue(previous.get(key), value));
  }

  /** @param previous 이전 lookup @param next 새 lookup @returns 추가·삭제되거나 표시 데이터가 바뀐 키 집합 */
  function changedMapKeys(previous, next) {
    const keys = new Set();
    next.forEach((value, key) => { if (!previous.has(key) || !equalValue(previous.get(key), value)) keys.add(key); });
    if (keys.size || previous.size !== next.size) previous.forEach((_, key) => { if (!next.has(key)) keys.add(key); });
    return keys;
  }

  /**
   * 한 웹뷰의 상태를 만든다. 다른 패널이나 저장소 사이의 Git 조회 결과 캐시로 사용하지 않는다.
   * @returns 브랜치/색상/태그 lookup과 표시가 바뀌었는지 반환하는 갱신 함수
   */
  function createReferenceState() {
    let branchesReady = false, tagsReady = false;
    const state = { branches: new Map(), colors: new Map(), tags: new Map(), remoteTags: new Map(), changes: null, setLocalBranches, setLocalBranchIdentities, setTagStatus };

    /** 확인된 이름/OID/current만 받고 미확인 수치는 생략한다. 기존 상세는 이 최소 snapshot으로 교체한다. */
    function setLocalBranchIdentities(branches, message) {
      return setLocalBranches((branches || []).map(branch => ({ name: branch.name, hash: branch.hash,
        current: branch.current, detailsPending: true, pendingMessage: message })));
    }

    /** @param branches 확장이 보낸 전체 로컬 브랜치 상태 @returns 데이터 또는 실제 표시 색상이 바뀌면 true */
    function setLocalBranches(branches) {
      const next = new Map((branches || []).map(branch => [branch.name, branch]));
      const colors = new Map([...next.keys()].map(name => [name, window.GscGraphColors?.branchColor?.(name)]));
      const names = changedMapKeys(state.branches, next);
      const recordsChanged = !branchesReady || names.size > 0;
      const colorsChanged = !equalMap(state.colors, colors);
      const changed = recordsChanged || colorsChanged;
      // 팔레트나 브랜치 집합이 바뀌면 기존 색상 전파의 전체 갱신 경로를 유지한다.
      state.changes = !branchesReady || colorsChanged ? null
        : { keys: new Set([...names].map(name => `branch:${name}`)), hashes: new Set() };
      // 호출자가 수신 객체를 나중에 편집해도 이전 비교 기준이 바뀌지 않도록 복사한다.
      if (recordsChanged) state.branches = structuredClone(next);
      state.colors = colors; branchesReady = true;
      return changed;
    }

    /** @param tags 확장이 보낸 전체 태그 상태 @returns 레코드나 원격 배지의 해시/표시 순서가 바뀌면 true */
    function setTagStatus(tags) {
      const next = new Map(), remoteTags = new Map();
      (tags || []).forEach(tag => {
        next.set(tag.name, tag);
        (tag.remoteTargets || []).forEach(target => {
          const refs = remoteTags.get(target.hash) || [];
          refs.push({ name: tag.name, remote: target.remote, hash: target.hash });
          remoteTags.set(target.hash, refs);
        });
      });
      const names = changedMapKeys(state.tags, next), hashes = changedMapKeys(state.remoteTags, remoteTags);
      const recordsChanged = !tagsReady || names.size > 0;
      const changed = recordsChanged || hashes.size > 0;
      // 태그 이름은 로컬/명시적 원격 배지에, 해시는 동적으로 주입한 원격 배지의 이전·새 위치에 대응한다.
      state.changes = !tagsReady ? null : { keys: new Set([...names].map(name => `tag:${name}`)), hashes };
      if (recordsChanged) state.tags = structuredClone(next);
      state.remoteTags = remoteTags; tagsReady = true;
      return changed;
    }
    return state;
  }

  window.GscGraphReferenceState = createReferenceState;
})();
