// stale 정리 테스트가 사용자 저장소·네트워크를 건드리지 않도록 로컬 bare 원격을 만든다.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { runGit } from "../../src/git/gitExec";
import { StaleBranchService } from "../../src/git/staleBranchService";

/** 테스트마다 독립적인 실제 Git 저장소와 파일 기반 원격을 만든다. */
export async function staleBranchFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "gsc-stale-branches-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "work");
  const remote = join(directory, "remote.git");
  await mkdir(root);
  await runGit(["init", "--bare", remote], directory);
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.name", "Stale Branch Test"], root);
  await runGit(["config", "user.email", "stale@example.test"], root);
  await runGit(["config", "commit.gpgsign", "false"], root);
  await runGit(["config", "core.hooksPath", "/dev/null"], root);
  await writeFile(join(root, "file.txt"), "keep this file\n");
  await runGit(["add", "file.txt"], root);
  await runGit(["commit", "-m", "initial"], root);
  await runGit(["remote", "add", "origin", remote], root);
  await runGit(["push", "-u", "origin", "main"], root);
  const hash = (await runGit(["rev-parse", "HEAD"], root)).trim();
  return { directory, root, remote, hash, service: new StaleBranchService(root) };
}

/** HEAD를 움직이거나 작업 파일을 바꾸지 않고 병합되지 않은 tip을 만든다. */
export async function unmergedBranch(root: string, name: string): Promise<string> {
  const tree = (await runGit(["rev-parse", "HEAD^{tree}"], root)).trim();
  const hash = (await runGit(["commit-tree", tree, "-p", "HEAD", "-m", `local ${name}`], root)).trim();
  await runGit(["branch", name, hash], root);
  return hash;
}

/** 삭제 검증 시 현재 남아 있는 로컬 브랜치 이름을 Git에서 읽는다. */
export async function localBranches(root: string): Promise<string[]> {
  return (await runGit(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], root)).trim().split("\n").filter(Boolean);
}
