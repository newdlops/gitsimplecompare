import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { commitPreparedIndex } from "../src/git/preparedIndexCommit";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

test("quiet prepared commits retain message and post-commit hooks", async t => {
  const f = await safetyFixture(t, "prepared-commit-hooks");
  await writeFile(join(f.directory, "hooks/prepare-commit-msg"),
    '#!/bin/sh\nprintf "\\nmessage from prepare hook\\n" >> "$1"\n', { mode: 0o755 });
  const post = join(f.directory, "hooks/post-commit");
  await writeFile(post, '#!/bin/sh\nprintf "post hook completed\\n" > "$0.called"\n', { mode: 0o755 });
  await writeFile(join(f.root, "tracked.txt"), "prepared content\n");
  await git(f.root, "add", "tracked.txt");
  await commitPreparedIndex(f.root, { title: "prepared subject", body: "original body", checkout: false });
  assert.equal(await git(f.root, "log", "-1", "--format=%B"), "prepared subject\n\noriginal body\n\nmessage from prepare hook");
  assert.equal(await readFile(`${post}.called`, "utf8"), "post hook completed\n");
  assert.equal(await git(f.root, "show", "HEAD:tracked.txt"), "prepared content");
  assert.equal(await git(f.root, "rev-parse", "HEAD^"), f.head);
});

test("a required signing failure remains visible and keeps the staged result", async t => {
  const f = await safetyFixture(t, "prepared-commit-signing"), signer = join(f.directory, "fixture-gpg");
  await writeFile(signer, '#!/bin/sh\n: > "$0.called"\nprintf "fixture signing refused\\n" >&2\nexit 1\n', { mode: 0o755 });
  await git(f.root, "config", "gpg.program", signer);
  await git(f.root, "config", "gpg.format", "openpgp");
  await git(f.root, "config", "commit.gpgSign", "true");
  await git(f.root, "config", "user.signingKey", "fixture-key");
  await writeFile(join(f.root, "tracked.txt"), "preserved staged content\n");
  await git(f.root, "add", "tracked.txt");
  const entries = await git(f.root, "ls-files", "--stage", "-z");
  const config = await readFile(join(f.root, ".git/config"));
  await assert.rejects(commitPreparedIndex(f.root, { title: "must sign", body: "preserved body", checkout: false }), /fixture signing refused/);
  assert.equal(await readFile(`${signer}.called`, "utf8"), "");
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
  assert.equal(await git(f.root, "ls-files", "--stage", "-z"), entries);
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "preserved staged content\n");
  assert.deepEqual(await readFile(join(f.root, ".git/config")), config);
});
