import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { runGit } from "../src/git/gitExec";
import {
  applyStagedPullRequestPreviewOverlay,
  buildIndexedPullRequestPreviewFiles,
  buildLocalPullRequestPreview,
  buildStagedPullRequestPreviewOverlay,
} from "../src/git/pullRequestPreviewCommits";
import type { PullRequestPreviewCommit } from "../src/git/pullRequestPreviewCommits";
import type { PullRequestPreviewFile } from "../src/git/pullRequestPreviewFiles";
import {
  PullRequestQuickEditError,
  PullRequestQuickEditService,
} from "../src/git/pullRequestQuickEditService";
import { PullRequestPreviewPanel } from "../src/webview/pullRequestPreviewPanel";

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * Quick Edit의 file 단위 staging을 실제 index로 검증할 격리 저장소를 만든다.
 * @returns 테스트 종료 시 삭제할 임시 저장소 루트
 */
async function createRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-pr-quick-edit-"));
  await runGit(["init", "--quiet", "-b", "main"], root);
  await runGit(["config", "user.name", "Quick Edit Test"], root);
  await runGit(["config", "user.email", "quick-edit@example.com"], root);
  await runGit(["config", "commit.gpgSign", "false"], root);
  await writeFile(
    path.join(root, "review.txt"),
    "line 1\nbase line\nline 3\n",
    "utf8"
  );
  await writeFile(path.join(root, "other.txt"), "other\n", "utf8");
  await runGit(["add", "--", "review.txt", "other.txt"], root);
  await runGit(["commit", "-m", "base"], root);
  await runGit(["switch", "-c", "feature"], root);
  await writeFile(
    path.join(root, "review.txt"),
    "line 1\nremote change\nline 3\n",
    "utf8"
  );
  await runGit(["add", "--", "review.txt"], root);
  await runGit(["commit", "-m", "feature change"], root);
  return root;
}

test("Quick Edit composes a middle-line edit at its original PR line instead of appending patches", async () => {
  const root = await createRepo();
  try {
    const service = new PullRequestQuickEditService(root);
    const session = await service.prepare("review.txt", "feature");
    const beforeQuickEdit = await buildLocalPullRequestPreview(
      root,
      "main",
      "feature",
      []
    );
    assert.match(beforeQuickEdit.files[0]?.patch || "", /\+remote change/);
    await writeFile(
      path.join(root, "review.txt"),
      "line 1\nquick edited\nline 3\n",
      "utf8"
    );
    await writeFile(path.join(root, "other.txt"), "other\nkeep unstaged\n", "utf8");

    const refreshReasons: string[] = [];
    const panel = Object.create(PullRequestPreviewPanel.prototype) as any;
    panel.service = { repoRoot: root };
    panel.quickEditService = service;
    panel.activeQuickEditSession = session;
    panel.quickEditSaveQueue = Promise.resolve();
    panel.schedulePreviewRefresh = (reason: string) => refreshReasons.push(reason);
    panel.handleSavedDocument({
      uri: {
        scheme: "file",
        fsPath: path.join(root, "review.txt"),
      },
    });
    await panel.quickEditSaveQueue;

    assert.equal(
      await runGit(["diff", "--cached", "--name-only"], root),
      "review.txt\n"
    );
    assert.equal(
      await runGit(["diff", "--name-only"], root),
      "other.txt\n"
    );
    assert.deepEqual(refreshReasons, ["quickEditSave"]);

    const stagedFiles = [{
      status: "M",
      path: "review.txt",
      additions: 1,
      deletions: 1,
    }] as const;
    const overlay = await buildStagedPullRequestPreviewOverlay(
      root,
      [...stagedFiles]
    );
    assert.match(overlay.files[0]?.patch || "", /-remote change/);
    assert.match(overlay.files[0]?.patch || "", /\+quick edited/);
    assert.equal(overlay.commit?.synthetic, true);

    const indexedFiles = await buildIndexedPullRequestPreviewFiles(
      root,
      "main",
      "feature"
    );
    assert.ok(indexedFiles);
    const indexedPatch = indexedFiles[0]?.patch || "";
    assert.match(indexedPatch, /@@ -1,3 \+1,3 @@/);
    assert.match(indexedPatch, /-base line/);
    assert.match(indexedPatch, /\+quick edited/);
    assert.doesNotMatch(indexedPatch, /remote change/);
    assert.equal((indexedPatch.match(/^diff --git /gm) || []).length, 1);
    const localPreview = await buildLocalPullRequestPreview(
      root,
      "main",
      "feature",
      [...stagedFiles]
    );
    assert.equal(localPreview.files[0]?.patch, indexedPatch);

    const serverFile: PullRequestPreviewFile = {
      status: "M",
      path: "review.txt",
      additions: 1,
      deletions: 1,
      patch: [
        "diff --git a/review.txt b/review.txt",
        "@@ -1,3 +1,3 @@",
        " line 1",
        "-base line",
        "+remote change",
        " line 3",
      ].join("\n"),
      comments: [{
        id: 7,
        author: "reviewer",
        body: "keep this comment",
        diffHunk: "@@ -1 +1,2 @@",
        line: 2,
      }],
    };
    const serverCommit: PullRequestPreviewCommit = {
      hash: "1234567890",
      shortHash: "1234567",
      title: "feature change",
      files: [serverFile],
    };
    const refreshed = applyStagedPullRequestPreviewOverlay(
      [serverFile],
      [serverCommit],
      overlay,
      indexedFiles
    );
    assert.equal(refreshed.files[0]?.patch, indexedPatch);
    assert.equal(refreshed.files[0]?.additions, 1);
    assert.equal(refreshed.files[0]?.deletions, 1);
    assert.doesNotMatch(refreshed.files[0]?.patch || "", /remote change/);
    assert.equal(refreshed.files[0]?.comments[0]?.id, 7);
    assert.equal(refreshed.commits.at(-1)?.synthetic, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Quick Edit refuses pre-existing unstaged content and a stale source branch", async () => {
  const root = await createRepo();
  try {
    const service = new PullRequestQuickEditService(root);
    await writeFile(path.join(root, "review.txt"), "base\npre-existing\n", "utf8");
    await assert.rejects(
      service.prepare("review.txt", "feature"),
      (error: unknown) =>
        error instanceof PullRequestQuickEditError
        && error.code === "existingUnstagedChanges"
    );
    await assert.rejects(
      service.prepare("other.txt", "main"),
      (error: unknown) =>
        error instanceof PullRequestQuickEditError
        && error.code === "sourceBranchChanged"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manual preview refresh waits until the Quick Edit staging queue is complete", async () => {
  const events: string[] = [];
  let release!: () => void;
  const panel = Object.create(PullRequestPreviewPanel.prototype) as any;
  panel.quickEditSaveQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  panel.cancelScheduledPreviewRefresh = () => events.push("cancelTimer");
  panel.sendPreview = async () => {
    events.push("sendPreview");
  };

  const refresh = panel.handleMessage({ type: "refresh" });
  await Promise.resolve();
  assert.deepEqual(events, []);
  release();
  await refresh;
  assert.deepEqual(events, ["cancelTimer", "sendPreview"]);
});
