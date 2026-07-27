import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

interface ViewContribution {
  id: string;
  when?: string;
}

/** package.json의 view/command 호환 계약을 작은 manifest test로 고정한다. */
test("sidebar mode keeps existing view IDs and mutually exclusive contributions", () => {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
    contributes: { commands: Array<{ command: string }>; views: { gitSimpleCompare: ViewContribution[] } };
  };
  const views = manifest.contributes.views.gitSimpleCompare;
  const changes = views.find((view) => view.id === "gitSimpleCompare.changes");
  const reviews = views.find((view) => view.id === "gitSimpleCompare.reviews");

  assert.deepEqual(changes?.when, "gitSimpleCompare.sidebarMode != reviews");
  assert.deepEqual(reviews?.when, "gitSimpleCompare.sidebarMode == reviews");
  assert.ok(manifest.contributes.commands.some((item) => item.command === "gitSimpleCompare.showChanges"));
  assert.ok(manifest.contributes.commands.some((item) => item.command === "gitSimpleCompare.showReviews"));
});
