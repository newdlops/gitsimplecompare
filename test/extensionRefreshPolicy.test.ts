import assert from "node:assert/strict";
import test from "node:test";
import {
  RefreshDrain,
  addRefreshReasons,
  changesRefreshSections,
  repoRootFromGitPath,
  shouldForceChangesGitStatus,
  shouldInvalidateChangesStatus,
  shouldLogIgnoredRefresh,
  shouldRefreshExplorerComparison,
  shouldRefreshPullRequestComments,
  shouldRefreshForGitPath,
  shouldShowChangesRefreshProgress,
} from "../src/utils/extensionRefreshPolicy";

test("stable Git 상태와 고빈도 임시 파일을 구분한다", () => {
  assert.deepEqual(shouldRefreshForGitPath("/repo/.git/HEAD"), {
    refresh: true,
    reason: "stable-git-state",
  });
  assert.equal(shouldRefreshForGitPath("/repo/.git/refs/heads/main").refresh, true);
  assert.equal(shouldRefreshForGitPath("/repo/.git/refs/heads/main.lock").refresh, false);
  assert.equal(shouldRefreshForGitPath("/repo/.git/worktrees/feature/HEAD").refresh, true);
  assert.equal(shouldRefreshForGitPath("/repo/.git/worktrees/feature/index").refresh, false);
  assert.equal(shouldRefreshForGitPath("/repo/.git/worktrees/feature/logs/HEAD").refresh, false);
});

test("hook과 ignore 규칙 변경은 전용 사유로 분류한다", () => {
  assert.deepEqual(shouldRefreshForGitPath("/repo/.git/hooks/pre-commit"), {
    refresh: true,
    reason: "commit-hooks",
  });
  assert.deepEqual(shouldRefreshForGitPath("/repo/.git/info/exclude"), {
    refresh: true,
    reason: "ignore-rules",
  });
  assert.equal(shouldLogIgnoredRefresh("volatile-git-state"), false);
});

test("refresh 원인을 중복 없이 합치고 비교 refresh 범위를 판정한다", () => {
  const reasons = new Set<string>();
  addRefreshReasons(reasons, "vscodeGit:state, stable-git-state");
  addRefreshReasons(reasons, "stable-git-state,windowFocused");
  assert.deepEqual([...reasons], [
    "vscodeGit:state",
    "stable-git-state",
    "windowFocused",
  ]);
  assert.equal(shouldRefreshExplorerComparison([...reasons].join(",")), true);
  assert.equal(shouldRefreshExplorerComparison("vscodeGit:state"), false);
});

test("Git 메타데이터 경로에서 저장소 루트를 복원한다", () => {
  assert.equal(repoRootFromGitPath("/repo/.git/refs/heads/main"), "/repo");
  assert.equal(
    repoRootFromGitPath("C:\\repo\\.git\\worktrees\\feature\\HEAD"),
    "C:\\repo"
  );
  assert.equal(repoRootFromGitPath("/repo/src/file.ts"), undefined);
});

test("refresh 원인별로 정확성에 필요한 Changes 조회 영역을 선택한다", () => {
  assert.deepEqual(changesRefreshSections("viewReady"), [
    "repositories",
    "workingChanges",
  ]);
  assert.deepEqual(changesRefreshSections("viewReadyDeferred"), [
    "fileHistory",
    "stashes",
    "worktrees",
    "commitHooks",
    "comparison",
  ]);
  assert.equal(
    changesRefreshSections("viewReady,viewReadyDeferred").length,
    7
  );
  assert.deepEqual(changesRefreshSections("vscodeGit:state"), [
    "workingChanges",
  ]);
  assert.deepEqual(changesRefreshSections("windowFocused"), [
    "workingChanges",
  ]);
  assert.deepEqual(changesRefreshSections("viewVisible"), [
    "repositories",
    "workingChanges",
    "fileHistory",
    "stashes",
    "worktrees",
    "commitHooks",
    "comparison",
  ]);
  assert.deepEqual(changesRefreshSections("git:change:commit-hooks"), [
    "commitHooks",
  ]);
  assert.deepEqual(changesRefreshSections("commitResult"), [
    "workingChanges",
    "fileHistory",
    "comparison",
  ]);
  assert.deepEqual(changesRefreshSections("commit"), [
    "workingChanges",
    "fileHistory",
    "comparison",
  ]);
  assert.deepEqual(changesRefreshSections("vscodeGit:identity"), [
    "repositories",
    "workingChanges",
    "fileHistory",
    "comparison",
  ]);
  assert.deepEqual(changesRefreshSections("checkoutBranch"), [
    "repositories",
    "workingChanges",
    "fileHistory",
    "comparison",
  ]);
  assert.deepEqual(changesRefreshSections("branchOperationCompleted"), [
    "repositories",
    "workingChanges",
    "fileHistory",
    "comparison",
  ]);
  assert.deepEqual(
    changesRefreshSections(
      "git:change:stable-git-state,git:change:commit-hooks"
    ),
    [
      "repositories",
      "workingChanges",
      "fileHistory",
      "commitHooks",
      "comparison",
    ]
  );
  assert.equal(changesRefreshSections("command").length, 7);
});

test("상태 mutation과 SoT 강제 조회 원인을 판정한다", () => {
  assert.equal(shouldInvalidateChangesStatus("commit"), true);
  assert.equal(shouldInvalidateChangesStatus("commitResult"), true);
  assert.equal(shouldInvalidateChangesStatus("checkoutBranch"), true);
  assert.equal(shouldInvalidateChangesStatus("branchOperationCompleted"), true);
  assert.equal(shouldInvalidateChangesStatus("vscodeGit:state"), false);
  assert.equal(shouldInvalidateChangesStatus("viewReadyDeferred"), false);
  assert.equal(shouldForceChangesGitStatus("commit"), true);
  assert.equal(shouldForceChangesGitStatus("commitResult"), true);
  assert.equal(shouldForceChangesGitStatus("windowFocused"), false);
  assert.equal(shouldForceChangesGitStatus("viewReady"), false);
  assert.equal(shouldForceChangesGitStatus("viewReadyDeferred"), false);
  assert.equal(shouldForceChangesGitStatus("viewVisible"), false);
  assert.equal(shouldForceChangesGitStatus("checkoutBranch"), true);
  assert.equal(shouldForceChangesGitStatus("branchOperationConflicts"), true);
  assert.equal(
    shouldForceChangesGitStatus("git:change:stable-git-state"),
    true
  );
  assert.equal(shouldForceChangesGitStatus("vscodeGit:state"), false);
  assert.equal(shouldForceChangesGitStatus("vscodeGit:identity"), true);
  assert.equal(shouldRefreshPullRequestComments("vscodeGit:state"), false);
  assert.equal(shouldRefreshPullRequestComments("vscodeGit:identity"), true);
  assert.equal(
    shouldRefreshPullRequestComments("git:change:stable-git-state"),
    true
  );
});

test("초기·수동 refresh만 표시하고 자동 전체 복구와 commit 보정은 조용히 실행한다", () => {
  assert.equal(shouldShowChangesRefreshProgress("command"), true);
  assert.equal(shouldShowChangesRefreshProgress("viewReady"), true);
  assert.equal(
    shouldShowChangesRefreshProgress("vscodeGit:state, command"),
    true
  );
  assert.equal(shouldShowChangesRefreshProgress("viewVisible"), false);
  assert.equal(shouldShowChangesRefreshProgress("viewReadyDeferred"), false);
  assert.equal(shouldShowChangesRefreshProgress("windowFocused"), false);
  assert.equal(shouldShowChangesRefreshProgress("commitResult"), false);
  assert.equal(shouldShowChangesRefreshProgress("documentSaved"), false);
});

test("실행 중 들어온 refresh는 queued 보정 pass까지 모두 끝날 때 완료된다", async () => {
  const gates = [deferred<void>(), deferred<void>()];
  const reasons: string[] = [];
  const drain = new RefreshDrain(async (reason) => {
    reasons.push(reason);
    await gates[reasons.length - 1].promise;
  });
  let firstDone = false;
  let secondDone = false;
  const first = drain.request("vscodeGit:state").then(() => {
    firstDone = true;
  });
  const second = drain.request("commit,commit").then(() => {
    secondDone = true;
  });

  await nextTurn();
  assert.deepEqual(reasons, ["vscodeGit:state"]);
  assert.equal(firstDone, false);
  assert.equal(secondDone, false);

  gates[0].resolve();
  await nextTurn();
  assert.deepEqual(reasons, ["vscodeGit:state", "commit"]);
  assert.equal(firstDone, false);
  assert.equal(secondDone, false);

  gates[1].resolve();
  await Promise.all([first, second]);
  assert.equal(firstDone, true);
  assert.equal(secondDone, true);
});

/** 테스트에서 비동기 실행을 원하는 시점까지 멈추기 위한 수동 Promise를 만든다. */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** queue의 Promise continuation이 실행될 수 있도록 이벤트 루프를 한 번 양보한다. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
