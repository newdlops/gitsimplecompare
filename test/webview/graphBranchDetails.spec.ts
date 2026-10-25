import { expect, test } from "@playwright/test";
import path from "node:path";
import { dispatchWebviewMessage, mountGraphRenderer, readPostedMessages } from "./webviewHarness";

const identity = { name: "main", hash: "a".repeat(40), current: true };
const details = { ...identity, ahead: 7, behind: 2, upstream: "origin/main", gone: false, subject: "Actual branch details" };
const state = { loadedCount: 300, hasMore: true, hasMoreBefore: false, loading: true, reset: true,
  colorScope: "/fixture/branch-details", branchDetails: { loading: true, message: "Updating branch details..." } };

/** 준비 중에도 읽고 선택할 수 있는 300개 실제 형태의 commit 행을 만든다. */
function data() {
  const rows = Array.from({ length: 300 }, (_, index) => ({ hash: index === 0 ? identity.hash : index.toString(16).padStart(40, "0"),
    parents: [], refs: index === 0 ? ["HEAD", "main"] : [], authorName: "Graph fixture", authorEmail: "fixture@example.invalid",
    dateIso: "2026-10-20T00:00:00Z", subject: `Commit ${index}: keep history readable while branch details are loading`, color: 0, column: 0 }));
  return { rows, edges: [], laneCount: 1 };
}

/** 기존 renderer와 ref component를 사용한다. Native Git은 별도 통합 검사에서 검증한다. */
async function mount(page: import("@playwright/test").Page) {
  await mountGraphRenderer(page, false, { remote: true });
  for (const file of ["graphReferenceState.js", "graphFeatures.js", "graphRemote.js"])
    await page.addScriptTag({ path: path.join(process.cwd(), "media/graph", file) });
  await page.keyboard.press("Escape");
  await dispatchWebviewMessage(page, { type: "branchIdentities", branches: [identity], worktrees: [], message: "Branch details are not available yet." });
  await dispatchWebviewMessage(page, { type: "graph", data: data(), state });
}

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`branch details hydrate without blocking commit selection at ${width}px`, async ({ page }, info) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height }); await mount(page);
    const chip = page.locator('.row [data-branch-name="main"]');
    await expect(chip).toHaveClass(/current-local/); await expect(chip).not.toHaveClass(/ahead|behind|gone/);
    await expect(chip).toHaveAttribute("data-tooltip", /not available yet/);
    const remote = page.locator("#open-remote-branch");
    await expect(remote).toBeDisabled();
    await expect(remote).toHaveAttribute("data-tooltip", "Branch details are not available yet.");
    await expect(remote).toHaveAttribute("aria-label", "Branch details are not available yet.");
    await expect(page.locator("#load-status")).toContainText("300 commits loaded · Updating branch details...");
    await page.screenshot({ path: info.outputPath(`branch-pending-${width}.png`) });
    const row = page.locator('#graph-content .row[data-hash="0000000000000000000000000000000000000005"]');
    await row.locator(".subject").click(); await page.keyboard.press("Escape");
    expect((await readPostedMessages(page)).some((message: any) => message.type === "selectCommit" && message.hash.endsWith("0005"))).toBe(true);
    const before = await page.locator("#graph").evaluate(element => element.scrollTop);
    await chip.focus();
    await dispatchWebviewMessage(page, { type: "branchStatus", branches: [details], worktrees: [] });
    await dispatchWebviewMessage(page, { type: "graphLoadState", state: { ...state, reset: false, loading: false, branchDetails: null } });
    await expect(chip).toHaveClass(/ahead/); await expect(chip).toHaveClass(/behind/);
    await expect(chip).toHaveAttribute("data-tooltip", /ahead 7/);
    await expect(chip).toBeFocused();
    await expect(remote).toBeEnabled(); await expect(remote).toHaveAttribute("data-tooltip", "Open remote branch origin/main");
    await expect(row).toHaveClass(/selected/);
    expect(await page.locator("#graph").evaluate(element => element.scrollTop)).toBe(before);
    await expect(page.locator("#load-status")).not.toHaveClass(/loading/);
    await page.screenshot({ path: info.outputPath(`branch-ready-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("paused and failed details keep history readable and stop the progress indicator", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await mount(page);
  for (const message of ["Branch details paused.", "브랜치 상세 정보를 불러오지 못했습니다."]) {
    await dispatchWebviewMessage(page, { type: "graphLoadState", state: { ...state, reset: false, loading: false,
      branchDetails: { loading: false, message, detail: "Original query deadline; use Refresh or Show Output." } } });
    await expect(page.locator("#load-status")).toContainText(message);
    await expect(page.locator("#load-status")).not.toHaveClass(/loading/);
    await expect(page.locator("#graph-content .row")).toHaveCount(300);
    await expect(page.locator("#load-status")).toHaveAttribute("title", /Original query deadline/);
  }
  await page.screenshot({ path: info.outputPath("branch-details-unavailable-390.png") });
});
