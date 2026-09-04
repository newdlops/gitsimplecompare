import { expect, test } from "@playwright/test";
import {
  dispatchWebviewMessage,
  mountGraphRenderer,
  readPostedMessages,
} from "./webviewHarness";

/** 손상 ref 경고와 함께 정상 커밋 한 건을 렌더링할 production protocol 메시지를 만든다. */
function healthyGraphMessage() {
  return {
    type: "graph",
    data: {
      rows: [{
        hash: "healthy-commit",
        parents: [],
        refs: ["HEAD", "main"],
        authorName: "Fixture",
        authorEmail: "fixture@example.test",
        dateIso: "2026-08-28T00:00:00.000Z",
        subject: "Healthy commit remains visible",
        color: 0,
        column: 0,
      }],
      edges: [],
      laneCount: 1,
    },
    state: {
      loadedCount: 1,
      hasMore: false,
      hasMoreBefore: false,
      loading: false,
      reset: true,
      colorScope: "/fixture/repository",
    },
  };
}

test("Graph ref warning keeps commits usable and provides an accessible recovery path", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await mountGraphRenderer(page);
  await dispatchWebviewMessage(page, {
    type: "graphHealth",
    notice: {
      level: "warning",
      title: "Damaged local branch refs were skipped (2).",
      detail: "The remaining graph is available. Restore or delete these refs, then refresh.",
      items: [
        { label: "broken-local", description: "refs/heads/broken-local → missing-one" },
        {
          label: "a-very-long-damaged-local-branch-name-that-must-not-overflow",
          description: "refs/heads/a-very-long-damaged-local-branch-name-that-must-not-overflow → missing-two",
        },
      ],
    },
  });
  await dispatchWebviewMessage(page, healthyGraphMessage());

  const health = page.locator("#graph-health");
  await expect(health).toBeVisible();
  await expect(health).toHaveAttribute("role", "status");
  await expect(health).toContainText("Damaged local branch refs were skipped (2).");
  await expect(health).toContainText("broken-local");
  await expect(page.locator("#graph-health-refs")).toHaveAttribute("translate", "no");
  await expect(page.getByText("Healthy commit remains visible", { exact: true })).toBeVisible();
  await expect(page.locator("#load-status")).toHaveText("1 commits, complete");

  const output = page.getByRole("button", { name: "Show Git Simple Compare Output" });
  for (const attribute of ["title", "aria-label", "data-tooltip"]) {
    await expect(output).toHaveAttribute(attribute, "Show Git Simple Compare Output");
  }
  await output.click();
  expect(await readPostedMessages(page)).toContainEqual({ type: "showGraphOutput" });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(output).toBeVisible();
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  )).toBe(true);

  await dispatchWebviewMessage(page, { type: "graphHealth" });
  await expect(health).toBeHidden();
  await expect(page.getByText("Healthy commit remains visible", { exact: true })).toBeVisible();
});

test("initial Graph failure ends loading and is announced as an error", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 600 });
  await mountGraphRenderer(page);
  await dispatchWebviewMessage(page, {
    type: "graphHealth",
    notice: {
      level: "error",
      title: "Git graph could not be loaded.",
      detail: "Check Git Simple Compare Output, repair the repository state, then refresh.",
    },
  });

  const health = page.locator("#graph-health");
  await expect(health).toBeVisible();
  await expect(health).toHaveAttribute("role", "alert");
  await expect(health).toHaveAttribute("aria-live", "assertive");
  await expect(page.locator("#graph-content .empty")).toHaveText("Git graph could not be loaded.");
  await expect(page.locator("#load-status")).toHaveText("Git graph could not be loaded.");
  await expect(page.getByText("Loading...", { exact: true })).toHaveCount(0);
});
