import { expect, test } from "@playwright/test";
import {
  dispatchWebviewMessage,
  mountGraphRenderer,
  readPostedMessages,
} from "./webviewHarness";

test("Graph render reports extension-to-paint timing after two animation frames", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await mountGraphRenderer(page);
  const extensionStartedAt = Date.now() - 10;
  const sentAt = Date.now();
  await dispatchWebviewMessage(page, {
    type: "graph",
    data: {
      rows: [{
        hash: "performance-commit",
        parents: [],
        refs: ["HEAD", "main"],
        authorName: "Fixture",
        authorEmail: "fixture@example.test",
        dateIso: "2026-09-04T00:00:00.000Z",
        subject: "Performance trace fixture",
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
    performance: {
      traceId: "trace-performance",
      cause: "ready",
      kind: "reset",
      extensionStartedAt,
      sentAt,
    },
  });

  await expect.poll(async () => (await readPostedMessages(page)).filter(
    (message: { type?: string }) => message.type === "graphRendered"
  ).length).toBe(1);
  const message = (await readPostedMessages(page)).find(
    (candidate: { type?: string }) => candidate.type === "graphRendered"
  );
  expect(message.performance).toEqual({
    traceId: "trace-performance",
    cause: "ready",
    kind: "reset",
    extensionStartedAt,
    sentAt,
  });
  expect(message.receivedAt).toBeGreaterThanOrEqual(sentAt);
  expect(message.renderedAt).toBeGreaterThanOrEqual(message.receivedAt);
  expect(message.paintedAt).toBeGreaterThanOrEqual(message.renderedAt);
});

test("a newer Graph payload suppresses the stale payload paint report", async ({ page }) => {
  await mountGraphRenderer(page);
  const state = {
    loadedCount: 0, hasMore: false, hasMoreBefore: false,
    loading: false, reset: true, colorScope: "/fixture/repository",
  };
  const message = (traceId: string) => ({
    type: "graph",
    data: { rows: [], edges: [], laneCount: 1 },
    state,
    performance: {
      traceId, cause: "refresh", kind: "reset",
      extensionStartedAt: Date.now(), sentAt: Date.now(),
    },
  });
  await page.evaluate(([first, second]) => {
    window.dispatchEvent(new MessageEvent("message", { data: first }));
    window.dispatchEvent(new MessageEvent("message", { data: second }));
  }, [message("stale-trace"), message("current-trace")]);
  await expect.poll(async () => (await readPostedMessages(page)).filter(
    (candidate: { type?: string }) => candidate.type === "graphRendered"
  ).length).toBe(1);
  const rendered = (await readPostedMessages(page)).find(
    (candidate: { type?: string }) => candidate.type === "graphRendered"
  );
  expect(rendered.performance.traceId).toBe("current-trace");
});
