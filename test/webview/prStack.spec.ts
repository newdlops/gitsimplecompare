import { expect, test } from "@playwright/test";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { dispatchWebviewMessage, mountPullRequestStackGraph, readPostedMessages } from "./webviewHarness";

/** 실제 production Graph Stack asset의 edit/delete payload와 접근성/복구 상태를 검증한다. */
test("PR stack local management posts actions and restores busy/focus state", async ({ page }) => {
  const fixture = await loadWebviewFixture<any>("pr-stack.local-parent.en.json");
  await mountPullRequestStackGraph(page, fixture.payload);
  const layerChip = page.locator("[data-stack-branch]");
  await expect(layerChip).toHaveCount(1);
  await layerChip.dispatchEvent("click");
  const edit = page.getByRole("button", { name: /Edit local Stack parent/ });
  const remove = page.getByRole("button", { name: /Delete local Stack metadata/ });
  expect(await page.evaluate(() => {
    const detail = document.getElementById("detail")!;
    const glyph = detail.querySelector(".codicon-edit")!;
    const style = getComputedStyle(detail);
    return style.backgroundColor !== "rgb(255, 255, 255)" && style.color !== "rgb(0, 0, 0)" &&
      getComputedStyle(glyph).fontFamily.includes("codicon") && getComputedStyle(glyph, "::before").content !== "none";
  })).toBe(true);
  for (const button of [edit, remove]) for (const attribute of ["title", "data-tooltip", "aria-label"]) await expect(button).toHaveAttribute(attribute, /.+/);
  await edit.click();
  expect(await readPostedMessages(page)).toContainEqual({ type: "pullRequestStackAction", action: "editParent", branch: fixture.payload.layers[0].branch, parentHash: undefined });
  await dispatchWebviewMessage(page, { type: "pullRequestStackActionState", busy: true });
  await expect(remove).toBeDisabled();
  await dispatchWebviewMessage(page, { type: "pullRequestStackActionState", busy: false });
  await expect(remove).toBeEnabled();
  await remove.click();
  expect(await readPostedMessages(page)).toContainEqual({ type: "pullRequestStackAction", action: "deleteLocal", branch: fixture.payload.layers[0].branch, parentHash: undefined });
  await dispatchWebviewMessage(page, { type: "pullRequestStackActionState", busy: true });
  await dispatchWebviewMessage(page, { type: "pullRequestStackActionState", busy: false });
  await dispatchWebviewMessage(page, { type: "pullRequestStackSnapshot", snapshot: { repository: fixture.payload.repository, stacks: [], layers: [] } });
  await expect(page.getByText("No stack layers yet. Add one from a parent branch to start.")).toBeVisible();
  await expect(page.locator("#graph-pr-stacks")).toBeFocused();
});

/** GitHub-only relation은 동일 production detail에서 관리 버튼을 이유와 함께 disabled로 표시한다. */
test("PR stack GitHub-only management is disabled with explanatory tooltip", async ({ page }) => {
  await mountPullRequestStackGraph(page, { repository:"fixture", stacks:[], layers:[{ branch:"remote/only", parentBranch:"main", publishedParentBranch:"main", headHash:"child", depth:0, childBranches:[], local:false, remoteDiverged:false, needsRestack:false, githubOnly:true, pullRequest:{ number:7, state:"OPEN" } }] });
  const layerChip = page.locator("[data-stack-branch]");
  await expect(layerChip).toHaveCount(1);
  await layerChip.dispatchEvent("click");
  const disabled = page.locator(".pr-stack-icon-button:disabled");
  await expect(disabled).toHaveCount(2);
  for (const button of await disabled.all()) { await expect(button).toHaveAttribute("title", /GitHub-only/); await expect(button).toHaveAttribute("aria-label", /GitHub-only/); }
});
