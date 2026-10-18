import { expect, test } from "@playwright/test";
import { mountSlowRebase, report } from "./lowEndHarness";
import { dispatchWebviewMessage, readPostedMessages } from "./webviewHarness";

test("500-commit rebase keeps message typing local under 6x CPU throttling", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const initial = await mountSlowRebase(page, 500);
  await page.evaluate(() => {
    const w = window as any, hash = w.__lowEnd.hash;
    window.dispatchEvent(new MessageEvent("message", { data: { type: "commitDetail", detail: {
      hash, message: "Editable commit message", authorName: "Fixture", authorEmail: "fixture@example.test",
      authorDateIso: "2026-10-16T00:00:00.000Z", parents: [], branches: [], files: [],
    } } }));
    w.__lowEnd.actions = document.querySelector(".rebase-row-actions");
    let inputStarted = 0;
    document.addEventListener("input", event => {
      if ((event.target as HTMLElement).id === "rebase-detail-message") inputStarted = performance.now();
    }, true);
    document.addEventListener("input", event => {
      if ((event.target as HTMLElement).id === "rebase-detail-message") w.__lowEnd.inputs.push(performance.now() - inputStarted);
    });
  });
  const input = page.locator("#rebase-detail-message");
  await input.focus();
  await input.press("End");
  await input.pressSequentially(" low-end typing".repeat(8));
  const result = await page.evaluate(() => {
    const w = window as any;
    const samples = [...w.__lowEnd.inputs].sort((a: number, b: number) => a - b);
    return { inputP95Ms: samples[Math.ceil(samples.length * .95) - 1], samples,
      firstInputMs: w.__lowEnd.inputs[0],
      actionsPreserved: w.__lowEnd.actions === document.querySelector(".rebase-row-actions"),
      message: w.GscGraphRebaseContext.itemForHash(w.__lowEnd.hash).message };
  });
  await report(page, info, "rebase-typing", { ...initial, ...result });
  expect(errors).toEqual([]);
  expect(result.message).toContain("low-end typing");
  expect(result.actionsPreserved).toBe(true);
  expect(result.inputP95Ms).toBeLessThan(100);
  expect(result.firstInputMs).toBeLessThan(100);
  await expect(page.locator("#rebase-detail-action")).toHaveValue("reword");
  await expect(page.locator(".rebase-detail-files")).toContainText("No changed files.");
  expect(initial.planMs).toBeLessThan(1000);
});

for (const width of [390, 768, 1440]) {
  test(`large rebase file edits preserve scrolling, focus and the complete plan at ${width}px`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const initial = await mountSlowRebase(page, 250, 500);
    await page.locator('.row[data-index="0"]').click();
    await page.evaluate(() => {
      const w = window as any, { hash, files } = w.__lowEnd;
      w.GscGraphRebaseContext.updateAction(hash, "edit");
      window.dispatchEvent(new MessageEvent("message", { data: { type: "commitDetail", detail: {
        hash, message: "A long historical commit subject that still allows file controls and the complete path to remain accessible",
        authorName: "Fixture", authorEmail: "fixture@example.test", authorDateIso: "2026-10-16T00:00:00.000Z",
        parents: [], branches: [], files,
      } } }));
    });
    const files = page.locator(".rebase-detail-files");
    const row = (index: number) => files.locator(`.file-row[data-file-index="${index}"]`);
    await expect(page.locator(".rebase-detail-editor .files-title .count")).toHaveText("500");
    await row(0).locator('[data-exclude="commit"]').focus();
    await files.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(row(499)).toBeVisible();
    await expect(row(0).locator('[data-exclude="commit"]')).toBeFocused();
    expect(await files.locator(".file-row").count()).toBeLessThan(35);
    const last = row(499);
    const commitExclude = last.locator('[data-exclude="commit"]');
    await commitExclude.focus();
    await page.keyboard.press("Enter");
    await expect(commitExclude).toBeFocused();
    await expect(commitExclude).toHaveAttribute("aria-pressed", "true");
    await last.locator('[data-exclude="history"]').click();
    await expect(last.locator('[data-exclude="history"]')).toHaveAttribute("aria-pressed", "true");
    const target = (1).toString(16).padStart(40, "0");
    const select = last.locator(".file-move-target");
    await select.focus();
    await expect(select.locator("option")).toHaveCount(250);
    await select.selectOption(target);
    await expect(select).toBeFocused();
    await expect(select).toHaveValue(target);
    const state = await page.evaluate(() => {
      const w = window as any;
      const item = w.GscGraphRebaseContext.itemForHash(w.__lowEnd.hash);
      return { excludePaths: item.excludePaths, fileMoves: item.fileMoves, files: item.files.length };
    });
    expect(state.files).toBe(500);
    expect(state.excludePaths).toContain("src/components/file-00499.ts");
    expect(state.fileMoves[0]).toMatchObject({ sourcePath: "src/components/file-00499.ts", targetHash: target });
    // DOM 밖으로 밀린 포커스 행에서 Tab을 눌러도 다음 모델 파일로 이동해야 한다.
    await files.evaluate(element => { element.scrollTop = 150 * 26; });
    await expect(row(150)).toBeVisible();
    await row(150).locator('[data-exclude="history"]').focus();
    await files.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(row(499)).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(row(151).locator('[data-rebase-action="open-edit-file"]')).toBeFocused();
    await report(page, info, `rebase-edit-${width}`, { ...initial, ...state, renderedFiles: await files.locator(".file-row").count() });
    expect(await page.locator(".rebase-detail-editor").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const start = page.locator('[data-rebase-action="start-edit-rebase"]');
    await start.focus();
    await page.keyboard.press("Enter");
    const message = (await readPostedMessages(page)).filter((message: any) => message.type === "runGraphRebase").at(-1);
    const item = message.items.find((item: any) => item.hash === initial.hash);
    expect(item.files).toHaveLength(500);
    expect(item.fileMoves).toEqual(state.fileMoves);
    expect(item.excludePaths).toEqual(state.excludePaths);
    await dispatchWebviewMessage(page, { type: "graphRebaseClear" });
    await expect(page.locator(".rebase-detail-editor")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("500 changed files use a bounded rebase detail DOM under 6x CPU throttling", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const initial = await mountSlowRebase(page, 250, 500);
  const result = await page.evaluate(() => {
    const w = window as any, { hash, files } = w.__lowEnd;
    w.GscGraphRebaseContext.updateAction(hash, "edit");
    const started = performance.now();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "commitDetail", detail: {
      hash, message: "Large commit with many changed files", authorName: "Fixture", authorEmail: "fixture@example.test",
      authorDateIso: "2026-10-16T00:00:00.000Z", parents: [], branches: [], files,
    } } }));
    return { detailMs: performance.now() - started,
      fileRows: document.querySelectorAll(".rebase-detail-files .file-row").length,
      targetOptions: document.querySelectorAll(".rebase-detail-files option").length };
  });
  await report(page, info, "rebase-files", { ...initial, ...result });
  expect(errors).toEqual([]);
  expect(result.fileRows).toBeLessThan(80);
  expect(result.targetOptions).toBeLessThan(1200);
  expect(result.detailMs).toBeLessThan(500);
});
