import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { LineHistoryService, parseLineHistory } from "../src/git/lineHistoryService";
import { decodeGitQuotedPath } from "../src/utils/gitQuotedPath";
import { readFileAtRef } from "../src/git/fileContentReader";
import { safetyFixture, git, commitText } from "./helpers/gitSafetyFixture";

test("line history follows the original line across insertions, rename, quoted Korean paths and root creation", async t => {
  const { root } = await safetyFixture(t, "line-history");
  const oldPath = "원본\tfile:*.ts", newPath = "이름 변경\tfile:*.ts";
  await writeFile(join(root, oldPath), "const value = 1;\nconst other = true;\n");
  await git(root, "add", "--", oldPath); await git(root, "commit", "-qm", "create target");
  const first = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, oldPath), "const value = 2;\nconst other = true;\n");
  await git(root, "commit", "-qam", "change selected line"); const second = await git(root, "rev-parse", "HEAD");
  await git(root, "mv", "--", oldPath, newPath); await git(root, "commit", "-qm", "rename only");
  await writeFile(join(root, newPath), "// inserted above\nconst value = 3;\nconst other = true;\n");
  await git(root, "commit", "-qam", "change after rename"); const third = await git(root, "rev-parse", "HEAD");
  await commitText(root, "unrelated\n", "unrelated commit");
  await git(root, "config", "diff.noprefix", "true");
  const index = await git(root, "ls-files", "--stage", "-z");
  const head = await git(root, "rev-parse", "HEAD"), content = await readFile(join(root, newPath), "utf8");
  const service = new LineHistoryService(root), anchor = await service.anchor(join(root, newPath), 2);
  assert.deepEqual(anchor, { hash: third, path: newPath, line: 2 });
  const page = await service.read(anchor!);
  assert.deepEqual(page.entries.map(entry => entry.hash), [third, second, first]);
  assert.equal(page.entries[0].path, newPath);
  assert.equal(page.entries[1].path, oldPath);
  assert.equal(page.entries[2].path, oldPath);
  assert.equal(page.entries[0].line, 2);
  assert.equal(page.hasMore, false);
  const unchanged = await service.anchor(join(root, newPath), 3);
  assert.deepEqual(unchanged, { hash: first, path: oldPath, line: 2 });
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.equal(await git(root, "ls-files", "--stage", "-z"), index);
  assert.equal(await readFile(join(root, newPath), "utf8"), content);
});

test("history pages keep the immutable blamed revision and stop at the requested limit", async t => {
  const { root, head } = await safetyFixture(t, "line-history-pages");
  const hashes = [head];
  for (let i = 1; i < 5; i++) hashes.push(await commitText(root, `version ${i}\n`, `selected change ${i}`));
  const service = new LineHistoryService(root), anchor = await service.anchor("tracked.txt", 1);
  const first = await service.read(anchor!, 2);
  assert.equal(first.entries.length, 2); assert.equal(first.hasMore, true);
  await commitText(root, "later work\n", "after the picker opened");
  const second = await service.read(anchor!, 5);
  assert.deepEqual(second.entries.map(entry => entry.hash), hashes.reverse());
  assert.equal(second.hasMore, false);
  assert.equal(second.entries.at(-1)?.baseRef, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  assert.equal(await readFileAtRef(root, second.entries.at(-1)!.baseRef, "tracked.txt"), "");
  assert.equal(await readFileAtRef(root, second.entries.at(-1)!.hash, "tracked.txt"), "base\n");
});

test("uncommitted, untracked, invalid and cancelled line history requests do not fabricate a commit", async t => {
  const { root } = await safetyFixture(t, "line-history-empty");
  const service = new LineHistoryService(root);
  await writeFile(join(root, "tracked.txt"), "working changes\n");
  assert.equal(await service.anchor("tracked.txt", 1), undefined);
  await writeFile(join(root, "untracked.txt"), "untracked\n");
  assert.equal(await service.anchor("untracked.txt", 1), undefined);
  assert.equal(await service.anchor("../outside.txt", 1), undefined);
  await assert.rejects(service.read({ hash: "HEAD", path: "tracked.txt", line: 1 }), /Invalid/);
  await assert.rejects(service.read({ hash: "a".repeat(40), path: "../outside.txt", line: 1 }), /Invalid/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.read({ hash: "a".repeat(40), path: "tracked.txt", line: 1 }, 30, controller.signal));
});

test("C-quoted Git paths preserve UTF-8 bytes, backslashes and control characters", () => {
  assert.equal(decodeGitQuotedPath('"\\354\\233\\220\\353\\263\\270\\tfile\\\\name.ts"'), "원본\tfile\\name.ts");
  assert.equal(decodeGitQuotedPath("unquoted 한글.ts"), "unquoted 한글.ts");
  assert.deepEqual(parseLineHistory("", "file.ts"), []);
});
