// PR-00 웹뷰 검증의 공통 Playwright 설정.
// - 실제 VS Code 창을 조작하지 않고 fixture로 만든 browser page에서 webview renderer를 검증한다.
import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

/** CI가 별도 browser binary를 제공할 때만 명시 경로를 사용하고, 기본은 Playwright 관리 binary를 쓴다. */
function configuredChromiumExecutable(): string | undefined {
  const configured = process.env.GSC_PLAYWRIGHT_EXECUTABLE;
  return configured && existsSync(configured) ? configured : undefined;
}

/** Playwright가 webview·접근성·visual fixture spec을 같은 재현 조건에서 실행하도록 설정한다. */
export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.spec.ts",
  outputDir: "./test-results/playwright",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    browserName: "chromium",
    headless: true,
    ...(configuredChromiumExecutable() ? { launchOptions: { executablePath: configuredChromiumExecutable() } } : {}),
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium" }],
  preserveOutput: "always",
});
