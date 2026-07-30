import { expect, test } from "@playwright/test";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { dispatchWebviewMessage, mountChanges, mountGraphContextMenu, mountPullRequestPreview, readPostedMessages } from "./webviewHarness";
test("Changes renders production payload without Reviews navigation", async ({ page }) => { const fixture=await loadWebviewFixture("changes.small.en.json"); await page.setViewportSize(fixture.viewport); await mountChanges(page, fixture); await expect(page.getByText("Reviews", { exact: true })).toHaveCount(0); await expect(
  page.locator(
    '.section[data-section="changes"] #changes-group-files-staged ' +
      '.row.file[data-stage="staged"][data-path="src/app.ts"] > .name'
  )
).toBeVisible(); for(const id of ["history","stashes"]){const header=page.locator(`.section[data-section="${id}"] > .section-header`);const body=page.locator(`#section-body-${id}`);await header.focus();await page.keyboard.press("Tab");await expect(body).toBeFocused();await page.keyboard.press("PageDown");await expect.poll(()=>body.evaluate(element=>element.scrollTop)).toBeGreaterThan(0);} });

test("Changes expected hook failure copies only the current error log", async ({ page }) => {
  const fixture: any = await loadWebviewFixture("changes.small.en.json");
  const hookFailure = {
    likelyHook: true, hookName: "pre-commit", summary: "Lint failed", items: [],
    outputLines: 2, truncated: false, occurredAt: "2026-01-01T00:00:00.000Z",
    operation: "staged", origin: "hookPreflight",
  };
  const render = (failure: unknown, canCopyCommitHookErrorLog: boolean) => ({
    ...fixture.payload,
    commit: { ...fixture.payload.commit, failure, canCopyCommitHookErrorLog },
  });
  await page.setViewportSize(fixture.viewport);
  await mountChanges(page, { ...fixture, payload: render(hookFailure, true) });

  const retry = page.getByRole("button", { name: "Run checks again" });
  const copy = page.getByRole("button", { name: "Copy error log" });
  await expect(retry).toBeVisible(); await expect(copy).toBeVisible();
  expect(await copy.evaluate((element) => element.previousElementSibling?.id)).toBe("failure-retry");
  await expect(page.getByRole("button", { name: "Show full output" })).toHaveCount(0);
  for (const attribute of ["title", "data-tooltip", "aria-label"]) {
    await expect(copy).toHaveAttribute(attribute, "Copy error log");
  }
  await copy.focus(); await expect(copy).toBeFocused();
  expect(await copy.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  await copy.click();
  expect(await readPostedMessages(page)).toContainEqual({ type: "copyCommitHookPreflightFailure" });
  await retry.click();
  expect(await readPostedMessages(page)).toContainEqual({
    type: "runCommitHookPreflight", message: "",
  });
  await dispatchWebviewMessage(page, {
    type: "render", payload: render(undefined, false),
  });
  await expect(copy).toHaveCount(0);

  await dispatchWebviewMessage(page, {
    type: "render", payload: render({ ...hookFailure, likelyHook: false, origin: "commit", operation: "commit" }, false),
  });
  await expect(page.getByRole("button", { name: "Show full output" })).toBeVisible();
});

test("Graph interactive rebase context action sends the clicked row hash", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await mountGraphContextMenu(page);

  await page.locator('.row[data-hash="selected-row"]').click({ button: "right" });
  const action = page.getByRole("menuitem", { name: "Interactive Rebase From Here" });
  await expect(action).toBeVisible();
  await expect(action).toHaveAttribute("title", "Interactive Rebase From Here");
  await action.click();

  expect(await readPostedMessages(page)).toContainEqual({
    type: "prepareGraphRebase",
    hash: "selected-row",
  });
});

test("Preview uses production content, state, publish and existing-PR actions", async ({ page }) => { const errors: Error[]=[]; page.on("pageerror",error=>errors.push(error)); const fixture=await loadWebviewFixture("pr-preview.populated.en.json"); await mountPullRequestPreview(page,fixture); await expect(page.getByText("Prepare deterministic Pull Request preview coverage")).toBeVisible(); const create=page.getByRole("button",{name:"Create Pull Request on GitHub"}); await expect(create).toBeVisible(); await expect(create).toBeEnabled(); await page.getByRole("tab",{name:/Changed files/}).click(); await expect(page.getByText("src/previewFixture.ts")).toBeVisible(); expect(await import("./webviewHarness").then(x=>x.readPersistedState(page))).toEqual({activeTab:"files",filesReviewMode:"continuous",diffLayoutMode:"unified",inspectorWidth:300,localViewed:[]}); await page.getByRole("tab",{name:"Conversation"}).click(); await create.click(); expect(await readPostedMessages(page)).toContainEqual({type:"publishPullRequest",sourceBranch:fixture.payload.sourceBranch,targetBranch:fixture.payload.targetBranch,title:fixture.payload.title,body:fixture.payload.body}); await expect(page.getByRole("button",{name:"Open pull request on GitHub"})).toHaveCount(0); await dispatchWebviewMessage(page,{type:"preview",preview:{...fixture.payload,existingPr:{number:1,url:"https://example.test/pr/1"}}}); const button=page.getByRole("button",{name:"Open pull request on GitHub"}); await expect(button).toBeVisible(); for(const attribute of ["data-tooltip","aria-label"])await expect(button).toHaveAttribute(attribute,"Open pull request on GitHub"); await button.click(); expect(await readPostedMessages(page)).toContainEqual({type:"openExistingPr"}); expect(errors).toEqual([]); });

test("Preview quick edit is available only for the checked-out source file", async ({ page }) => {
  const fixture:any = await loadWebviewFixture("pr-preview.populated.en.json");
  await mountPullRequestPreview(page, fixture, {
    openQuickEditor: "Quick edit and stage on save",
    quickEditNeedsCheckout: "Check out the source branch to use quick edit",
    quickEditDeleted: "Deleted files cannot be quick edited.",
  });
  await page.getByRole("tab", { name: /Changed files/ }).click();
  const edit = page.getByRole("button", {
    name: "Quick edit and stage on save",
  }).first();
  await expect(edit).toBeVisible();
  for (const attribute of ["title", "data-tooltip", "aria-label"]) {
    await expect(edit).toHaveAttribute(
      attribute,
      "Quick edit and stage on save"
    );
  }
  await edit.hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Quick edit and stage on save"
  );
  await edit.click();
  expect(await readPostedMessages(page)).toContainEqual({
    type: "openQuickEditor",
    path: fixture.payload.previewFiles[0].path,
  });

  await dispatchWebviewMessage(page, {
    type: "preview",
    preview: { ...fixture.payload, sourceBranch: "feature/not-checked-out" },
  });
  const unavailableEdits = page.getByRole("button", {
    name: "Check out the source branch to use quick edit",
  });
  await expect(unavailableEdits).toHaveCount(fixture.payload.previewFiles.length);
  await expect(unavailableEdits.first()).toBeDisabled();
  await expect(unavailableEdits.first()).toHaveAttribute("aria-disabled", "true");
});

test("Preview renders a composed Quick Edit replacement at its original line", async ({ page }) => {
  const fixture:any = await loadWebviewFixture("pr-preview.populated.en.json");
  const file = {
    status: "M",
    path: "review.txt",
    additions: 1,
    deletions: 1,
    comments: [],
    patch: [
      "diff --git a/review.txt b/review.txt",
      "--- a/review.txt",
      "+++ b/review.txt",
      "@@ -1,3 +1,3 @@",
      " line 1",
      "-base line",
      "+quick edited",
      " line 3",
    ].join("\n"),
  };
  await mountPullRequestPreview(page, {
    ...fixture,
    payload: {
      ...fixture.payload,
      files: [file],
      previewFiles: [file],
    },
  });
  await page.getByRole("tab", { name: /Changed files/ }).click();

  const replacement = page.locator(
    '.diff-row[data-diff-kind="add"][data-new-line="2"]'
  );
  await expect(replacement).toContainText("quick edited");
  await expect(page.getByText("remote change", { exact: true })).toHaveCount(0);
});

test("Preview Conversation rail resizes, persists, and keeps line statistics accessible", async ({ page }) => {
  const fixture:any = await loadWebviewFixture("pr-preview.populated.en.json");
  const files = [
    { ...fixture.payload.previewFiles[0], path: "src/a/very/long/nested/path/with-a-descriptive-preview-file-name.ts", oldPath: "src/a/old-preview-file-name.ts", additions: 0, deletions: 0 },
    { ...fixture.payload.previewFiles[1], path: "src/missing-numstat.bin", additions: undefined, deletions: null },
  ];
  const denseFiles = [
    ...files,
    ...Array.from({ length: 50 }, (_, index) => ({
      ...fixture.payload.previewFiles[index % fixture.payload.previewFiles.length],
      path: `src/dense-${String(index).padStart(2, "0")}/file-${index}.ts`,
      additions: index,
      deletions: index % 4,
    })),
  ];
  const preview = { ...fixture.payload, previewFiles: files };
  await page.setViewportSize({ width: 1280, height: 844 });
  await mountPullRequestPreview(page, { ...fixture, payload: preview });
  const splitter = page.getByRole("separator", { name: "Resize changed files inspector" });
  await expect(splitter).toHaveAttribute("aria-valuemin", "220");
  await expect(splitter).toHaveAttribute("aria-valuemax", "420");
  await expect(splitter).toHaveAttribute("aria-valuenow", "300");
  await splitter.focus(); await page.keyboard.press("ArrowLeft"); await expect(splitter).toHaveAttribute("aria-valuenow", "320");
  await page.keyboard.press("ArrowRight"); await expect(splitter).toHaveAttribute("aria-valuenow", "300");
  await page.keyboard.press("Home"); await expect(splitter).toHaveAttribute("aria-valuenow", "220");
  await page.keyboard.press("End"); await expect(splitter).toHaveAttribute("aria-valuenow", "420");
  await page.keyboard.press("Home");
  const box = await splitter.boundingBox(); if (!box) throw new Error("Missing Conversation splitter box");
  await page.mouse.move(box.x + 2, box.y + 20); await page.mouse.down(); await page.mouse.move(box.x - 100, box.y + 20); await page.mouse.up();
  await expect(splitter).toHaveAttribute("aria-valuenow", "322");
  await dispatchWebviewMessage(page, { type: "preview", preview });
  const persistedSplitter = page.getByRole("separator", { name: "Resize changed files inspector" });
  await expect(persistedSplitter).toHaveAttribute("aria-valuenow", "322");
  await dispatchWebviewMessage(page, {
    type: "preview",
    preview: { ...preview, previewFiles: denseFiles },
  });
  const renamed = page.locator('[data-preview-file="src/a/very/long/nested/path/with-a-descriptive-preview-file-name.ts"]');
  await expect(renamed).toHaveText(/\+0.*-0/); await expect(renamed).toHaveAttribute("aria-label", /old-preview-file-name\.ts → src\/a\/very/);
  const unavailable = page.locator('[data-preview-file="src/missing-numstat.bin"]');
  await expect(unavailable).toHaveText(/\+\?.*-\?/); await expect(unavailable).toHaveAttribute("aria-label", /Line counts unavailable/);
  const tree = page.locator(".preview-file-tree");
  const treeContent = page.locator(".preview-file-tree__content");
  await expect.poll(() =>
    tree.evaluate((element) => element.scrollWidth > element.clientWidth)
  ).toBe(true);
  expect(await treeContent.evaluate((element) => {
    const rows = element.querySelectorAll(
      ".preview-tree-folder > summary, .preview-tree-file"
    );
    return element.getBoundingClientRect().height < rows.length * 36;
  })).toBe(true);
  await tree.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect.poll(() => tree.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(renamed.locator(".preview-tree-file__stats")).toBeInViewport();
  await tree.evaluate((element) => { element.scrollLeft = 0; });
  await expect.poll(() => tree.evaluate((element) => element.scrollLeft)).toBe(0);
  await page.setViewportSize({ width: 768, height: 844 }); await expect(persistedSplitter).toBeHidden();
  await page.setViewportSize({ width: 360, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("Preview diff uses localized dynamic labels without narrow overflow", async ({ page }) => {
  const errors: Error[]=[]; page.on("pageerror", error => errors.push(error));
  const fixture:any=await loadWebviewFixture("pr-preview.populated.en.json"); await page.setViewportSize({width:320,height:900});
  const comment={body:"unmatched",author:"",line:undefined}; const addComment=(files:any[])=>files.map((file:any,index:number)=>index?file:{...file,comments:[...(file.comments||[]),comment]}); const preview={...fixture.payload,files:addComment(fixture.payload.files),previewFiles:addComment(fixture.payload.previewFiles)};
  await mountPullRequestPreview(page,{...fixture,payload:preview},{diffUnavailable:"없음",diffLinesTruncated:"잘림 {0}",diffExpandUnchangedLines:"펼치기 {0}",diffShowMoreUnchangedLines:"더 보기 {0}/{1}",diffCollapseUnchangedLines:"접기 {0}",diffCollapseUnchanged:"접기",diffLine:"줄 {0}",diffReview:"검토",diffUnknownAuthor:"알 수 없음"});
  await page.getByRole("tab",{name:/Changed files/}).click(); const expand=page.locator(".diff-context-toggle[data-expand-context]").first(); await expect(expand).toHaveText(/더 보기/); for(const key of ["title","aria-label","data-tooltip"]) await expect(expand).toHaveAttribute(key,/펼치기/); await expand.click(); const collapse=page.locator(".diff-context-toggle[data-collapse-context]").first(); await expect(collapse).toHaveText("접기"); for(const key of ["title","aria-label","data-tooltip"]) await expect(collapse).toHaveAttribute(key,/접기/);
  await expect(page.getByText("검토")).toBeVisible(); await expect(page.getByText("알 수 없음")).toBeVisible(); await expect(page.getByText("줄 검토")).toHaveCount(0); expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true); expect(errors).toEqual([]);
});
