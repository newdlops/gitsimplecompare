// PR-00 visual evidence: representative fixture를 실제 renderer로 그리고 screenshot artifact를 남긴다.
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { mountChanges, mountReviews, mountReviewWorkspace } from "../webview/webviewHarness";

/** 현재 test output에 screenshot을 붙여 통과한 visual smoke도 review artifact로 남긴다. */
async function attachScreenshot(testInfo: TestInfo, page: Page, name: string): Promise<void> {
  const artifactPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: artifactPath, fullPage: true });
  await testInfo.attach(name, { path: artifactPath, contentType: "image/png" });
}

test("Changes compact small fixture screenshot", async ({ page }, testInfo) => {
  const fixture = await loadWebviewFixture("changes.small.en.json");
  await page.setViewportSize(fixture.viewport);
  await page.emulateMedia({ colorScheme: "dark" });
  await mountChanges(page, fixture);
  await expect(page.locator("#root")).toContainText("Working Changes");
  await attachScreenshot(testInfo, page, "changes-small-dark-360");
});

test("Reviews management Korean fixture screenshot", async ({ page }, testInfo) => {
  const fixture = await loadWebviewFixture("reviews.management.ko.json");
  await page.setViewportSize(fixture.viewport);
  await page.emulateMedia({ colorScheme: "light" });
  await mountReviews(page, fixture);
  await page.getByRole("tab", { name: /Management/ }).click();
  await expect(page.locator("#root")).toContainText("한국어 제목이 길어져도 관리 행의 정렬과 도구 설명이 유지되는지 확인합니다");
  await attachScreenshot(testInfo, page, "reviews-management-ko-light-1280");
});

test("Review Workspace populated fixture screenshot", async ({ page }, testInfo) => {
  const fixture = await loadWebviewFixture("review-workspace.populated.en.json");
  await page.setViewportSize(fixture.viewport);
  await page.emulateMedia({ colorScheme: "dark" });
  await mountReviewWorkspace(page, fixture);
  await page.getByRole("tab", { name: /Files/ }).click();
  await expect(page.locator("#root")).toContainText("src/fixture.ts");
  await attachScreenshot(testInfo, page, "review-workspace-files-dark-1024");
});
