import { expect, test } from "@playwright/test";
import { buildSync } from "esbuild";
import { resolve } from "node:path";
import { nativeConflictOverlayRendererScript } from "../../src/providers/nativeConflictOverlayPatch";
import type { ConflictDocument } from "../../src/git/conflictService";

// 실제 표시 모델을 VS Code의 l10n 대역과 번들링해 renderer fixture에서도 제품 문구를 검사한다.
const presentationScript = buildSync({ entryPoints: ["src/ui/conflictOverlayPresentation.ts"], bundle: true,
  write: false, format: "iife", platform: "browser", globalName: "GscConflictPresentation",
  alias: { vscode: resolve("test/helpers/vscodeMock.ts") }, logLevel: "silent" }).outputFiles[0].text;

/** 긴 경로와 커밋 제목, 나중 단계 영향이 있는 실제 프로토콜 형태의 충돌 snapshot이다. */
function conflictDocument(): ConflictDocument {
  const side = { exists: true, kind: "text" as const, content: "content", label: "Current", ref: "index stage 2" };
  return { rel: "src/충돌/very-long-feature-name/keep-user-edits-and-review-context.ts", operation: "rebase",
    context: { operation: "rebase" }, base: { ...side, stage: 1 }, current: { ...side, stage: 2 },
    incoming: { ...side, stage: 3, label: "Incoming", ref: "index stage 3" },
    result: "editable Result", resultState: { exists: true, kind: "text" }, sourceVersion: "source",
    resultVersion: "result", both: "both", bothAvailable: true, metadataState: "pending" };
}

for (const width of [390, 768, 1440]) {
  test(`native conflict details load, retry and complete without blocking Result at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent(`<body><main class="editor-group-container active"><section class="editor-instance">
      <div class="monaco-editor focused"><div class="overflow-guard"><textarea aria-label="Result">editable Result</textarea></div></div>
      </section></main></body>`);
    await page.addStyleTag({ content: `html,body{margin:0;--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      --vscode-font-size:13px;--vscode-foreground:#ccc;--vscode-descriptionForeground:#aaa;--vscode-editor-background:#1e1e1e;
      --vscode-editorWidget-background:#252526;--vscode-editorWidget-border:#454545;--vscode-focusBorder:#007fd4;
      --vscode-textLink-foreground:#4daafc;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;
      --vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#fff;
      --vscode-badge-background:#4d4d4d;--vscode-badge-foreground:#fff;--vscode-editorWarning-foreground:#cca700;
      --vscode-testing-iconPassed:#2ea043;background:#1e1e1e;color:#ccc;font-family:var(--vscode-font-family)}
      .editor-group-container,.editor-instance,.monaco-editor,.overflow-guard{height:100vh;width:100%;position:relative}
      textarea{box-sizing:border-box;position:absolute;top:560px;width:100%;height:180px;resize:none;background:#1e1e1e;color:#ddd;border:1px solid #555;padding:16px;font:13px monospace}` });
    await page.evaluate(() => {
      const w = window as any;
      w.__actions = []; w.gscNativeDiffOverlayToggle = (value: string) => w.__actions.push(JSON.parse(value));
    });
    await page.addScriptTag({ content: presentationScript });
    await page.addScriptTag({ content: nativeConflictOverlayRendererScript() });
    const document = conflictDocument();
    let revision = 0;
    /** 동일 native URI에 새 설명 snapshot만 게시해 Result 편집과 분리된 갱신을 재현한다. */
    const render = async (busy = false) => page.evaluate(({ document, revision, busy }) => {
      const w = window as any;
      w.__gscNativeConflictOverlay.render({ uri: "gitsimplecompare-conflict:file", sessionId: "fixture", revision,
        editorVersion: 1, busy, virtual: false, canEditBlocks: true, canAcceptBoth: true, canMarkResolved: true,
        canOpenMergeEditor: true, blocks: [], presentation: w.GscConflictPresentation.buildConflictOverlayPresentation(document) });
    }, { document, revision: ++revision, busy });
    await render();
    const overlay = page.getByRole("complementary", { name: "Resolve Conflict" });
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("Loading conflict details…");
    await expect(overlay).not.toContainText("Expected to remain");
    await page.getByRole("textbox", { name: "Result" }).fill("user edits while details load");
    await page.screenshot({ path: `/tmp/gsc-72058-conflict-loading-${width}.png` });
    document.metadataState = "error";
    await render();
    await expect(overlay).toContainText("Conflict details unavailable");
    const reload = page.getByRole("button", { name: "Reload conflict sources and the on-disk Result", exact: true });
    await reload.focus(); await page.keyboard.press("Enter");
    expect(await page.evaluate(() => (window as any).__actions.at(-1).action)).toBe("reload");
    await page.screenshot({ path: `/tmp/gsc-72058-conflict-error-${width}.png` });
    document.metadataState = "ready";
    document.current = { ...document.current, ref: "HEAD", commit: "a".repeat(40), subject: "Accumulated branch changes" };
    document.incoming = { ...document.incoming, ref: "REBASE_HEAD", commit: "b".repeat(40), subject: "Preserve concurrent editing and reload validation across multiple worktrees" };
    document.context.rebase = { branch: "feature/conflict-performance", remainingSteps: 2, pendingExecSteps: 0,
      pendingComplexSteps: 0, futurePathAnalysisComplete: true, futurePathChanges: [], futurePathChangeCount: 0,
      futurePathChangesOmitted: 0, fileOutcome: "expected-final" };
    await render();
    await expect(overlay).toContainText("Expected to remain in the final branch");
    await expect(page.getByRole("textbox", { name: "Result" })).toHaveValue("user edits while details load");
    expect(await overlay.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await overlay.locator(".gsc-native-conflict-body").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    for (const button of await overlay.getByRole("button").all()) {
      await expect(button).toHaveAttribute("title", /.+/); await expect(button).toHaveAttribute("aria-label", /.+/);
    }
    await page.screenshot({ path: `/tmp/gsc-72058-conflict-ready-${width}.png` });
    await render(true);
    await expect(reload).toBeDisabled();
    await render();
    await page.getByRole("button", { name: "Collapse conflict context", exact: true }).click();
    await expect(overlay.locator(".gsc-native-conflict-body")).toBeHidden();
    await page.getByRole("button", { name: "Expand conflict context", exact: true }).click();
    await expect(overlay.locator(".gsc-native-conflict-body")).toBeVisible();
    expect(errors).toEqual([]);
  });
}
