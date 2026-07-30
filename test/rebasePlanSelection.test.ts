import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { RebaseService } from "../src/git/rebaseService";

const execFileAsync = promisify(execFile);

/**
 * 셸을 거치지 않고 테스트 저장소에서 Git 명령을 실행한다.
 * @param repoRoot 명령을 실행할 임시 저장소
 * @param args Git 하위 명령과 인자
 * @returns 앞뒤 공백을 제거한 표준 출력
 */
async function git(repoRoot: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      HUSKY: "0",
    },
  });
  return result.stdout.trim();
}

/**
 * 사용자 전역 설정과 분리된 main 브랜치 저장소와 root 커밋을 만든다.
 * @returns 테스트가 소유하며 종료 시 삭제해야 하는 저장소 경로와 root 해시
 */
async function createRepository(): Promise<{ repoRoot: string; root: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "gsc-rebase-selection-"));
  await git(repoRoot, "init", "-q", "-b", "main");
  await git(repoRoot, "config", "user.name", "Rebase Selection Test");
  await git(repoRoot, "config", "user.email", "rebase-selection@example.com");
  await writeFile(join(repoRoot, "root.txt"), "root\n", "utf8");
  await git(repoRoot, "add", "root.txt");
  await git(repoRoot, "commit", "-q", "-m", "root");
  return { repoRoot, root: await git(repoRoot, "rev-parse", "HEAD") };
}

/**
 * 새 파일 하나를 추가해 부모와 내용 충돌이 없는 선형 커밋을 만든다.
 * @param repoRoot 커밋을 만들 테스트 저장소
 * @param name 파일명과 커밋 제목에 사용할 식별자
 * @returns 생성된 커밋의 전체 해시
 */
async function addCommit(repoRoot: string, name: string): Promise<string> {
  const path = `${name}.txt`;
  await writeFile(join(repoRoot, path), `${name}\n`, "utf8");
  await git(repoRoot, "add", path);
  await git(repoRoot, "commit", "-q", "-m", name);
  return git(repoRoot, "rev-parse", "HEAD");
}

test("선택한 현재 브랜치 row부터 HEAD까지만 interactive rebase 계획에 넣는다", async () => {
  const { repoRoot, root } = await createRepository();
  try {
    const selected = await addCommit(repoRoot, "selected");
    const head = await addCommit(repoRoot, "head");

    const plan = await new RebaseService(repoRoot).prepareCurrentBranchPlan(selected);

    assert.equal(plan.base, root);
    assert.equal(plan.root, false);
    assert.equal(plan.baseReason, "selected");
    assert.deepEqual(
      plan.commits.map((commit) => commit.hash),
      [selected, head]
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("다른 브랜치 row를 선택해 현재 브랜치 시작까지 범위가 확장되는 것을 거부한다", async () => {
  const { repoRoot, root } = await createRepository();
  try {
    await addCommit(repoRoot, "main-one");
    await addCommit(repoRoot, "main-head");
    await git(repoRoot, "switch", "-q", "-c", "side", root);
    const side = await addCommit(repoRoot, "side-selected");
    await git(repoRoot, "switch", "-q", "main");

    await assert.rejects(
      () => new RebaseService(repoRoot).prepareCurrentBranchPlan(side),
      /selected commit is not on the checked-out branch/
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("현재 브랜치의 실제 root row 선택은 명시적인 root rebase로 유지한다", async () => {
  const { repoRoot, root } = await createRepository();
  try {
    const head = await addCommit(repoRoot, "head");

    const plan = await new RebaseService(repoRoot).prepareCurrentBranchPlan(root);

    assert.equal(plan.base, "");
    assert.equal(plan.root, true);
    assert.deepEqual(
      plan.commits.map((commit) => commit.hash),
      [root, head]
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
