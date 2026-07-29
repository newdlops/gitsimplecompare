import assert from "node:assert/strict";
import test from "node:test";
import {
  localRefreshReasons,
  uriBelongsToRoot,
} from "../src/providers/localChangesWatcher";
import {
  FOCUSED_GIT_METADATA_GLOB,
  classifyHookPath,
  createGitMetadataRefreshHandler,
  internalGitHookRefreshRoots,
  isLinkedWorktreeAdminPath,
  routeRepositoryEvent,
  shouldQueueGraphRefresh,
  visibleRepositoryRoots,
} from "../src/providers/refreshWatcher";
import {
  classifyVscodeGitRepositoryTransition,
  vscodeGitWorkingStatusFingerprint,
} from "../src/providers/vscodeGitStatusProvider";
import {
  HiddenRepositoryRefreshFence,
  RepositoryRefreshSkipFence,
  RefreshDrain,
  addRefreshReasons,
  changesRefreshLanes,
  changesRefreshSections,
  directFileFallbackAction,
  repoRootFromGitPath,
  repositoryRefreshScope,
  shouldForceChangesGitStatus,
  shouldInvalidateChangesStatus,
  shouldLogIgnoredRefresh,
  shouldRefreshExplorerComparison,
  shouldRefreshPullRequestComments,
  shouldRefreshForGitPath,
  shouldSerializeAutomaticAuxiliary,
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
  assert.equal(shouldRefreshExplorerComparison("vscodeGit:identity"), false);
  assert.equal(shouldRefreshExplorerComparison("vscodeGit:head"), true);
  assert.equal(shouldRefreshExplorerComparison("windowFocusedReconcile"), true);
});

test("Git 메타데이터 경로에서 저장소 루트를 복원한다", () => {
  assert.equal(repoRootFromGitPath("/repo/.git/refs/heads/main"), "/repo");
  assert.equal(repoRootFromGitPath("C:\\repo\\.git\\HEAD"), "C:\\repo");
  assert.equal(
    repoRootFromGitPath("C:\\repo\\.git\\worktrees\\feature\\HEAD"),
    undefined
  );
  assert.equal(
    repoRootFromGitPath("/repo/.git/worktrees/feature/HEAD"),
    undefined
  );
  assert.equal(repoRootFromGitPath("/repo/src/file.ts"), undefined);
});

test("refresh 원인별로 정확성에 필요한 Changes 조회 영역을 선택한다", () => {
  assert.deepEqual(changesRefreshSections("viewReady"), [
    "repositories",
    "workingChanges",
    "fileHistory",
    "stashes",
    "comparison",
  ]);
  assert.deepEqual(changesRefreshSections("viewReadyDeferred"), [
    "fileHistory",
    "stashes",
    "comparison",
  ]);
  assert.deepEqual(changesRefreshSections("viewReady,viewReadyDeferred"), [
    "repositories",
    "workingChanges",
    "fileHistory",
    "stashes",
    "comparison",
  ]);
  assert.deepEqual(changesRefreshSections("vscodeGit:state"), [
    "workingChanges",
  ]);
  assert.deepEqual(changesRefreshSections("windowFocused"), [
    "workingChanges",
  ]);
  assert.deepEqual(changesRefreshSections("viewVisible"), [
    "workingChanges",
  ]);
  assert.deepEqual(changesRefreshSections("viewVisibleRepositories"), [
    "repositories",
    "workingChanges",
    "stashes",
  ]);
  assert.deepEqual(changesRefreshSections("vscodeGit:repositoryClosed"), [
    "repositories",
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
  ]);
  assert.deepEqual(changesRefreshSections("vscodeGit:head"), [
    "repositories",
    "workingChanges",
    "fileHistory",
    "comparison",
  ]);
  assert.deepEqual(changesRefreshSections("windowFocusedReconcile"), [
    "repositories",
    "workingChanges",
    "fileHistory",
    "stashes",
    "worktrees",
    "commitHooks",
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

test("로컬 상태와 보조 조회를 독립 실행 lane으로 분리한다", () => {
  assert.deepEqual(changesRefreshLanes("viewReady"), {
    local: ["repositories", "workingChanges"],
    auxiliary: ["fileHistory", "stashes", "comparison"],
  });
  assert.deepEqual(changesRefreshLanes("vscodeGit:state"), {
    local: ["workingChanges"],
    auxiliary: [],
  });
  assert.deepEqual(changesRefreshLanes("viewVisibleRepositories"), {
    local: ["repositories", "workingChanges"],
    auxiliary: ["stashes"],
  });
  assert.deepEqual(changesRefreshLanes("commitResult"), {
    local: ["workingChanges"],
    auxiliary: ["fileHistory", "comparison"],
  });
  assert.deepEqual(changesRefreshLanes("git:change:commit-hooks"), {
    local: [],
    auxiliary: ["commitHooks"],
  });
});

test("숨겨진 동안 놓친 저장소 변경만 재노출 탐색으로 승격한다", () => {
  const fence = new HiddenRepositoryRefreshFence();
  fence.mark("documentSaved", false);
  assert.equal(fence.consumeVisibilityReason("viewVisible"), "viewVisible");

  fence.mark("vscodeGit:repositoryClosed", false);
  assert.equal(
    fence.consumeVisibilityReason("viewVisible"),
    "viewVisibleRepositories"
  );
  assert.equal(fence.consumeVisibilityReason("viewVisible"), "viewVisible");

  fence.mark("workspaceFolders", true);
  assert.equal(fence.consumeVisibilityReason("viewVisible"), "viewVisible");
});

test("상태 mutation과 SoT 강제 조회 원인을 판정한다", () => {
  assert.equal(shouldInvalidateChangesStatus("commit"), true);
  assert.equal(shouldInvalidateChangesStatus("commitResult"), true);
  assert.equal(shouldInvalidateChangesStatus("checkoutBranch"), true);
  assert.equal(shouldInvalidateChangesStatus("branchOperationCompleted"), true);
  assert.equal(shouldInvalidateChangesStatus("vscodeGit:state"), false);
  assert.equal(shouldInvalidateChangesStatus("documentSaved"), true);
  assert.equal(shouldInvalidateChangesStatus("viewReadyDeferred"), false);
  assert.equal(shouldForceChangesGitStatus("commit"), true);
  assert.equal(shouldForceChangesGitStatus("commitResult"), true);
  assert.equal(shouldForceChangesGitStatus("windowFocused"), false);
  assert.equal(shouldForceChangesGitStatus("windowFocusedReconcile"), true);
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
  assert.equal(shouldForceChangesGitStatus("filesCreated"), false);
  assert.equal(shouldForceChangesGitStatus("vscodeGit:identity"), false);
  assert.equal(shouldForceChangesGitStatus("vscodeGit:head"), true);
  assert.equal(shouldRefreshPullRequestComments("vscodeGit:state"), false);
  assert.equal(shouldRefreshPullRequestComments("vscodeGit:identity"), false);
  assert.equal(shouldRefreshPullRequestComments("vscodeGit:head"), true);
  assert.equal(
    shouldRefreshPullRequestComments("git:change:stable-git-state"),
    true
  );
});

test("repository 이벤트를 실제 소비 root와 의미에 따라 최소 범위로 제한한다", () => {
  const relevantRoots = ["/active", "/comparison", "/conflicts"];
  for (const reason of ["vscodeGit:state", "vscodeGit:head"]) {
    assert.equal(
      repositoryRefreshScope({ reason, repoRoot: "/inactive", relevantRoots }),
      "skip"
    );
  }
  for (const repoRoot of relevantRoots) {
    assert.equal(
      repositoryRefreshScope({
        reason: "vscodeGit:head",
        repoRoot,
        relevantRoots,
      }),
      "active/full"
    );
  }
  assert.equal(
    repositoryRefreshScope({
      reason: "vscodeGit:identity",
      repoRoot: "/inactive",
      relevantRoots,
    }),
    "repository-list-only"
  );
  assert.equal(
    repositoryRefreshScope({
      reason: "vscodeGit:repositoryOpened",
      relevantRoots,
    }),
    "repository-list-only"
  );
  assert.equal(
    repositoryRefreshScope({ reason: "vscodeGit:state", relevantRoots }),
    "active/full"
  );
});

test("direct file fallback은 provider/authoritative 병합 원인이 있으면 취소한다", () => {
  const hook = "working-tree-file:change:workspace-hook,custom-hook:change:commit-hooks";
  for (const reason of [
    "documentSaved",
    "filesCreated,filesRenamed",
    "documentSaved,vscodeGit:identity",
    hook,
    `${hook},working-tree-file:create:workspace-hook`,
  ]) assert.equal(directFileFallbackAction(reason), "schedule");
  for (const reason of [
    "documentSaved,vscodeGit:state",
    "filesDeleted,commitResult",
    `${hook},vscodeGit:state`,
    `${hook},commitResult`,
    "command",
  ]) assert.equal(directFileFallbackAction(reason), "cancel");
});

test("Graph refresh는 같은 저장소의 HEAD·stable metadata·focus만 받는다", () => {
  assert.deepEqual(routeRepositoryEvent("vscodeGit:head", "/graph", [], "/graph"),
    { scope: "skip", graph: true });
  assert.deepEqual(routeRepositoryEvent(
    "git:change:stable-git-state", "/graph", [], "/graph"),
    { scope: "skip", graph: true });
  assert.deepEqual(routeRepositoryEvent("vscodeGit:state", "/graph", [], "/graph"),
    { scope: "skip", graph: false });
  assert.equal(shouldQueueGraphRefresh("vscodeGit:head", "/other", "/graph"), false);
  assert.equal(shouldQueueGraphRefresh(
    "windowFocusedReconcile", "/graph", "/graph"), true);
});

test("Graph queue에는 정규화 비교 뒤에도 panel의 정확한 root를 보존한다", () => {
  const queued: string[] = [];
  const reasons: string[] = [];
  const handler = createGitMetadataRefreshHandler({
    relevantRoots: () => [],
    graphRoot: () => "C:\\Graph\\Repo",
    skipLog: new RepositoryRefreshSkipFence(),
    invalidateStatus: () => undefined,
    queueRepository: () => undefined,
    queueGraph: (root) => queued.push(root),
    scheduleRefresh: (reason) => reasons.push(reason),
  });
  handler("change", fileUri("c:\\graph\\repo\\.git\\HEAD") as never);
  assert.deepEqual(queued, ["C:\\Graph\\Repo"]);
  assert.deepEqual(reasons, ["graph:git:change:stable-git-state"]);
});

test("linked worktree metadata는 보이는 저장소 root 집합으로 broadcast한다", () => {
  assert.equal(isLinkedWorktreeAdminPath(
    "/main/.git/worktrees/topic/HEAD"), true);
  assert.equal(isLinkedWorktreeAdminPath(
    "C:\\main\\.git\\worktrees\\topic\\HEAD"), true);
  assert.equal(isLinkedWorktreeAdminPath("/main/.git/HEAD"), false);
  assert.deepEqual(visibleRepositoryRoots([
    "/repo", undefined, "/repo/", "C:\\Work\\Repo", "c:/work/repo",
  ]), ["/repo", "C:\\Work\\Repo"]);
});

test("focus watcher 하나의 glob과 hook 경로 분류가 내부·workspace hook을 포함한다", () => {
  assert.match(FOCUSED_GIT_METADATA_GLOB, /\.git\/hooks/);
  assert.match(FOCUSED_GIT_METADATA_GLOB, /\.husky/);
  assert.match(FOCUSED_GIT_METADATA_GLOB, /\.githooks/);
  assert.deepEqual(classifyHookPath("/repo/.git/hooks/pre-commit", ["/repo"]),
    { kind: "git-hook", repoRoot: "/repo" });
  assert.deepEqual(classifyHookPath(
    "/repo/apps/web/.husky/pre-commit", ["/repo", "/repo/apps/web"]),
    { kind: "workspace-hook", repoRoot: "/repo/apps/web" });
  assert.deepEqual(classifyHookPath("/inactive/.githooks/pre-push", ["/repo"]),
    { kind: "workspace-hook", repoRoot: undefined });
});

test("linked worktree 공용 내부 hook은 visible roots에 hook-only로 broadcast한다", () => {
  let roots = ["/linked", "/linked/"];
  const reasons: string[] = [];
  const sideEffects: string[] = [];
  const handler = createGitMetadataRefreshHandler({
    relevantRoots: () => roots,
    graphRoot: () => undefined,
    skipLog: new RepositoryRefreshSkipFence(),
    invalidateStatus: () => sideEffects.push("status"),
    queueRepository: () => sideEffects.push("branch"),
    queueGraph: () => sideEffects.push("graph"),
    scheduleRefresh: (reason) => reasons.push(reason),
  });
  assert.deepEqual(internalGitHookRefreshRoots(undefined, roots), ["/linked"]);
  handler("change", fileUri("/main/.git/hooks/pre-commit") as never);
  assert.deepEqual(reasons, ["git:change:commit-hooks"]);
  assert.deepEqual(sideEffects, []);
  roots = [];
  handler("delete", fileUri("/main/.git/hooks/pre-commit") as never);
  assert.deepEqual(reasons, ["git:change:commit-hooks"]);
});

test("로컬 URI batch는 활성 root를 먼저 거르고 적용 사유의 합집합을 보존한다", () => {
  const ordinary = fileUri("/repo/src/index.ts");
  const workspaceHook = fileUri("/repo/.husky/pre-commit");
  const gitHook = fileUri("/repo/.git/hooks/pre-commit");
  const ignore = fileUri("/repo/.gitignore");
  const inactiveHook = fileUri("/other/.husky/pre-commit");

  assert.equal(
    localRefreshReasons("filesCreated", [ordinary, workspaceHook]),
    "filesCreated,working-tree-file:filesCreated:commit-hooks"
  );
  assert.equal(
    localRefreshReasons("filesCreated", [ignore, ordinary]),
    "working-tree-file:filesCreated:ignore-rules,filesCreated"
  );
  assert.equal(
    localRefreshReasons("filesCreated", [gitHook]),
    "working-tree-file:filesCreated:commit-hooks"
  );
  const active = [ordinary, inactiveHook].filter((uri) =>
    uriBelongsToRoot(uri, "/repo")
  );
  assert.deepEqual(active, [ordinary]);
  assert.equal(localRefreshReasons("filesCreated", active), "filesCreated");
  assert.equal(uriBelongsToRoot(fileUri("/repo-old/file.ts"), "/repo"), false);
  assert.equal(uriBelongsToRoot(fileUri("/repo/new.ts"), "/repo"), true);
});

test("VS Code Git status revision은 working fingerprint 변화에만 반응한다", () => {
  const unchanged = { branch: "main", head: "a", statusFingerprint: "same" };
  assert.deepEqual(
    classifyVscodeGitRepositoryTransition(unchanged, {
      ...unchanged,
      branch: "topic",
    }),
    { reasons: ["vscodeGit:identity"], statusChanged: false }
  );
  assert.deepEqual(
    classifyVscodeGitRepositoryTransition(unchanged, {
      branch: "topic",
      head: "a",
      statusFingerprint: "changed",
    }),
    {
      reasons: ["vscodeGit:identity", "vscodeGit:state"],
      statusChanged: true,
    }
  );
  assert.deepEqual(
    classifyVscodeGitRepositoryTransition(unchanged, {
      branch: "main",
      head: "b",
      statusFingerprint: "changed",
    }),
    { reasons: ["vscodeGit:head"], statusChanged: true }
  );
  assert.deepEqual(classifyVscodeGitRepositoryTransition(unchanged, unchanged),
    { reasons: ["vscodeGit:state"], statusChanged: false });
});

test("동일 M fingerprint의 provider 이벤트도 stats 보강용 state 의미를 유지한다", () => {
  const state = {
    indexChanges: [],
    workingTreeChanges: [gitChange("/repo/file.ts", 5)],
    untrackedChanges: [],
    mergeChanges: [],
  };
  const statusFingerprint = vscodeGitWorkingStatusFingerprint(state);
  const snapshot = { branch: "main", head: "a", statusFingerprint };
  assert.deepEqual(classifyVscodeGitRepositoryTransition(snapshot, snapshot),
    { reasons: ["vscodeGit:state"], statusChanged: false });
});

test("VS Code Git working fingerprint는 순서에는 안정적이고 rename 의미를 보존한다", () => {
  const first = vscodeGitWorkingStatusFingerprint({
    indexChanges: [gitChange("/repo/b.ts", 1), gitChange("/repo/a.ts", 0)],
    workingTreeChanges: [],
    untrackedChanges: [],
    mergeChanges: [],
  });
  const reordered = vscodeGitWorkingStatusFingerprint({
    indexChanges: [gitChange("/repo/a.ts", 0), gitChange("/repo/b.ts", 1)],
    workingTreeChanges: [],
    untrackedChanges: [],
    mergeChanges: [],
  });
  const renamed = vscodeGitWorkingStatusFingerprint({
    indexChanges: [gitChange("/repo/a.ts", 0, "/repo/old-a.ts")],
    workingTreeChanges: [gitChange("/repo/b.ts", 1)],
    untrackedChanges: [],
    mergeChanges: [],
  });
  assert.equal(first, reordered);
  assert.notEqual(first, renamed);
});

test("자동 auxiliary만 직렬화하고 skip 로그는 TTL 동안 집계한다", () => {
  assert.equal(shouldSerializeAutomaticAuxiliary("viewReady"), true);
  assert.equal(shouldSerializeAutomaticAuxiliary("commitResult"), true);
  assert.equal(shouldSerializeAutomaticAuxiliary("command"), false);

  const fence = new RepositoryRefreshSkipFence(100);
  assert.equal(fence.record("/repo\u0000state", 0), 1);
  assert.equal(fence.record("/repo\u0000state", 20), undefined);
  assert.equal(fence.record("/repo\u0000state", 120), 2);
});

test("수동 refresh만 표시하고 초기·자동 복구와 commit 보정은 조용히 실행한다", () => {
  assert.equal(shouldShowChangesRefreshProgress("command"), true);
  assert.equal(shouldShowChangesRefreshProgress("viewReady"), false);
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

test("느린 보조 drain이 실행 중이어도 로컬 drain은 독립적으로 완료된다", async () => {
  const auxiliaryGate = deferred<void>();
  const auxiliary = new RefreshDrain(async () => auxiliaryGate.promise);
  const localReasons: string[] = [];
  const local = new RefreshDrain(async (reason) => {
    localReasons.push(reason);
  });
  let auxiliaryDone = false;
  const auxiliaryRequest = auxiliary.request("viewReady").then(() => {
    auxiliaryDone = true;
  });
  await nextTurn();

  await local.request("vscodeGit:state");
  assert.deepEqual(localReasons, ["vscodeGit:state"]);
  assert.equal(auxiliaryDone, false);

  auxiliaryGate.resolve();
  await auxiliaryRequest;
  assert.equal(auxiliaryDone, true);
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

/** VS Code mock 없이 순수 URI 정책 함수에 넘길 최소 file URI를 만든다. */
function fileUri(fsPath: string): { scheme: string; fsPath: string } {
  return { scheme: "file", fsPath };
}

/** fingerprint 순수 함수에 넘길 최소 VS Code Git change 구조를 만든다. */
function gitChange(fsPath: string, status: number, renamePath?: string) {
  return {
    uri: { fsPath },
    renameUri: renamePath ? { fsPath: renamePath } : undefined,
    status,
  };
}
