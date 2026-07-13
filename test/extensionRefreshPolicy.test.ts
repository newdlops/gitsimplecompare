import assert from "node:assert/strict";
import test from "node:test";
import {
  addRefreshReasons,
  repoRootFromGitPath,
  shouldLogIgnoredRefresh,
  shouldRefreshExplorerComparison,
  shouldRefreshForGitPath,
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
