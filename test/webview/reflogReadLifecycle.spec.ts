import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { dispatchWebviewMessage, mountGraphRenderer, readPostedMessages } from "./webviewHarness";

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`reflog close cancels its request and ignores late responses at ${width}px`, async ({ page }) => {
    test.setTimeout(90_000); await page.setViewportSize({ width, height });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await mountGraphRenderer(page);
    await page.evaluate(() => {
      const toolbar = document.getElementById("graph-toolbar")!;
      toolbar.insertAdjacentHTML("beforeend", '<button id="graph-reflog" type="button" title="Show reflog recovery" aria-label="Show reflog recovery">Reflog</button>');
      document.getElementById("graph-pane")!.insertAdjacentHTML("beforeend", '<section id="graph-reflog-panel" aria-label="Reflog recovery" hidden></section>');
    });
    await page.addStyleTag({ path: join(process.cwd(), "media/graph/graphReflog.css") });
    for (const name of ["graphReflogModel.js", "graphReflogPresentation.js", "graphReflog.js"]) {
      await page.addScriptTag({ path: join(process.cwd(), "media/graph", name) });
    }
    await page.locator("#graph-reflog").click();
    await expect(page.locator("#graph-reflog-panel")).toContainText("Loading reflog...");
    await expect.poll(async () => (await readPostedMessages(page)).filter((message: any) => message.type === "refreshReflog").length).toBe(1);
    const first = (await readPostedMessages(page)).find((message: any) => message.type === "refreshReflog");
    await page.locator("#close-reflog").click();
    expect((await readPostedMessages(page)).some((message: any) => message.type === "cancelReflog" && message.requestId === first.requestId)).toBe(true);
    await page.locator("#graph-reflog").click();
    const second = (await readPostedMessages(page)).filter((message: any) => message.type === "refreshReflog").at(-1);
    expect(second.requestId).not.toBe(first.requestId);
    await dispatchWebviewMessage(page, { type: "graphReflog", requestId: first.requestId, entries: [] });
    await expect(page.locator("#graph-reflog-panel")).toContainText("Loading reflog...");
    await dispatchWebviewMessage(page, { type: "graphReflogError", requestId: second.requestId, message: "Read failed. Refresh to retry." });
    await expect(page.locator("#graph-reflog-panel")).toContainText("Read failed. Refresh to retry.");
    await page.locator("#refresh-reflog").focus(); await page.keyboard.press("Enter");
    const third = (await readPostedMessages(page)).filter((message: any) => message.type === "refreshReflog").at(-1);
    expect(third.requestId).not.toBe(second.requestId);
    await dispatchWebviewMessage(page, { type: "graphReflog", requestId: third.requestId, entries: [] });
    await expect(page.locator("#graph-reflog-panel")).toContainText("0 entries");
    await expect(page.locator("#close-reflog")).toHaveAttribute("title", "Close reflog");
    const bounds = await page.locator("#graph-reflog-panel").boundingBox();
    expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `test-results/reflog-read-${width}.png` });
    expect(errors).toEqual([]);
  });
}
