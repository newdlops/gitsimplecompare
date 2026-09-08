import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PullRequestStackMetadataService } from "../src/git/pullRequestStackMetadata";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 Git config를 사용해 키 부재와 lock/구문 오류를 분리한다. */
test("missing Stack keys are harmless but config lock failures remain failures", async t => {
  const { root, head } = await safetyFixture(t, "stack-config-lock");
  const service = new PullRequestStackMetadataService(root);
  await service.clearParent("absent");
  await git(root, "branch", "child");
  await service.setParent("child", "main", head);
  const before = await readFile(join(root, ".git/config"));
  await writeFile(join(root, ".git/config.lock"), "external owner");
  await assert.rejects(service.clearParent("child"), /lock/i);
  assert.deepEqual(await readFile(join(root, ".git/config")), before);
  assert.equal(await readFile(join(root, ".git/config.lock"), "utf8"), "external owner");
});

/** 파싱할 수 없는 config를 빈 Stack으로 표시하거나 삭제 성공으로 오인하지 않는다. */
test("malformed config is reported by both Stack reads and deletes", async t => {
  const { root } = await safetyFixture(t, "stack-config-invalid");
  await appendFile(join(root, ".git/config"), "\n[broken\n");
  const service = new PullRequestStackMetadataService(root);
  await assert.rejects(service.listBranches(), /config/i);
  await assert.rejects(service.clearParent("child"), /config/i);
});

/** 두 번째 키에만 실패를 주입해 현재 layer와 앞서 지운 layer의 실제 설정 복원을 검사한다. */
test("partial Stack deletion restores the failed layer and earlier layers", async t => {
  const { root, head } = await safetyFixture(t, "stack-config-rollback");
  const service = new PullRequestStackMetadataService(root);
  for (const branch of ["a", "b"]) await git(root, "branch", branch);
  await service.setParent("a", "main", head);
  await service.setParent("b", "a", head);
  const internal = service as any, write = internal.writeConfig.bind(service);
  let failed = false;
  t.mock.method(internal, "writeConfig", async (branch: string, key: string, value?: string) => {
    if (!failed && branch === "b" && key === "gscStackParentHead" && value === undefined) {
      failed = true; throw new Error("injected config write failure");
    }
    await write(branch, key, value);
  });
  await assert.rejects(service.deleteComponent("a"), /injected/);
  const branches = new Map((await service.listBranches()).map(branch => [branch.name, branch]));
  assert.equal(branches.get("a")?.parentBranch, "main");
  assert.equal(branches.get("b")?.parentBranch, "a");
  assert.equal(branches.get("a")?.parentHead, head);
  assert.equal(branches.get("b")?.parentHead, head);
});

/** 원래 쓰기 실패와 복원 실패를 함께 보존해 불완전 복원이 성공으로 표시되지 않게 한다. */
test("rollback failure includes the original error and keeps restoration attempts observable", async t => {
  const { root, head } = await safetyFixture(t, "stack-config-recovery-error");
  const service = new PullRequestStackMetadataService(root);
  await git(root, "branch", "child"); await service.setParent("child", "main", head);
  const internal = service as any, write = internal.writeConfig.bind(service);
  t.mock.method(internal, "writeConfig", async (branch: string, key: string, value?: string) => {
    if (key === "gscStackParentHead") throw new Error("delete failed");
    if (value !== undefined) throw new Error("restore failed");
    await write(branch, key, value);
  });
  await assert.rejects(service.clearParent("child"), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(item => item.message), ["delete failed", "restore failed"]);
    return true;
  });
});
