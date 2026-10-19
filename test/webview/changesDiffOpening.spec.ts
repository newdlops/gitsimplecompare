import { test, expect } from "@playwright/test";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { mountChanges, readPostedMessages } from "./webviewHarness";
import { rendererPatchScript } from "../../src/providers/nativeDiffOverlayPatch";
import type { HunkOverlaySnapshot } from "../../src/providers/hunkCheckboxController";

/** 실제 native renderer가 사용하는 margin row와 변경 마커를 두 editor group에 재현한다. */
function nativeDiffFixture(): void {
  document.body.innerHTML = "";
  const style = document.createElement("style");
  style.textContent = `
    html,body{margin:0;background:#1e1e1e;color:#ccc;font:13px monospace;--vscode-focusBorder:#007fd4}
    main{display:flex;gap:8px;padding:8px}section{min-width:0;flex:1}h2{font:12px sans-serif}
    .monaco-diff-editor{height:170px;display:flex;border:1px solid #555}
    .editor{position:relative;flex:1;min-width:0;height:168px}
    .margin-view-overlays{position:absolute;left:0;top:0;width:54px;height:168px}
    .margin-row{position:absolute;width:54px;height:22px}
    .line-numbers{position:absolute;right:4px;color:#999}
    .view-lines{position:absolute;left:54px;right:0;height:168px;overflow:hidden}
    .view-line{position:absolute;white-space:pre;height:22px}
    .gutter-insert{position:absolute;left:0;width:4px;height:22px;background:#5a8}
  `;
  document.head.appendChild(style);
  const main = document.createElement("main"); document.body.appendChild(main);
  for (const [index, name] of ["Waiting file", "Ready file"].entries()) {
    const section = document.createElement("section"); section.dataset.group = String(index); main.appendChild(section);
    const title = document.createElement("h2"); title.textContent = name; section.appendChild(title);
    const diff = document.createElement("div"); diff.className = "monaco-diff-editor"; section.appendChild(diff);
    for (const side of ["original", "modified"]) {
      const editor = document.createElement("div"); editor.className = `editor ${side}`; diff.appendChild(editor);
      const margin = document.createElement("div"); margin.className = "margin-view-overlays"; editor.appendChild(margin);
      const lines = document.createElement("div"); lines.className = "view-lines"; editor.appendChild(lines);
      for (let line = 1; line <= 4; line++) {
        const row = document.createElement("div"); row.className = "margin-row"; row.style.top = `${(line - 1) * 22}px`; margin.appendChild(row);
        const number = document.createElement("span"); number.className = "line-numbers"; number.textContent = String(line); row.appendChild(number);
        const content = document.createElement("div"); content.className = "view-line"; content.style.top = row.style.top;
        content.textContent = line === 3 ? "changed" : `line ${line}`; lines.appendChild(content);
        if (side === "modified" && line === 3) {
          const marker = document.createElement("span"); marker.className = "gutter-insert"; row.appendChild(marker);
        }
      }
    }
  }
  (window as any).__hunkEvents = [];
  (window as any).gscNativeDiffOverlayToggle = (payload: string) => (window as any).__hunkEvents.push(JSON.parse(payload));
}

/** 실제 controller 계약과 같은 순서의 pending/ready snapshot을 만들어 group 배치를 검증한다. */
function snapshots(): HunkOverlaySnapshot[] {
  return [
    { originalUri: "gitsimplecompare:/waiting.ts?HEAD", uri: "gitsimplecompare:/waiting.ts?unstaged", path: "waiting.ts",
      action: "stage", revision: 1, lines: [], pending: true },
    { originalUri: "gitsimplecompare:/ready.ts?HEAD", uri: "gitsimplecompare:/ready.ts?unstaged", path: "ready.ts",
      action: "stage", revision: 1, lines: [{ side: "modified", line: 3, lineIds: ["unstaged:ready.ts#0:0"], checked: false }] },
  ];
}

for (const width of [390, 768, 1440]) {
  test(`Changes file clicks preserve staged and unstaged diff requests at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await mountChanges(page, await loadWebviewFixture("changes.small.en.json"));
    const staged = page.locator('.wt-files .row.file[data-stage="staged"]').first();
    const unstaged = page.locator('.wt-files .row.file[data-stage="unstaged"]').first();
    await staged.click();
    await expect.poll(async () => (await readPostedMessages(page)).filter((item: any) => item.type === "openWorkingChange")).toEqual([
      { type: "openWorkingChange", path: "src/app.ts", stage: "staged", status: "M" },
    ]);
    await unstaged.focus(); await page.keyboard.press("Enter");
    await expect.poll(async () => (await readPostedMessages(page)).filter((item: any) => item.type === "openWorkingChange")).toEqual([
      { type: "openWorkingChange", path: "src/app.ts", stage: "staged", status: "M" },
      { type: "openWorkingChange", path: "README.md", stage: "unstaged", status: "M" },
    ]);
    await page.screenshot({ path: info.outputPath(`changes-click-${width}.png`) });
    expect(errors).toEqual([]);
  });

  test(`a waiting diff reserves its group without stealing ready-file Hunk checkboxes at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 }); await page.setContent('<html lang="en"><head><title>Hunk groups fixture</title></head><body></body></html>');
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.evaluate(nativeDiffFixture); await page.addScriptTag({ content: rendererPatchScript() });
    const values = snapshots();
    await page.evaluate(value => (window as any).__gscNativeDiffOverlay.render(value), values);
    await expect(page.locator('[data-group="0"] input[type="checkbox"]')).toHaveCount(0);
    const checkbox = page.locator('[data-group="1"] input[type="checkbox"]'); await expect(checkbox).toHaveCount(1);
    await expect(checkbox).toHaveAttribute("title", "Stage this added line");
    await checkbox.check();
    await expect.poll(() => page.evaluate(() => (window as any).__hunkEvents.at(-1))).toMatchObject({
      uri: values[1].uri, checked: true, side: "modified", line: 3, lineIds: values[1].lines[0].lineIds,
    });
    await page.screenshot({ path: info.outputPath(`hunk-groups-${width}.png`) });
    // 대응 snapshot이 빠진 다중 diff에서는 첫 DOM을 다른 파일의 대상으로 추측하지 않는다.
    await page.evaluate(value => (window as any).__gscNativeDiffOverlay.render([value]), values[1]);
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
