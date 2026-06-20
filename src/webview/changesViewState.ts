// Changes 웹뷰의 저장된 UI 상태를 현재 타입에 맞춰 정규화하는 유틸.
// - provider 본문에서 memento 호환 처리 코드를 분리해 렌더/메시지 책임을 줄인다.
import type { ViewModes, VisibleSections } from "./changesViewTypes";
import { VISIBLE_SECTIONS } from "./changesViewTypes";

/**
 * 저장된 보기 모드를 섹션별 묶음으로 정규화한다.
 * - 구버전(단일 전역 문자열 "tree"/"list")은 두 섹션에 동일하게 적용해 호환한다.
 * - 신버전(섹션별 객체)은 알 수 없는 값이면 "tree" 로 보정한다.
 * @param saved memento 에 저장돼 있던 원본 값(형식 불명)
 */
export function loadViewModes(saved: unknown): ViewModes {
  if (saved === "tree" || saved === "list") {
    return { compare: saved, changes: saved };
  }
  if (saved && typeof saved === "object") {
    const s = saved as Partial<ViewModes>;
    return {
      compare: s.compare === "list" ? "list" : "tree",
      changes: s.changes === "list" ? "list" : "tree",
    };
  }
  return { compare: "tree", changes: "tree" };
}

/**
 * 저장된 아코디언 섹션 표시 상태를 현재 섹션 목록에 맞춰 정규화한다.
 * - 새 섹션은 기본 표시로 추가하고, 모든 섹션이 숨겨진 오래된 상태면 Changes 를 되살린다.
 * @param saved memento 에 저장돼 있던 원본 값(형식 불명)
 */
export function loadVisibleSections(saved: unknown): VisibleSections {
  const result = {} as VisibleSections;
  const raw = saved && typeof saved === "object"
    ? (saved as Partial<VisibleSections>)
    : {};
  for (const section of VISIBLE_SECTIONS) {
    result[section] = raw[section] !== false;
  }
  if (!VISIBLE_SECTIONS.some((section) => result[section])) {
    result.changes = true;
  }
  return result;
}
