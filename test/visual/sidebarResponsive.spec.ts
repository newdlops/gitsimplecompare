// PR-02 sidebar QA: Changes와 Reviews를 실제 renderer로 280/360/480px에서 남긴다.
// - 단순 screenshot 생성에 그치지 않고 root의 가로 overflow를 함께 검사해 좁은 VS Code sidebar 회귀를 포착한다.
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { loadWebviewFixture, type WebviewFixture } from "../helpers/webviewFixture";
import { mountChanges, mountReviews } from "../webview/webviewHarness";

type SidebarSurface = {
  name: "changes" | "reviews";
  fixture: WebviewFixture;
  mount(page: Page, fixture: WebviewFixture): Promise<void>;
};

/** viewport별 artifact를 붙여 사람 검토와 CI failure artifact가 같은 파일을 보게 한다. */
async function attachSidebarScreenshot(testInfo: TestInfo, page: Page, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** sidebar root가 view 폭보다 넓어 수평 스크롤을 만들지 않는지 확인한다. */
async function expectNoRootOverflow(page: Page): Promise<void> {
  const dimensions = await page.locator("#root").evaluate((root) => ({
    clientWidth: root.clientWidth,
    scrollWidth: root.scrollWidth,
  }));
  expect(dimensions.scrollWidth, `sidebar root overflow: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(dimensions.clientWidth);
}

test("Changes와 Reviews sidebar는 280·360·480px에서 overflow 없이 검토 artifact를 남긴다", async ({ page }, testInfo) => {
  const surfaces: SidebarSurface[] = [
    { name: "changes", fixture: await loadWebviewFixture("changes.small.en.json"), mount: mountChanges },
    { name: "reviews", fixture: await loadWebviewFixture("reviews.management.ko.json"), mount: mountReviews },
  ];

  for (const surface of surfaces) {
    for (const width of [280, 360, 480]) {
      await page.setViewportSize({ width, height: 760 });
      await surface.mount(page, surface.fixture);
      if (surface.name === "changes") {
        const commit = page.getByRole("button", { name: "Commit" });
        const commitMenu = page.locator("#commit-caret");
        await expect(commit).toBeVisible();
        await expect(commit).toBeInViewport();
        await expect(commitMenu).toBeVisible();
        await expect(commitMenu).toBeInViewport();
      }
      if (surface.name === "reviews") {
        await page.getByRole("tab", { name: /Management/ }).click();
      }
      await expectNoRootOverflow(page);
      await attachSidebarScreenshot(testInfo, page, `sidebar-${surface.name}-${width}`);
    }
  }
});

test("Reviews auth shell은 280px에서 sign-in과 diagnostics action을 모두 보인다", async ({ page }, testInfo) => {
  const fixture = await loadWebviewFixture("reviews.auth-required.en.json");
  await page.setViewportSize({ width: 280, height: 640 });
  await mountReviews(page, fixture);

  await expect(page.getByRole("button", { name: "Start GitHub CLI sign-in in a terminal" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Open Git Simple Compare Output for review queue diagnostics" })).toBeInViewport();
  await expectNoRootOverflow(page);
  await attachSidebarScreenshot(testInfo, page, "sidebar-reviews-auth-280");
});
