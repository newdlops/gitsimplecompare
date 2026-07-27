// PR-00의 대표 webview smoke: 실제 renderer script가 fixture host message를 받아 화면을 만든다.
import { expect, test } from "@playwright/test";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { mountChanges, mountReviews, mountReviewWorkspace } from "./webviewHarness";

test("Changes small fixture는 작업 변경과 commit composer를 렌더한다", async ({ page }) => {
  const fixture = await loadWebviewFixture("changes.small.en.json");
  await page.setViewportSize(fixture.viewport);
  await mountChanges(page, fixture);

  await expect(page.getByRole("heading", { name: "Changes" })).toBeVisible();
  await expect(page.locator(".changes-region--working .name").filter({ hasText: "app.ts" })).toBeVisible();
  await expect(page.locator("#commit-msg")).toBeVisible();
});

test("Changes는 Working Changes와 Tools 사이 높이를 sash로 조절한다", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  const fixture = await loadWebviewFixture("changes.small.en.json");
  await page.setViewportSize(fixture.viewport);
  await mountChanges(page, fixture);

  const repository = page.locator(".changes-region--repository");
  const working = page.locator(".changes-region--working");
  const tools = page.locator(".changes-region--tools");
  const repositorySash = page.getByRole("separator", { name: "Resize Repository context and Working Changes" });
  const sash = page.getByRole("separator", { name: "Resize Working Changes and Tools" });
  await expect(repository).toBeVisible();
  await expect(working).toBeVisible();
  await expect(tools).toBeVisible();
  expect(pageErrors).toEqual([]);
  await expect.poll(() => page.evaluate(() => ({
    layout: typeof (window as unknown as { __gscChangesSectionLayout?: unknown }).__gscChangesSectionLayout,
    sashCount: document.querySelectorAll(".changes-region-sash").length,
  }))).toEqual({ layout: "function", sashCount: 2 });
  await expect(repositorySash).toBeVisible();
  await expect(sash).toBeVisible();

  const before = await working.boundingBox();
  const sashBox = await sash.boundingBox();
  if (!before || !sashBox) throw new Error("Changes region sash is not measurable");
  await page.mouse.move(sashBox.x + sashBox.width / 2, sashBox.y + sashBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sashBox.x + sashBox.width / 2, sashBox.y + sashBox.height / 2 + 40);
  await page.mouse.up();
  const after = await working.boundingBox();
  expect(after?.height).toBeGreaterThan(before.height);
});

test("Changes root navigation은 현재 surface를 알리고 Reviews 전환 의도를 host로 보낸다", async ({ page }) => {
  const fixture = await loadWebviewFixture("changes.small.en.json");
  await page.setViewportSize(fixture.viewport);
  await mountChanges(page, fixture);

  const navigation = page.getByRole("navigation", { name: "Git Simple Compare navigation" });
  await expect(navigation.getByRole("button", { name: "Changes" })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("button", { name: "Reviews" })).not.toHaveAttribute("aria-current");
  await navigation.getByRole("button", { name: "Reviews" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __gscFixtureMessages: unknown[] }).__gscFixtureMessages)).toContainEqual({
    type: "selectSidebarMode",
    mode: "reviews",
  });
});

test("Reviews management fixture는 Personal과 Management를 동급 tab으로 렌더한다", async ({ page }) => {
  const fixture = await loadWebviewFixture("reviews.management.ko.json");
  await page.setViewportSize(fixture.viewport);
  await mountReviews(page, fixture);

  await expect(page.getByRole("tab", { name: /Personal/ })).toBeVisible();
  await page.getByRole("tab", { name: /Management/ }).click();
  await expect(page.getByRole("heading", { name: "Repository management" })).toBeVisible();
  await expect(page.getByText("한국어 제목이 길어져도 관리 행의 정렬과 도구 설명이 유지되는지 확인합니다")).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview bulk changes" })).toBeVisible();
});

test("Reviews root navigation은 nested queue tab과 별도 의미론을 유지한다", async ({ page }) => {
  const fixture = await loadWebviewFixture("reviews.management.ko.json");
  await page.setViewportSize(fixture.viewport);
  await mountReviews(page, fixture);

  const navigation = page.getByRole("navigation", { name: "Git Simple Compare navigation" });
  await expect(navigation.getByRole("button", { name: "Reviews" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tablist", { name: "Review queue scope" })).toBeVisible();
  await navigation.getByRole("button", { name: "Changes" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __gscFixtureMessages: unknown[] }).__gscFixtureMessages)).toContainEqual({
    type: "selectSidebarMode",
    mode: "changes",
  });
});

test("Reviews cached fixture는 PR metadata나 write UI 없이 Personal·Management count를 복원한다", async ({ page }) => {
  const fixture = await loadWebviewFixture("reviews.cached.en.json");
  await page.setViewportSize(fixture.viewport);
  await mountReviews(page, fixture);

  await expect(page.getByRole("heading", { name: "Cached review summary" })).toBeVisible();
  await expect(page.getByText("4 personal · 9 management pull requests")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Management/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview bulk changes" })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
    data: { type: "error", message: "GitHub cannot be reached. Check your network connection and retry." },
  })));
  await expect(page.getByRole("alert")).toContainText("GitHub cannot be reached");
});

test("Reviews auth failure는 gh sign-in과 Output action을 raw 진단 없이 제공한다", async ({ page }) => {
  const fixture = await loadWebviewFixture("reviews.auth-required.en.json");
  await page.setViewportSize(fixture.viewport);
  await mountReviews(page, fixture);

  await expect(page.getByRole("heading", { name: "GitHub authentication required" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start GitHub CLI sign-in in a terminal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Git Simple Compare Output for review queue diagnostics" })).toBeVisible();
  await page.getByRole("button", { name: "Start GitHub CLI sign-in in a terminal" }).click();
  await page.getByRole("button", { name: "Open Git Simple Compare Output for review queue diagnostics" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __gscFixtureMessages: unknown[] }).__gscFixtureMessages)).toEqual(expect.arrayContaining([
    { type: "startGitHubAuth" },
    { type: "showOutputLog" },
  ]));
});

test("Review Workspace fixture는 detail tab과 metadata 관리 surface를 렌더한다", async ({ page }) => {
  const fixture = await loadWebviewFixture("review-workspace.populated.en.json");
  await page.setViewportSize(fixture.viewport);
  await mountReviewWorkspace(page, fixture);

  await expect(page.getByRole("heading", { name: /Improve deterministic review fixtures/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Manage metadata" })).toBeVisible();
  await page.getByRole("tab", { name: /Files/ }).click();
  await expect(page.getByText("src/fixture.ts")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add line comment" })).toBeVisible();
});
