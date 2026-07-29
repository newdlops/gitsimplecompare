import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** 제거된 Reviews contribution이 manifest와 NLS에 다시 들어오지 않게 검증한다. */
test("Changes만 남고 Reviews activation·view·command·configuration·NLS는 없다", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const views = manifest.contributes.views.gitSimpleCompare;
  const changes = views.filter((view: { id: string }) => view.id === "gitSimpleCompare.changes");
  assert.equal(changes.length, 1);
  assert.equal("when" in changes[0], false);
  assert.equal(views.some((view: { id: string }) => view.id === "gitSimpleCompare.reviews"), false);
  assert.equal(manifest.contributes.commands.filter((command: { command: string }) => command.command === "gitSimpleCompare.showChanges").length, 1);
  assert.equal(manifest.contributes.commands.some((command: { command: string }) => command.command === "gitSimpleCompare.showReviews"), false);
  assert.equal("gitSimpleCompare.reviewWritesEnabled" in manifest.contributes.configuration.properties, false);
  assert.equal(manifest.activationEvents.some((event: string) => /reviews/i.test(event)), false);
  for (const file of ["package.nls.json", "package.nls.ko.json"]) {
    const nls = JSON.parse(readFileSync(file, "utf8"));
    assert.equal("view.reviews.name" in nls, false);
    assert.equal("cmd.showReviews" in nls, false);
    assert.equal("config.reviewWritesEnabled.desc" in nls, false);
  }
  const extension = readFileSync("src/extension.ts", "utf8");
  assert.match(extension, /gitSimpleCompare\.changes\.focus/);
  assert.doesNotMatch(extension, /showReviews|reviews\.focus|ReviewCenter/);
});
