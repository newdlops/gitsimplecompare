import { expect, test, type Page } from "@playwright/test";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { mountChanges, readPostedMessages } from "./webviewHarness";

const FILES = 15000;
const ROW_HEIGHT = 22;

/**
 * 대량 작업트리 payload 를 page 안에서 만들어 render 메시지로 보낸다.
 * - 수만 노드를 Playwright 인자로 직렬화하면 CDP 전송 시간이 측정을 가리므로 page 안에서 생성한다.
 * @param page 대상 page
 * @param viewMode tree 는 `src` 폴더 하나 아래에 모든 파일, list 는 평면 목록
 * @returns render 메시지 처리에 걸린 page 내부 시간(ms)
 */
async function renderLargeChanges(page: Page, viewMode: "tree" | "list"): Promise<number> {
  const fixture: any = await loadWebviewFixture("changes.small.en.json");
  return page.evaluate(({ base, viewMode, files }) => {
    const changes = Array.from({ length: files }, (_, index) => ({
      status: index % 5 ? "M" : "A",
      path: `src/file${String(index).padStart(5, "0")}.ts`,
      additions: 3,
      deletions: 1,
    }));
    const unstaged = viewMode === "list"
      ? changes.map((change) => ({ kind: "file", change }))
      : [{ kind: "folder", name: "src", path: "src", children: changes.map((change) => ({ kind: "file", change })) }];
    const payload = { ...base, changes: { viewMode, staged: [], unstaged }, commit: { ...base.commit, hasStagedChanges: false } };
    const started = performance.now();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "render", payload } }));
    return performance.now() - started;
  }, { base: fixture.payload, viewMode, files: FILES });
}

/** Changes 섹션 스크롤 영역을 지정 위치로 옮기고 가상 목록이 다음 frame 에 다시 그려질 때까지 기다린다. */
async function scrollChanges(page: Page, top: number): Promise<void> {
  await page.evaluate((value) => {
    const body = document.querySelector('.section[data-section="changes"] > .section-body') as HTMLElement;
    body.scrollTop = value;
  }, top);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** 작업트리 행 하나를 파일 경로로 찾는다. */
function workingRow(page: Page, path: string) {
  return page.locator(`#changes-group-files-unstaged .row[data-path="${path}"]`);
}

test.beforeEach(async ({ page }) => {
  const fixture: any = await loadWebviewFixture("changes.small.en.json");
  await page.setViewportSize({ width: 360, height: 900 });
  await mountChanges(page, fixture);
});

test("15k working changes render a bounded DOM window and follow scrolling", async ({ page }) => {
  const elapsed = await renderLargeChanges(page, "list");
  expect(elapsed).toBeLessThan(1000);
  const rows = page.locator("#changes-group-files-unstaged .row");
  expect(await rows.count()).toBeLessThan(120);
  await expect(page.locator('.section[data-section="changes"] .group[data-gkey="unstaged"] .count')).toHaveText(String(FILES));
  await expect(workingRow(page, "src/file00000.ts")).toBeVisible();

  const spacer = await page.locator("#changes-group-files-unstaged > .rows").evaluate((el) => el.getBoundingClientRect().height);
  expect(spacer).toBe(FILES * ROW_HEIGHT);

  await scrollChanges(page, 7000 * ROW_HEIGHT);
  await expect(workingRow(page, "src/file07000.ts")).toBeVisible();
  await expect(workingRow(page, "src/file00000.ts")).toHaveCount(0);
  expect(await rows.count()).toBeLessThan(120);
});

test("folder stage action sends every descendant file even when rows are off-screen", async ({ page }) => {
  await renderLargeChanges(page, "tree");
  const folder = workingRow(page, "src");
  await folder.hover();
  await folder.locator('.row-action[data-act="stage"]').click();
  const messages = await readPostedMessages(page);
  const stage = messages.filter((message: any) => message.type === "stage").at(-1);
  expect(stage.paths).toHaveLength(FILES);
  expect(stage.paths.at(-1)).toBe(`src/file${String(FILES - 1).padStart(5, "0")}.ts`);
});

test("shift range selection spans off-screen rows and survives scrolling", async ({ page }) => {
  await renderLargeChanges(page, "list");
  await workingRow(page, "src/file00000.ts").click();
  await scrollChanges(page, 5000 * ROW_HEIGHT);
  const target = workingRow(page, "src/file05000.ts");
  await target.click({ modifiers: ["Shift"] });
  await expect(target).toHaveClass(/selected/);

  await target.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Stage Changes" }).click();
  const messages = await readPostedMessages(page);
  const stage = messages.filter((message: any) => message.type === "stage").at(-1);
  expect(stage.paths).toHaveLength(5001);

  await scrollChanges(page, 0);
  await expect(workingRow(page, "src/file00000.ts")).toHaveClass(/selected/);
});

test("collapsing a large folder shrinks the virtual spacer to one row", async ({ page }) => {
  await renderLargeChanges(page, "tree");
  await workingRow(page, "src").locator(".twistie").click();
  await expect(workingRow(page, "src")).toHaveAttribute("aria-expanded", "false");
  const spacer = await page.locator("#changes-group-files-unstaged > .rows").evaluate((el) => el.getBoundingClientRect().height);
  expect(spacer).toBe(ROW_HEIGHT);
  await expect(page.locator("#changes-group-files-unstaged .row")).toHaveCount(1);

  await workingRow(page, "src").press("Enter");
  await expect(workingRow(page, "src")).toHaveAttribute("aria-expanded", "true");
  await expect(workingRow(page, "src")).toBeFocused();
  await expect(workingRow(page, "src/file00000.ts")).toBeVisible();
});
