// 실제 branch/commit 컨트롤의 결과를 제품 서비스와 독립적인 Native Git 기준으로 확인한다.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export type CommitButtonOperation = "branch-squash-merge" | "branch-rebase-merge" | "cherry-pick";

/** 소유 fixture의 Native 결과만 읽는다. 실행 파일·환경은 양쪽 검증 경로에서 같은 PATH를 사용한다. */
async function native(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], {
    cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" }, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Native merge-tree로 대상과 현재 이력의 합성 결과를 미리 확정한다. 소유 fixture에만 객체를 만든다. */
export async function prepareCommitButtonExpectation(root: string, target: string) {
  const beforeHead = await native(root, "rev-parse", "HEAD"), base = await native(root, "merge-base", beforeHead, target);
  const tree = (await native(root, "merge-tree", "--write-tree", beforeHead, target)).split("\n")[0];
  assert.match(tree, /^[a-f0-9]{40,64}$/);
  const identity = "%an%x00%ae%x00%aI%x00%B";
  return { beforeHead, target, tree,
    sourceIdentity: await native(root, "show", "-s", `--format=${identity}`, target),
    rebasedIdentities: await native(root, "log", "--reverse", `--format=${identity}%x1e`, `${base}..${beforeHead}`) };
}

/** 실제 컨트롤 뒤 tree·부모·작성자/메시지·target ancestry를 별도 Native 조회로 검증한다. */
export async function verifyCommitButtonResult(root: string, operation: CommitButtonOperation,
  expected: Awaited<ReturnType<typeof prepareCommitButtonExpectation>>): Promise<void> {
  const head = await native(root, "rev-parse", "HEAD"); assert.notEqual(head, expected.beforeHead);
  assert.equal(await native(root, "rev-parse", "HEAD^{tree}"), expected.tree);
  if (operation === "branch-rebase-merge") {
    await native(root, "merge-base", "--is-ancestor", expected.target, head);
    assert.equal(await native(root, "log", "--reverse", "--format=%an%x00%ae%x00%aI%x00%B%x1e", `${expected.target}..HEAD`), expected.rebasedIdentities);
  } else {
    assert.equal(await native(root, "rev-list", "--parents", "-n1", "HEAD"), `${head} ${expected.beforeHead}`);
    if (operation === "cherry-pick") assert.equal(await native(root, "show", "-s", "--format=%an%x00%ae%x00%aI%x00%B", "HEAD"), expected.sourceIdentity);
  }
}
