import { expect, test } from "@playwright/test";
import { dispatchWebviewMessage, mountGraphRenderer } from "./webviewHarness";

/** 지정한 레인 색상 인덱스로 같은 두 커밋을 다시 그릴 Graph 메시지를 만든다. */
function graphMessage(firstColor: number, secondColor: number, reset: boolean) {
  const row = (hash: string, parents: string[], subject: string, color: number, column: number) => ({
    hash, parents, refs: [], authorName: "Fixture", authorEmail: "fixture@example.test",
    dateIso: "2026-07-30T12:00:00.000Z", subject, color, column,
  });
  return {
    type: "graph",
    data: {
      rows: [
        row("commit-a", ["commit-b"], "Keep this color stable", firstColor, 0),
        row("commit-b", [], "Parent commit", secondColor, 0),
      ],
      edges: [{
        fromRow: 0, toRow: 1, column: 0, fromColumn: 0, toColumn: 0,
        color: firstColor,
      }],
      laneCount: 1,
    },
    state: {
      loadedCount: 2, hasMore: false, hasMoreBefore: false,
      loading: false, reset, colorScope: "/fixture/repository",
    },
  };
}

/** 노드·간선·텍스트 행이 공유하는 실제 렌더 색상을 읽는다. */
async function renderedColors(page: Parameters<typeof mountGraphRenderer>[0]) {
  return page.evaluate(() => {
    const node = document.querySelector<SVGCircleElement>('.node[data-hash="commit-a"]');
    const edge = document.querySelector<SVGPathElement>("#graph-content svg path");
    const row = document.querySelector<HTMLElement>('.row[data-hash="commit-a"]');
    return {
      node: node?.getAttribute("fill"),
      edge: edge?.getAttribute("stroke"),
      row: row?.style.getPropertyValue("--branch-color"),
    };
  });
}

test("GraphData가 다시 계산돼도 같은 커밋의 노드·간선·행 색상을 유지한다", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await mountGraphRenderer(page);
  await dispatchWebviewMessage(page, graphMessage(0, 1, true));
  await expect(page.locator('.node[data-hash="commit-a"]')).toBeVisible();
  const initial = await renderedColors(page);

  await dispatchWebviewMessage(page, graphMessage(8, 9, false));
  await expect.poll(() => renderedColors(page)).toEqual(initial);
  expect(initial.node).toBeTruthy();
  expect(initial.edge).toBe(initial.node);
  expect(initial.row).toBe(initial.node);

  const splitter = page.getByRole("separator", { name: "Resize commit details" });
  const before = await page.locator("#detail").evaluate((element) =>
    element.getBoundingClientRect().width
  );
  await splitter.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => page.locator("#detail").evaluate((element) =>
    element.getBoundingClientRect().width
  )).toBe(before + 24);
});
