import type { Page } from "@playwright/test";
import { join } from "node:path";
import { mountGraphRenderer } from "./webviewHarness";

/**
 * 실제 보조 renderer와 5천 행·천 브랜치·250개 태그를 올린 뒤 명시한 CPU 지연을 적용한다.
 * @param page 검증할 Chromium 페이지 @param includeEdges 실제 선형 이력의 간선도 렌더할지 여부
 * @param cpuThrottleRate 기본 6배 지연. 별도 성능 비교에서는 1로 고정해 지연 없이 측정한다.
 * @param groupRows 기본 true. 과거 RowSync 단독 비교에서만 양쪽 DOM 구조를 기존 직접 행으로 고정한다.
 * @returns 배지/색상 호출 카운터가 준비되고 CPU 지연이 적용되면 완료한다.
 */
export async function mountReferenceGraph(page: Page, includeEdges = false, cpuThrottleRate = 6, groupRows = true): Promise<void> {
  await mountGraphRenderer(page);
  if (!groupRows) await page.evaluate(() => {
    // 과거 RowSync는 중첩 행을 지원하지 않는다. 이 단독 비교는 양쪽 모두 같은 기존 구조로 제한한다.
    (window as any).GscGraphRowGroups.append = (root: HTMLElement, fragment: DocumentFragment) => root.append(fragment);
  });
  for (const name of ["graphReferenceState.js", "graphFeatures.js", "graphLocalColors.js", "graphWorktrees.js"]) {
    await page.addScriptTag({ path: join(process.cwd(), "media/graph", name) });
  }
  await page.addStyleTag({ path: join(process.cwd(), "media/graph/graphWorktrees.css") });
  await page.evaluate((includeEdges) => {
    const w = window as any, count = 5000, hash = (index: number) => index.toString(16).padStart(40, "0");
    const branches = Array.from({ length: 1000 }, (_, index) => ({ name: `bench-${index}`, hash: hash(index),
      current: index === 0, upstream: "origin/main", ahead: index % 2, behind: 0, subject: `Branch ${index}`, dateIso: "2026-10-17T00:00:00Z" }));
    const tags = Array.from({ length: 250 }, (_, index) => ({ name: `release-${index}`, localHash: hash(index),
      remoteTargets: [{ remote: "origin", hash: hash(index) }] }));
    w.__referenceFixture = { branches, tags, badgeCalls: 0, resolverCalls: 0 };
    const rows = Array.from({ length: count }, (_, index) => ({ hash: hash(index), parents: index < count - 1 ? [hash(index + 1)] : [],
      refs: [...(index === 0 ? ["HEAD"] : []), ...(index < branches.length ? [`bench-${index}`] : []), ...(index < tags.length ? [`tag:release-${index}`] : [])],
      subject: `Commit ${index}: preserve responsive branch and tag updates`, authorName: "Fixture", authorEmail: "fixture@example.test",
      dateIso: "2026-10-17T00:00:00Z", color: 0, column: 0 }));
    w.__referenceFixture.rows = rows;
    const edges = includeEdges ? rows.slice(0, -1).map((_, index) => ({ fromRow: index, toRow: index + 1,
      column: 0, fromColumn: 0, toColumn: 0, color: 0 })) : [];
    w.__referenceFixture.edges = edges;
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data }));
    send({ type: "branchStatus", branches, worktrees: [] }); send({ type: "tagStatus", tags });
    send({ type: "graph", data: { rows, edges, laneCount: 1 },
      state: { loadedCount: count, hasMore: false, hasMoreBefore: false, loading: false, reset: true, colorScope: "/fixture/references" } });
    const refBadge = w.GscGraphFeatures.refBadge;
    w.GscGraphFeatures.refBadge = (...args: unknown[]) => { w.__referenceFixture.badgeCalls++; return refBadge(...args); };
    const resolver = w.GscGraphLocalColors.makeResolver;
    w.GscGraphLocalColors.makeResolver = (...args: unknown[]) => { w.__referenceFixture.resolverCalls++; return resolver(...args); };
  }, includeEdges);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottleRate });
}
