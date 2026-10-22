import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { canUseCompactReplayWorktree } from "../src/git/replayWorktreePolicy";
import { createPrOperationWorktree } from "../src/git/temporaryWorktree";
import { replayWorktreeFixture } from "./helpers/replayWorktreeFixture";
import { git } from "./helpers/gitSafetyFixture";

test("a tracked symlink ancestor of a relative hooks path requires full checkout", { skip: process.platform === "win32" }, async t => {
  const f = await replayWorktreeFixture(t), external = join(f.directory, "external"), marker = join(f.directory, "hook-ran");
  await mkdir(join(external, "hooks"), { recursive: true });
  await writeFile(join(external, "hooks/post-checkout"), `#!/bin/sh\ntest -f padding/keep-0000.txt || exit 1\nprintf ran > '${marker}'\n`, { mode: 0o755 });
  await symlink(external, join(f.root, "hook-link"));
  await git(f.root, "add", "hook-link"); await git(f.root, "commit", "-qm", "tracked hook ancestor");
  const head = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "config", "core.hooksPath", "hook-link/hooks");
  assert.equal(await git(f.root, "ls-tree", head, "--", "hook-link/hooks"), "", "Native ls-tree does not follow the tracked symlink");
  const before = await f.originalState(), ordinary = await createPrOperationWorktree(f.root, head);
  f.ownWorktree(ordinary);
  assert.equal(await readFile(marker, "utf8"), "ran", "The ordinary Native checkout executes the hook through its tracked ancestor");
  assert.deepEqual(await f.originalState(), before);
  assert.equal(await canUseCompactReplayWorktree(f.root, head, [f.source]), false);
});

test("a replay commit introducing a symlink hook ancestor prevents compact replay", { skip: process.platform === "win32" }, async t => {
  const f = await replayWorktreeFixture(t), external = join(f.directory, "external");
  await mkdir(join(external, "hooks"), { recursive: true });
  await writeFile(join(external, "hooks/prepare-commit-msg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await symlink(external, join(f.root, "new-hook-link"));
  await git(f.root, "add", "new-hook-link"); await git(f.root, "commit", "-qm", "new hook ancestor");
  const commit = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "config", "core.hooksPath", "new-hook-link/hooks");
  assert.equal(await canUseCompactReplayWorktree(f.root, f.beforeHead, [commit]), false);
});

test("a non-UTF8 absolute hooks configuration cannot be mistaken for a verified empty directory", { skip: process.platform === "win32" }, async t => {
  const f = await replayWorktreeFixture(t), hooks = Buffer.concat([Buffer.from(join(f.directory, "raw-hooks-")), Buffer.from([0xff])]);
  // APFS는 이 파일명 생성을 거부한다. Git config의 원본 바이트 손실 자체를 검증해 OS별 이름 규칙에 기대지 않는다.
  await appendFile(join(f.root, ".git/config"), Buffer.concat([Buffer.from("\n[core]\n hooksPath = "), hooks, Buffer.from("\n")]));
  assert.equal((await git(f.root, "config", "--get", "core.hooksPath")).includes("\ufffd"), true);
  assert.equal(await canUseCompactReplayWorktree(f.root, f.beforeHead, [f.source]), false);
});
