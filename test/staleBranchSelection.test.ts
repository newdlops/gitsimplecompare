// 로컬 현황의 표시 범위를 넓혀도 원격 존재·사용 중인 브랜치가 삭제 후보로 넘어가지 않게 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import type { InspectedLocalBranch, StaleBranchInspection } from "../src/git/staleBranchService";
import { selectedStaleBranches } from "../src/webview/staleBranchPanel";

/** 실제 UI가 표시하는 로컬/원격 대응·worktree 보호 상태를 가진 고정 스냅샷을 만든다. */
function inspection(): StaleBranchInspection {
  const base = { hash: "a".repeat(40), subject: "fixture", merged: true, inUse: false, current: false, matchingRemotes: [], worktreePaths: [] };
  const localBranches: InspectedLocalBranch[] = [
    { ...base, name: "removable", remoteState: "absent" },
    { ...base, name: "on-remote", remoteState: "present", matchingRemotes: ["origin"] },
    { ...base, name: "in-use", remoteState: "absent", inUse: true, worktreePaths: ["/worktree"] },
    { ...base, name: "unverified", remoteState: "unconfigured" },
  ];
  return { repoRoot: "/fixture", remotes: ["origin"], remoteConfigHash: "snapshot", localBranches,
    branches: localBranches.filter(branch => branch.remoteState === "absent") };
}

test("host accepts only the exact removable local snapshot and retains the reviewed tip", () => {
  const snapshot = inspection();
  const selected = selectedStaleBranches(snapshot, ["removable", "removable"]);
  assert.deepEqual(selected, [snapshot.branches[0]]);
  assert.equal(selected?.[0], snapshot.branches[0]);
});

test("remote, protected, unknown, unverified or mixed forged selections cannot start deletion review", () => {
  const snapshot = inspection();
  for (const value of [undefined, {}, [], [42], ["on-remote"], ["in-use"], ["unverified"], ["missing"],
    ["removable", "on-remote"], ["removable", "in-use"], Array(100).fill("removable")]) {
    assert.equal(selectedStaleBranches(snapshot, value), undefined);
  }
});
