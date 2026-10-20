// 실제 등록된 stash 명령·native file picker·읽기 전용 diff provider를 전용 Host에서 함께 검증한다.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { runGit } from "../../src/git/gitExec";
import { parseRefUri } from "../../src/utils/uri";
import { IsolatedTestWindow } from "../helpers/isolatedTestWindow";

/** 전용 UI/명령 준비만 짧게 관찰하고 실패하면 검사한 조건을 남긴다. */
async function until<T>(label: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await check(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Isolated stash smoke timed out: ${label}`);
}

/**
 * 실제 명령 팔레트 등록 경로로 saved/untracked와 staged 내용을 읽고 HEAD/index/작업 파일 보존을 확인한다.
 * @returns Native picker 선택과 두 virtual diff의 실제 본문이 검증된 뒤 완료한다.
 */
export async function run(): Promise<void> {
  const root = process.env.GSC_EXTENSION_TEST_FIXTURE!, profile = process.env.GSC_EXTENSION_TEST_PROFILE!;
  assert.ok(root && root.startsWith("/private/tmp/gsc-extension-smoke-"));
  assert.equal(vscode.workspace.workspaceFolders?.[0].uri.fsPath, root);
  const owned = new IsolatedTestWindow(Number(process.env.GSC_TEST_MAIN_INSPECTOR_PORT), profile);
  await owned.connect(); await owned.focus();
  const extension = vscode.extensions.getExtension("newdlops.gitsimplecompare"); assert.ok(extension); await extension.activate();
  const git = async (args: string[]) => (await runGit(args, root)).trim();
  await git(["add", ".vscode/settings.json"]); await git(["commit", "-qm", "keep isolated fixture settings"]);
  await writeFile(join(root, "sample.txt"), "saved staged content\n"); await git(["add", "sample.txt"]);
  await writeFile(join(root, "sample.txt"), "saved staged and working content\n");
  await writeFile(join(root, "saved-new.txt"), "saved untracked content\n");
  await git(["stash", "push", "-qum", "inspect saved content"]);
  const hash = await git(["rev-parse", "refs/stash"]), before = await git(["status", "--porcelain=v1", "-uall"]), head = await git(["rev-parse", "HEAD"]);
  const target = { repoRoot: root, ref: "stash@{0}", hash };
  await vscode.commands.executeCommand("gitSimpleCompare.showChanges");
  await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges");
  let selectionError: unknown;
  await until("registered repository", async () => {
    try { return await vscode.commands.executeCommand("gitSimpleCompare.loadStashFiles", target) || undefined; }
    catch (error) { if (selectionError === undefined) console.log("Waiting for stash repository", error); selectionError = error; return undefined; }
  });
  try {
    /** 실제 파일 선택기에서 검색·선택한 뒤 열린 가상 문서가 저장된 Git 내용과 같은지 확인한다. */
    const inspect = async (command: string, title: string, file: string, ref: string, expected: string) => {
      await owned.focus();
      const opening = vscode.commands.executeCommand(command, target);
      await until("native stash file picker", async () => (await owned.quickPickState()).visible ? true : undefined);
      await owned.filterQuickPick(file, title);
      await until("filtered stash file", async () => (await owned.quickPickState()).selected.includes(file) ? true : undefined);
      await owned.acceptQuickPick(file); await opening;
      const input = await until("native read-only stash diff", async () => {
        const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if (!(active instanceof vscode.TabInputTextDiff)) return undefined;
        return parseRefUri(active.modified).ref === ref ? active : undefined;
      });
      assert.equal(input.original.scheme, "gitsimplecompare"); assert.equal(input.modified.scheme, "gitsimplecompare");
      assert.equal(parseRefUri(input.modified).repoRoot, root);
      assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), expected);
    };
    await inspect("gitSimpleCompare.viewStashContents", "View Stash Contents", "saved-new.txt", `${hash}^3`, "saved untracked content\n");
    await inspect("gitSimpleCompare.viewStagedStashContents", "View Staged Stash Changes", "sample.txt", `${hash}^2`, "saved staged content\n");
    assert.equal(await git(["status", "--porcelain=v1", "-uall"]), before); assert.equal(await git(["rev-parse", "HEAD"]), head);
    assert.equal(await git(["rev-parse", "refs/stash"]), hash);
    await writeFile("/private/tmp/gsc-stash-native-final.png", await owned.screenshot());
    console.log("PASS: registered stash commands open native readonly diffs for saved untracked and staged contents; HEAD, stash and worktree preserved.");
  } finally { owned.close(); }
}
