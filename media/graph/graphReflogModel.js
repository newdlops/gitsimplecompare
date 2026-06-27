// 그래프 reflog UI 의 관계/라벨 판단 모델.
// - reflog 항목이 현재 브랜치 흐름에 남아 있는지, 떨어진 복구 후보인지, 시간순 HEAD 기록인지 일관되게 해석한다.
(function () {
  "use strict";

  /** reflog 항목의 브랜치 흐름 상태를 UI 상태명으로 변환한다. */
  function flowState(entry) {
    if (entry?.flowStatus === "reachable") {
      return "flow";
    }
    if (entry?.flowStatus === "dropped") {
      return "dropped";
    }
    return "timeline";
  }

  /** 목록/그래프에 표시할 현재 위치 라벨을 만든다. */
  function relationLabel(entry, loaded) {
    const state = flowState(entry);
    if (state === "flow") {
      return loaded ? "HEAD flow" : "Reachable HEAD";
    }
    if (state === "dropped") {
      return loaded ? "Dropped state" : "Dropped state";
    }
    return loaded ? "HEAD timeline" : "HEAD timeline";
  }

  /** reflog 이벤트 종류를 짧은 사람이 읽는 라벨로 바꾼다. */
  function eventLabel(entry) {
    switch (entry?.eventKind) {
      case "commit":
        return "New commit";
      case "amend":
        return "Amended";
      case "rebase":
        return "Rebase reorder";
      case "reset":
        return "Reset move";
      case "checkout":
        return "Checkout";
      case "merge":
        return "Merge";
      case "pull":
        return "Pull";
      case "cherryPick":
        return "Cherry-pick";
      case "branch":
        return "Branch move";
      default:
        return "Reflog update";
    }
  }

  /** 이벤트 종류가 왜 생긴 reflog 인지 설명하는 짧은 의미를 반환한다. */
  function eventMeaning(entry) {
    switch (entry?.eventKind) {
      case "commit":
      case "merge":
      case "pull":
      case "cherryPick":
        return "Change was created at HEAD.";
      case "amend":
      case "rebase":
        return "HEAD history was replayed, reordered, or rewritten by rebase.";
      case "reset":
        return "HEAD was moved to another commit.";
      case "checkout":
      case "branch":
        return "HEAD or a branch pointer moved.";
      default:
        return "Git recorded a HEAD update.";
    }
  }

  /** amend/rebase/reset 처럼 기존 history 를 바꾸는 reflog 이벤트인지 판별한다. */
  function isHistoryChange(entry) {
    return entry?.eventKind === "amend" || entry?.eventKind === "rebase" || entry?.eventKind === "reset";
  }

  /** reflog commit 의 복구 상태 키를 안전하게 반환한다. */
  function recoveryKind(entry) {
    return entry?.recovery?.kind || "reachable";
  }

  /** reflog commit 의 복구 상태 라벨을 만든다. */
  function recoveryLabel(entry) {
    const kind = recoveryKind(entry);
    if (kind === "recoverable") return "Recoverable";
    if (kind === "expired") return "Expired";
    return "On branch";
  }

  /** 현재 브랜치 흐름과의 관계를 상세/tooltip 용 문장으로 만든다. */
  function relationSummary(entry, loaded) {
    const state = flowState(entry);
    const refs = currentRefNames(entry).join(", ");
    if (state === "flow") {
      const where = refs ? ` from ${refs}` : "";
      return `HEAD moved to a commit that is still reachable${where}.`;
    }
    if (state === "dropped") {
      const origin = originText(entry);
      return `HEAD moved to a commit that no current branch, remote, or tag contains${origin ? `; reflog links it to ${origin}` : ""}.`;
    }
    return "HEAD moved through this point in local reflog time order.";
  }

  /** 상세 뷰에서 복구 판단을 돕는 짧은 힌트를 만든다. */
  function recoveryHint(entry, loaded) {
    const state = flowState(entry);
    if (state === "flow") {
      return loaded
        ? "This HEAD state is already part of a reachable branch flow."
        : "Create a branch only if you need a named recovery point.";
    }
    if (state === "dropped") {
      return "Recover this HEAD state by creating a branch at the target commit before checkout or rebase.";
    }
    return "Use the HEAD transition order and message to decide whether this local point should be recovered.";
  }

  /** 그래프 row badge 에 넣을 가장 짧은 출처 라벨을 고른다. */
  function graphOriginLabel(entry) {
    const state = flowState(entry);
    const current = currentRefNames(entry);
    if (current.length) {
      return shortLabel(current[0]);
    }
    const move = entry?.checkoutMove;
    if (move?.from && !looksLikeHash(move.from)) {
      return shortLabel(`from ${move.from}`);
    }
    const local = branchSourceNames(entry, "local");
    if (local.length) {
      return shortLabel(local[0]);
    }
    const remote = branchSourceNames(entry, "remote");
    if (remote.length) {
      return shortLabel(remote[0]);
    }
    if (state === "timeline") {
      return "time";
    }
    if (move?.to && !looksLikeHash(move.to)) {
      return shortLabel(move.to);
    }
    return "";
  }

  /** branchSources 에서 표시할 브랜치 이름 목록을 고른다. */
  function branchSourceNames(entry, kind) {
    const names = [];
    (entry?.branchSources || []).forEach((source) => {
      if (source.kind === kind && source.name && !names.includes(source.name)) {
        names.push(source.name);
      }
    });
    return cappedNames(names);
  }

  /** currentRefs 에서 표시할 ref 이름 목록을 고른다. */
  function currentRefNames(entry, kind) {
    const names = [];
    (entry?.currentRefs || []).forEach((ref) => {
      if ((!kind || ref.kind === kind) && ref.name && !names.includes(ref.name)) {
        names.push(ref.name);
      }
    });
    return cappedNames(names);
  }

  /** reflog 출처 근거를 tooltip 용 긴 문자열로 만든다. */
  function provenanceTitle(entry) {
    const parts = [];
    const refs = currentRefNames(entry);
    const move = entry?.checkoutMove;
    if (refs.length) {
      parts.push(`currently reachable from ${refs.join(", ")}`);
    }
    if (move?.from || move?.to) {
      parts.push(`HEAD moved ${move.from || "unknown"} -> ${move.to || "unknown"}`);
    }
    (entry?.branchSources || []).forEach((source) => {
      parts.push(`${source.kind} branch ${source.name} via ${source.selector}: ${source.message || "reflog entry"}`);
    });
    return parts.join(" | ");
  }

  /** reflog 출처 근거를 그래프 marker tooltip 용 짧은 문자열로 만든다. */
  function provenanceText(entry) {
    const parts = [];
    const refs = currentRefNames(entry);
    const move = entry?.checkoutMove;
    if (refs.length) {
      parts.push(`reachable ${refs.join(", ")}`);
    }
    if (move?.from) {
      parts.push(`from ${move.from}`);
    }
    const local = branchSourceNames(entry, "local");
    if (local.length) {
      parts.push(`branch log ${local.join(", ")}`);
    }
    const remote = branchSourceNames(entry, "remote");
    if (remote.length) {
      parts.push(`remote log ${remote.join(", ")}`);
    }
    return parts.join("; ");
  }

  /** 상태별 항목 수를 목록 상단 요약용으로 계산한다. */
  function counts(entries) {
    return (entries || []).reduce((acc, entry) => {
      acc[flowState(entry)] += 1;
      return acc;
    }, { flow: 0, dropped: 0, timeline: 0 });
  }

  /** 표시할 이름 목록을 3개로 제한하고 초과 수를 +N 으로 접는다. */
  function cappedNames(names) {
    const visible = names.slice(0, 3);
    if (names.length > visible.length) {
      visible.push(`+${names.length - visible.length}`);
    }
    return visible;
  }

  /** dropped 상태에서 과거 접점으로 보여줄 짧은 출처 문구를 만든다. */
  function originText(entry) {
    const move = entry?.checkoutMove;
    if (move?.from && !looksLikeHash(move.from)) {
      return move.from;
    }
    const local = branchSourceNames(entry, "local");
    if (local.length) {
      return local.join(", ");
    }
    const remote = branchSourceNames(entry, "remote");
    if (remote.length) {
      return remote.join(", ");
    }
    return "";
  }

  /** raw hash 처럼 보이는 값은 브랜치명으로 표시하지 않기 위해 판별한다. */
  function looksLikeHash(value) {
    return /^[0-9a-f]{7,40}$/i.test(String(value || ""));
  }

  /** 좁은 그래프 badge 안에서 과하게 긴 라벨을 줄인다. */
  function shortLabel(value) {
    const text = String(value || "");
    return text.length > 22 ? `${text.slice(0, 19)}...` : text;
  }

  window.GscGraphReflogModel = {
    branchSourceNames,
    counts,
    currentRefNames,
    eventLabel,
    eventMeaning,
    flowState,
    graphOriginLabel,
    provenanceText,
    provenanceTitle,
    recoveryHint,
    recoveryKind,
    recoveryLabel,
    isHistoryChange,
    relationLabel,
    relationSummary,
  };
})();
