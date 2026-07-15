import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { runGit } from "../src/git/gitExec";
import { hasStagedChanges } from "../src/git/stagedChangesProbe";

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * staged probe를 실제 Git index와 검증할 격리 저장소를 만든다.
 * @returns 테스트 종료 시 삭제할 임시 저장소 루트
 */
async function createRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-staged-probe-"));
  await runGit(["init", "--quiet"], root);
  await runGit(["config", "user.name", "Staged Probe Test"], root);
  await runGit(["config", "user.email", "staged-probe@example.com"], root);
  await runGit(["config", "commit.gpgSign", "false"], root);
  return root;
}

/**
 * 저장소 상대 경로에 UTF-8 파일을 기록한다.
 * @param repoRoot 임시 Git 저장소 루트
 * @param filePath 저장소 상대 경로
 * @param content 기록할 본문
 */
async function put(
  repoRoot: string,
  filePath: string,
  content: string
): Promise<void> {
  const absolute = path.join(repoRoot, filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

test("unborn HEAD와 일반 HEAD에서 staged 변경만 빠르게 판정한다", async () => {
  const root = await createRepo();
  try {
    assert.equal(await hasStagedChanges(root), false);

    await put(root, "tracked.txt", "initial\n");
    assert.equal(await hasStagedChanges(root), false);
    await runGit(["add", "tracked.txt"], root);
    assert.equal(await hasStagedChanges(root), true);
    await runGit(["commit", "-m", "base"], root);

    await put(root, "tracked.txt", "working tree only\n");
    await put(root, "untracked.txt", "untracked\n");
    assert.equal(await hasStagedChanges(root), false);

    await runGit(["add", "tracked.txt"], root);
    assert.equal(await hasStagedChanges(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
