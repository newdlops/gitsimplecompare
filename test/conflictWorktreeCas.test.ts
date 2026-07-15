import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  claimConflictWorkingLeaf,
  readConflictWorkingLeaf,
} from "../src/git/conflictWorktreeCas";

test(
  "claim 뒤 parent가 외부 symlink로 교체되면 target에 desired bytes를 쓰지 않는다",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gsc-conflict-parent-fence-"));
    const parent = path.join(root, "worktree");
    const heldParent = path.join(root, "held-worktree");
    const outside = path.join(root, "outside");
    try {
      await Promise.all([mkdir(parent), mkdir(outside)]);
      const target = path.join(parent, "choice.txt");
      await writeFile(target, "original\n", "utf8");
      const claim = await claimConflictWorkingLeaf(target);
      await rename(parent, heldParent);
      await writeFile(path.join(outside, "choice.txt"), "outside victim\n", "utf8");
      await symlink(outside, parent);

      await assert.rejects(
        claim.install({ kind: "regular", buffer: Buffer.from("desired\n"), mode: "100644" }),
        /parent changed/i
      );
      assert.equal(await readFile(path.join(outside, "choice.txt"), "utf8"), "outside victim\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test("같은 bytes로 재생성된 Result leaf는 이전 version의 claim을 거부한다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-conflict-leaf-generation-"));
  const target = path.join(root, "result.txt");
  const held = path.join(root, "previous-result.txt");
  try {
    await writeFile(target, "same conflict\n", "utf8");
    const displayed = await readConflictWorkingLeaf(target);
    await rename(target, held);
    await writeFile(target, "same conflict\n", "utf8");

    await assert.rejects(
      claimConflictWorkingLeaf(target, displayed.version),
      /changed|reload/i
    );
    assert.equal(await readFile(target, "utf8"), "same conflict\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claim의 rename과 rollback은 원본 Result version을 안정적으로 복구한다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-conflict-version-rollback-"));
  const target = path.join(root, "result.txt");
  try {
    await writeFile(target, "original\n", "utf8");
    const displayed = await readConflictWorkingLeaf(target);
    const claim = await claimConflictWorkingLeaf(target, displayed.version);
    await claim.install({
      kind: "regular",
      buffer: Buffer.from("temporary choice\n"),
      mode: "100644",
    });
    await claim.rollback();

    const restored = await readConflictWorkingLeaf(target);
    assert.equal(restored.version, displayed.version);
    assert.equal(await readFile(target, "utf8"), "original\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
