import type { Browser, Page } from "@playwright/test";
import { Uri } from "./vscodeMock";
import { benchmarkOverrides as mock } from "./benchmarkOverrides";
import { lifecycleResourceUri, createLifecycleSurface } from "./graphLifecycleSurface";
import { GraphLiveRenderer } from "./graphLiveRenderer";
import { productionHtmlBuilder } from "./graphProductionHtml";
import { mountReferenceGraph } from "../webview/graphReferenceHarness";
import path from "node:path";

/**
 * 같은 합성 Graph 입력을 production HTML/CSP/bundle의 실제 ready 경로에 연결한다.
 * @param browser 소유 headless browser @param page 원본 모듈 대신 production 문서를 올릴 페이지
 * @returns 전달 queue를 가진 renderer. Native Git·VS Code transport 성능을 측정하는 helper는 아니다.
 */
export async function mountProductionReference(browser: Browser, page: Page, bundle?: string, stackLayers = 0): Promise<GraphLiveRenderer> {
  const seed = await browser.newPage();
  let fixture: any;
  try {
    await mountReferenceGraph(seed, true, 1);
    fixture = await seed.evaluate(() => (window as any).__referenceFixture);
  } finally { await seed.close(); }
  mock.method(Uri, "joinPath", (base: { fsPath: string }, ...parts: string[]) => lifecycleResourceUri(path.join(base.fsPath, ...parts)));
  const surface = createLifecycleSurface(() => undefined);
  const live: GraphLiveRenderer = new (GraphLiveRenderer as any)(browser, page);
  live.onMessage(message => {
    if (message.type !== "ready") return;
    live.post({ type: "branchStatus", branches: fixture.branches, worktrees: [] });
    live.post({ type: "tagStatus", tags: fixture.tags });
    live.post({ type: "graph", data: { rows: fixture.rows, edges: fixture.edges, laneCount: 1 }, revision: 0,
      state: { loadedCount: fixture.rows.length, reset: true, loading: false, hasMore: false, hasMoreBefore: false,
        colorScope: "/fixture/references" } });
    if (stackLayers) live.post({ type: "pullRequestStackSnapshot", snapshot: { repository: "fixture", stacks: [],
      layers: fixture.rows.slice(0, stackLayers).map((row: any, index: number) => ({ branch: `bench-${index}`, parentBranch: `bench-${index + 1}`,
        headHash: row.hash, parentHash: fixture.rows[index + 1].hash, depth: index, childBranches: [], local: true,
        needsRestack: false, pullRequest: { number: 42 + index, state: "OPEN" } })) } });
  });
  const buildGraphHtml = await productionHtmlBuilder();
  await live.mount(buildGraphHtml(surface.surface, Uri.file(process.cwd())),
    bundle === undefined ? undefined : new Map([["media/bundled/graph.js", bundle]]));
  await page.waitForFunction(() => document.querySelectorAll("#graph-content > .row").length === 5000);
  await page.evaluate(fixture => { (window as any).__referenceFixture = fixture; }, fixture);
  return live;
}
