// git graph 색상 계산 헬퍼.
// - 일반 레인 색과 local-only 브랜치 색을 한 곳에서 계산해 노드/간선/배지가 같은 색을 쓰게 한다.
(function () {
  "use strict";

  const LANE_FAMILY_HUES = [
    0, 210, 96, 276, 44, 178, 326, 136,
    242, 26, 190, 68, 346, 222, 154, 300,
  ];
  const LOCAL_ONLY_COLORS = [
    "#ff8a4c", "#00d7ff", "#a78bfa", "#2ee59d", "#ff4f8b", "#d0ff4f",
    "#4da3ff", "#ffd166", "#06d6a0", "#ef476f", "#9b5de5", "#00bbf9",
    "#f15bb5", "#fee440", "#8ac926", "#ff595e", "#1982c4", "#6a4c93",
    "#b5e48c", "#ffca3a", "#52b788", "#c77dff", "#fb8500", "#90dbf4",
  ];
  const MAX_STABLE_COMMIT_COLORS = 1024;
  const stableCommitColors = new Map();
  let stableColorScope = "";

  /**
   * 그래프가 다른 저장소나 완전히 겹치지 않는 커밋 창으로 전환될 때 고정 색상을 비운다.
   * 같은 저장소의 새로고침·페이지 변경은 기존 해시가 겹치므로 색상을 보존하고,
   * 더 이상 보이지 않는 창은 놓아 주어 제한된 캐시를 새 화면이 사용할 수 있게 한다.
   * @param scope 확장에서 전달한 저장소 식별자
   * @param rows 새 프레임에 표시할 그래프 행 목록
   */
  function beginStableColorFrame(scope, rows) {
    const nextScope = String(scope || "");
    if (nextScope && stableColorScope && stableColorScope !== nextScope) {
      stableCommitColors.clear();
    }
    if (nextScope) {
      stableColorScope = nextScope;
    }
    if (!stableCommitColors.size) {
      return;
    }
    let hasRealCommit = false;
    let hasCachedCommit = false;
    for (const row of rows || []) {
      if (!cacheableRow(row)) {
        continue;
      }
      hasRealCommit = true;
      if (stableCommitColors.has(row.hash)) {
        hasCachedCommit = true;
        break;
      }
    }
    if (hasRealCommit && !hasCachedCommit) {
      stableCommitColors.clear();
    }
  }

  /**
   * 실제 커밋 해시에 처음 보인 색상을 연결해 후속 GraphData 렌더에서도 그대로 반환한다.
   * local-only 같은 브랜치 의미 색상은 일반 레인색을 한 번만 대체할 수 있으며,
   * 가상 커밋은 현재 HEAD 레인을 따라야 하므로 저장하지 않는다.
   * 캐시는 상한에 도달하면 기존(먼저 본 최신) 커밋을 지키고 새 항목을 추가하지 않는다.
   * @param row 색상을 표시할 그래프 행
   * @param suggestedColor 현재 레이아웃과 브랜치 상태가 제안한 색상
   * @param semanticColor 브랜치 의미가 담긴 색상이면 true
   * @returns 같은 커밋에 고정된 최종 표시 색상
   */
  function stableRowColor(row, suggestedColor, semanticColor) {
    if (!cacheableRow(row)) {
      return suggestedColor;
    }
    const stored = stableCommitColors.get(row.hash);
    if (stored) {
      if (!stored.semantic && semanticColor) {
        stored.color = suggestedColor;
        stored.semantic = true;
      }
      return stored.color;
    }
    if (stableCommitColors.size < MAX_STABLE_COMMIT_COLORS) {
      stableCommitColors.set(row.hash, {
        color: suggestedColor,
        semantic: Boolean(semanticColor),
      });
    }
    return suggestedColor;
  }

  /** 장기 색상 식별자로 안전한 실제 커밋 행인지 판정한다. */
  function cacheableRow(row) {
    return Boolean(
      row?.hash &&
      row.kind !== "ongoing" &&
      row.kind !== "staged"
    );
  }

  /** 레인 색상 인덱스를 인접 lane 간 색상 계열이 겹치지 않게 변환한다. */
  function colorOf(index) {
    const safeIndex = Math.max(0, Math.floor(Math.abs(Number(index) || 0)));
    return generatedLaneColor(safeIndex);
  }

  /** 브랜치 이름을 안정적인 팔레트 인덱스로 바꾼다. */
  function hashText(text) {
    let hash = 0;
    const value = String(text || "local");
    for (let i = 0; i < value.length; i++) {
      hash = (hash * 31 + value.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  /** 색상 문자열을 비교 가능한 소문자 hex 로 정규화한다. */
  function normalizeColor(color) {
    return String(color || "").trim().toLowerCase();
  }

  /** 팔레트가 부족할 때도 lane 색상이 순환 반복되지 않도록 보조 색상을 만든다. */
  function generatedLaneColor(index) {
    const family = index % LANE_FAMILY_HUES.length;
    const cycle = Math.floor(index / LANE_FAMILY_HUES.length);
    const hue = (LANE_FAMILY_HUES[family] + cycle * 7) % 360;
    const saturation = 76 + (cycle % 3) * 4;
    const lightness = 58 + ((cycle + family) % 3) * 4;
    return hslToHex(hue, saturation, lightness);
  }

  /** 팔레트가 부족할 때도 브랜치별 색상이 겹치지 않도록 보조 색상을 만든다. */
  function generatedBranchColor(index) {
    const hue = Math.round((Number(index) || 0) * 137.508 + 71) % 360;
    return hslToHex(hue, 82, 62);
  }

  /** HSL 값을 hex 색상 문자열로 변환한다. */
  function hslToHex(hue, saturation, lightness) {
    const s = saturation / 100;
    const l = lightness / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] =
      hue < 60 ? [c, x, 0] :
      hue < 120 ? [x, c, 0] :
      hue < 180 ? [0, c, x] :
      hue < 240 ? [0, x, c] :
      hue < 300 ? [x, 0, c] : [c, 0, x];
    const hex = (value) => Math.round((value + m) * 255).toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }

  /** local branch 전용 팔레트에서 index 와 피해야 할 색상을 반영해 색을 고른다. */
  function branchPaletteColor(index, avoidedColor) {
    const avoided = normalizeColor(avoidedColor);
    const safeIndex = Math.max(0, Math.floor(Number(index) || 0));
    for (let offset = 0; offset < LOCAL_ONLY_COLORS.length + 8; offset++) {
      const next = safeIndex + offset;
      const color = next < LOCAL_ONLY_COLORS.length
        ? LOCAL_ONLY_COLORS[next]
        : generatedBranchColor(next - LOCAL_ONLY_COLORS.length);
      if (!avoided || !similarColor(color, avoided)) {
        return color;
      }
    }
    return generatedBranchColor(safeIndex + 17);
  }

  /** local-only 커밋을 포함하는 로컬 브랜치명에 맞는 별도 색상을 고른다. */
  function localOnlyColor(branches, baseIndex) {
    const branch = (branches || []).find(Boolean) || "local";
    return branchColor(branch, baseIndex);
  }

  /** 브랜치 이름에 맞는 안정적인 강조 색상을 반환한다. */
  function branchColor(branch, baseIndex) {
    const branchName = branch || "local";
    const base = normalizeColor(colorOf(baseIndex));
    const start = hashText(branchName) % LOCAL_ONLY_COLORS.length;
    return branchPaletteColor(start, base);
  }

  /** 커밋 row/노드에 표시할 최종 색상을 반환한다. */
  function rowColor(row) {
    return (row.localOnlyBranches || []).length ? localOnlyColor(row.localOnlyBranches, row.color) : colorOf(row.color);
  }

  /** 간선 색상을 반환한다. local-only 자식에서 시작한 간선은 로컬 전용 색으로 이어 보인다. */
  function edgeColor(edge, rows) {
    const from = rows?.[edge.fromRow];
    return from && (from.localOnlyBranches || []).length
      ? localOnlyColor(from.localOnlyBranches, from.color)
      : colorOf(edge.color);
  }

  /** 두 색이 같은 계열로 읽힐 만큼 hue 가 가까운지 판단한다. */
  function similarColor(a, b) {
    const first = hexToHsl(a);
    const second = hexToHsl(b);
    if (!first || !second) {
      return normalizeColor(a) === normalizeColor(b);
    }
    const hueDistance = Math.abs(first.h - second.h);
    const circularHueDistance = Math.min(hueDistance, 360 - hueDistance);
    return circularHueDistance < 34 && Math.abs(first.l - second.l) < 18;
  }

  /** hex 색상을 HSL 로 변환한다. */
  function hexToHsl(color) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(color || "").trim());
    if (!match) {
      return undefined;
    }
    const value = match[1];
    const r = parseInt(value.slice(0, 2), 16) / 255;
    const g = parseInt(value.slice(2, 4), 16) / 255;
    const b = parseInt(value.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) {
      return { h: 0, s: 0, l: l * 100 };
    }
    const s = d / (1 - Math.abs(2 * l - 1));
    const h =
      max === r ? 60 * (((g - b) / d) % 6) :
      max === g ? 60 * ((b - r) / d + 2) :
      60 * ((r - g) / d + 4);
    return { h: (h + 360) % 360, s: s * 100, l: l * 100 };
  }

  window.GscGraphColors = {
    beginStableColorFrame,
    colorOf,
    branchColor,
    branchPaletteColor,
    rowColor,
    stableRowColor,
    edgeColor,
  };
})();
