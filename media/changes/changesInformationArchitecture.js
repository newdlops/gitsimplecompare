// Changes sidebar의 기존 accordion을 제품 우선순위에 맞는 세 영역으로 묶는다.
// - section 자체와 기존 event listener를 보존해 Git 상태 갱신·resize·drag 계약을 바꾸지 않는다.
(function () {
  "use strict";

  const GROUPS = [
    { id: "repository", sections: ["repos"], label: "repositoryContext" },
    { id: "working", sections: ["changes"], label: "workingChanges" },
    { id: "tools", sections: ["history", "compare", "stashes", "worktrees"], label: "tools" },
  ];

  /** 현재 root의 최상위 section을 Repository/Working Changes/Tools landmark로 재배치한다. */
  function organize(root, strings) {
    const sections = Array.from(root.children).filter((node) => node.classList?.contains("section"));
    if (!sections.length) return;
    const byId = new Map(sections.map((section) => [section.dataset.section, section]));
    GROUPS.forEach((group) => {
      const region = document.createElement("section");
      region.className = `changes-region changes-region--${group.id}`;
      region.dataset.changesRegion = group.id;
      region.setAttribute("aria-labelledby", `changes-region-${group.id}`);
      const heading = document.createElement("h2");
      heading.className = "changes-region__title";
      heading.id = `changes-region-${group.id}`;
      heading.textContent = strings[group.label] || "";
      region.append(heading);
      sections.filter((section) => group.sections.includes(section.dataset.section)).forEach((section) => region.append(section));
      root.append(region);
    });
  }

  /** 두 section이 같은 정보 영역에 있을 때만 사용자가 순서를 바꿀 수 있는지 판단한다. */
  function sameRegion(first, second) {
    return Boolean(first && second && first.parentElement === second.parentElement && first.parentElement?.dataset.changesRegion);
  }

  window.__gscChangesInformationArchitecture = { organize, sameRegion };
}());
