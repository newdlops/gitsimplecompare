import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { dispatchWebviewMessage, mountChanges, readPostedMessages } from "./webviewHarness";

/** 저장소가 없는 실제 renderer 입력을 만들어 개별 UI 구현을 흉내 내지 않고 온보딩을 검증한다. */
async function emptyFixture() {
  const fixture = await loadWebviewFixture("changes.small.en.json");
  fixture.payload.repos = [];
  fixture.payload.commit.hasRepo = false;
  (fixture.payload as any).onboarding = { phase: "idle" };
  return fixture;
}

/** 실제 Codicon 폰트를 fixture 브라우저에 제공해 about:blank의 상대 URL로 glyph가 빠지지 않게 한다. */
async function installTheme(page: import("@playwright/test").Page): Promise<void> {
  const font = (await readFile(path.resolve("media/codicons/codicon.ttf"))).toString("base64");
  await page.addStyleTag({ content: theme +
    '@font-face{font-family:codicon;src:url(data:font/ttf;base64,' + font + ') format("truetype")}' });
}

/** VS Code의 실제 의미 색 역할을 테스트 브라우저에도 제공해 screenshot과 contrast를 평가한다. */
const theme = `:root{--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;
--vscode-foreground:#cccccc;--vscode-descriptionForeground:#a5a5a5;--vscode-editor-background:#1e1e1e;
--vscode-sideBar-background:#252526;--vscode-panel-border:#454545;--vscode-focusBorder:#007fd4;
--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#1177bb;
--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#fff;--vscode-button-secondaryHoverBackground:#45494e;
--vscode-errorForeground:#f48771;--vscode-icon-foreground:#c5c5c5;--vscode-disabledForeground:#888}
html,body{margin:0;background:var(--vscode-sideBar-background)}`;

for (const width of [240, 390, 768, 1440]) {
  test(`repository onboarding is usable at ${width}px without a commit form or hidden actions`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 768 ? 1024 : width === 1440 ? 900 : 844 });
    await mountChanges(page, await emptyFixture());
    await installTheme(page);
    await expect(page.getByRole("heading", { name: "Start with Git Simple Compare" })).toBeVisible();
    await expect(page.locator("#commit-msg")).toHaveCount(0);
    await expect(page.locator("[data-onboarding-action]")).toHaveCount(4);
    for (const control of await page.locator("[data-onboarding-action]").all()) {
      await expect(control).toBeEnabled();
      expect(await control.getAttribute("title")).toBeTruthy();
      expect(await control.getAttribute("aria-label")).toBeTruthy();
      await control.focus();
      await expect(control).toBeFocused();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.locator('[data-onboarding-action="clone"]').focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await readPostedMessages(page)).filter((message: any) => message.type === "repositorySetup"))
      .toEqual([{ type: "repositorySetup", action: "clone" }]);
    await page.mouse.move(width - 1, 843);
    await page.locator('[data-onboarding-action="clone"]').evaluate(control => (control as HTMLElement).blur());
    await page.screenshot({ path: `test-results/onboarding-${width}.png`, fullPage: true });
  });
}

test("onboarding binds each entry to an own setup command and keeps error text escaped", async ({ page }) => {
  const fixture = await emptyFixture();
  await mountChanges(page, fixture);
  await installTheme(page);
  for (const action of ["github", "open", "init"]) await page.locator(`[data-onboarding-action="${action}"]`).click();
  const messages = (await readPostedMessages(page)).filter((message: any) => message.type === "repositorySetup");
  expect(messages.map((message: any) => message.action)).toEqual(["github", "open", "init"]);
  (fixture.payload as any).onboarding = { phase: "error", action: "clone", message: '<img src=x onerror="alert(1)"> Destination already exists.' };
  await dispatchWebviewMessage(page, { type: "render", payload: fixture.payload });
  await expect(page.getByRole("alert")).toContainText("<img src=x");
  await expect(page.locator(".gsc-onboarding img")).toHaveCount(0);
  await page.mouse.move(700, 800);
  await page.screenshot({ path: "test-results/onboarding-error.png", fullPage: true });
  await page.locator('[data-onboarding-action="retry"]').click();
  expect((await readPostedMessages(page)).at(-1)).toEqual({ type: "repositorySetup", action: "clone" });
});

test("repository discovery and Git operations have distinct busy states and recover after cancellation", async ({ page }) => {
  const fixture = await emptyFixture();
  (fixture.payload as any).onboarding = { phase: "scanning" };
  await mountChanges(page, fixture);
  await installTheme(page);
  await expect(page.getByRole("status")).toHaveText("Finding repositories…");
  for (const control of await page.locator("[data-onboarding-action]").all()) await expect(control).toBeDisabled();
  (fixture.payload as any).onboarding = { phase: "running", action: "init" };
  await dispatchWebviewMessage(page, { type: "render", payload: fixture.payload });
  await expect(page.getByRole("status")).toHaveText("Initializing repository…");
  await page.screenshot({ path: "test-results/onboarding-running.png", fullPage: true });
  (fixture.payload as any).onboarding = { phase: "idle" };
  await dispatchWebviewMessage(page, { type: "render", payload: fixture.payload });
  await expect(page.locator('[data-onboarding-action="init"]')).toBeEnabled();
});

test("scanning failures offer retry and Git diagnosis, and completion offers the verified repository", async ({ page }) => {
  const fixture = await emptyFixture();
  (fixture.payload as any).onboarding = { phase: "error", message: "Git is unavailable." };
  await mountChanges(page, fixture);
  await installTheme(page);
  await page.locator('[data-onboarding-action="retry"]').click();
  expect((await readPostedMessages(page)).at(-1)).toEqual({ type: "repositorySetupRetry" });
  await page.locator('[data-onboarding-action="diagnose"]').click();
  expect((await readPostedMessages(page)).at(-1)).toEqual({ type: "repositorySetupDiagnose" });
  (fixture.payload as any).onboarding = { phase: "complete", repositoryRoot: "/workspace/repository-with-a-very-long-name" };
  await dispatchWebviewMessage(page, { type: "render", payload: fixture.payload });
  await page.locator('[data-onboarding-action="openCompleted"]').click();
  expect((await readPostedMessages(page)).at(-1)).toEqual({ type: "repositorySetupOpenCompleted" });
});

test("long localized onboarding labels wrap and a discovered repository restores the normal Changes view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await emptyFixture();
  await mountChanges(page, fixture);
  await installTheme(page);
  // 실제 지역화 API가 주입할 문자열을 renderer의 defaults 경계에 제공한다.
  await page.evaluate(() => {
    Object.assign((window as any).__gscChangesOnboarding.defaults, {
      onboardingTitle: "Git Simple Compare에서 저장소를 시작하고 변경 사항을 관리하세요",
      onboardingClone: "원격 저장소 URL이나 SSH 주소를 입력해 새 폴더로 저장소 복제",
      onboardingGitHub: "GitHub 계정으로 공개·개인·조직의 저장소를 선택해 복제",
    });
  });
  await dispatchWebviewMessage(page, { type: "render", payload: fixture.payload });
  await expect(page.getByRole("heading")).toContainText("저장소를 시작");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/onboarding-localized.png", fullPage: true });
  const active = await loadWebviewFixture("changes.small.en.json");
  await dispatchWebviewMessage(page, { type: "render", payload: active.payload });
  await expect(page.locator(".gsc-onboarding")).toHaveCount(0);
  await expect(page.locator("#commit-msg")).toBeVisible();
});

/** 실제 새 surface의 색 대비·이름·키보드·고대비·동작 줄이기를 한 번의 접근성 검사로 확인한다. */
test("onboarding supports Axe, keyboard focus, forced colors, and reduced motion", async ({ page }) => {
  const fixture = await emptyFixture();
  await page.setViewportSize({ width: 390, height: 844 });
  await mountChanges(page, fixture);
  await installTheme(page);
  const primary = page.getByRole("button", { name: "Clone Repository…", exact: true });
  await primary.focus();
  await expect(primary).toBeFocused();
  expect(await primary.evaluate(control => getComputedStyle(control).outlineStyle)).not.toBe("none");
  const result = await new AxeBuilder({ page }).include(".gsc-onboarding").analyze();
  expect(result.violations.map(item => ({ id: item.id, nodes: item.nodes.length }))).toEqual([]);
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Clone from GitHub…", exact: true })).toBeFocused();
  await page.screenshot({ path: "test-results/onboarding-high-contrast.png", fullPage: true });
  (fixture.payload as any).onboarding = { phase: "running", action: "github" };
  await dispatchWebviewMessage(page, { type: "render", payload: fixture.payload });
  await expect(page.getByRole("status")).toHaveText("Cloning from GitHub…");
  await expect(page.locator(".gsc-onboarding .codicon-modifier-spin")).toHaveCSS("animation-duration", "0s");
  await expect(page.locator(".gsc-onboarding .codicon-modifier-spin")).toHaveCSS("animation-iteration-count", "1");
});
