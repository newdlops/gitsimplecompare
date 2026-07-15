import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type {
  CommitPlanContext,
  CommitPlanResult,
} from "../src/ai/commitPlanModel";
import { readAiCommitPlanContext } from "../src/git/aiCommitPlanContext";
import {
  AiCommitPlanError,
  AiCommitPlanService,
} from "../src/git/aiCommitPlanService";
import { AiCommitPlanPrivateRepo } from "../src/git/aiCommitPlanPrivateRepo";
import {
  runGit,
  runGitBuffer,
  withGitConfigOverrides,
} from "../src/git/gitExec";

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * 사용자 전역 Git 설정과 분리된 born local branch 임시 저장소를 만든다.
 * @returns 테스트 종료 시 삭제할 저장소 루트
 */
async function createRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-ai-all-scope-"));
  await runGit(["init", "--quiet"], root);
  await runGit(["config", "user.name", "AI All Scope Test"], root);
  await runGit(["config", "user.email", "ai-all-scope@example.com"], root);
  await runGit(["config", "commit.gpgSign", "false"], root);
  return root;
}

/**
 * 임시 저장소를 테스트 본문에 넘기고 성공·실패와 관계없이 전체 디렉터리를 정리한다.
 * @param run 생성된 저장소 루트를 받는 테스트 본문
 */
async function withRepo(
  run: (repoRoot: string) => Promise<void>
): Promise<void> {
  const root = await createRepo();
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * 저장소 상대 경로에 UTF-8 파일을 쓰고 상위 디렉터리가 없으면 함께 만든다.
 * @param repoRoot 저장소 루트
 * @param filePath 저장소 상대 파일 경로
 * @param content 파일 본문
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

/**
 * 현재 작업트리 전체를 stage하고 테스트 기준 commit을 만든다.
 * @param repoRoot 저장소 루트
 * @param message 선택 commit message
 */
async function commitAll(
  repoRoot: string,
  message = "base"
): Promise<void> {
  await runGit(["add", "-A"], repoRoot);
  await runGit(["commit", "-m", message], repoRoot);
}

/**
 * 현재 HEAD commit OID를 읽는다.
 * @param repoRoot 저장소 루트
 * @returns HEAD 전체 OID
 */
async function head(repoRoot: string): Promise<string> {
  return (await runGit(["rev-parse", "HEAD"], repoRoot)).trim();
}

/**
 * 한 그룹이 전달받은 모든 path를 소유하는 planner 호환 결과를 만든다.
 * @param message commit message
 * @param paths context allowlist의 exact current path
 * @returns 한 그룹 계획
 */
function oneGroupPlan(
  message: string,
  paths: string[]
): CommitPlanResult {
  return {
    groups: [{ message, paths: [...paths] }],
    warnings: [],
  };
}

/**
 * context file path를 정렬해 diff allowlist를 간단히 비교한다.
 * @param context all 범위 계획 context
 * @returns 정렬된 exact current path 목록
 */
function contextPaths(context: CommitPlanContext): string[] {
  return context.files.map((file) => file.path).sort();
}

/**
 * 실제 index의 stage entry 원문을 semantic 보존 비교용으로 읽는다.
 * @param repoRoot 저장소 루트
 * @returns mode/OID/stage/path NUL 원문
 */
async function stagedEntries(repoRoot: string): Promise<string> {
  return runGit(["ls-files", "--stage", "-z"], repoRoot);
}

test("all은 staged 뒤 WT 원복된 net-zero path도 최종 index에서 reconcile한다", async () => {
  await withRepo(async (root) => {
    await put(root, "a.txt", "base a\n");
    await put(root, "b.txt", "base b\n");
    await commitAll(root);

    await put(root, "a.txt", "staged a\n");
    await runGit(["add", "a.txt"], root);
    await put(root, "a.txt", "base a\n");
    await put(root, "b.txt", "planned b\n");

    const context = await readAiCommitPlanContext(root, "all");
    assert.deepEqual(contextPaths(context), ["b.txt"]);
    assert.equal(context.diff.includes("a.txt"), false);
    await new AiCommitPlanService(root).execute(
      context,
      oneGroupPlan("feat: update b only", ["b.txt"])
    );

    assert.equal(await runGit(["show", "HEAD:a.txt"], root), "base a\n");
    assert.equal(await runGit(["show", ":a.txt"], root), "base a\n");
    assert.equal(await runGit(["show", "HEAD:b.txt"], root), "planned b\n");
    assert.equal(await runGit(["status", "--porcelain"], root), "");
  });
});

test("all은 삭제된 intent-to-add entry를 frozen 전체 index publish로 제거한다", async () => {
  await withRepo(async (root) => {
    await put(root, "planned.txt", "base\n");
    await commitAll(root);
    await put(root, "ita.txt", "intent only\n");
    await runGit(["add", "-N", "ita.txt"], root);
    await rm(path.join(root, "ita.txt"));
    await put(root, "planned.txt", "planned\n");

    const context = await readAiCommitPlanContext(root, "all");
    assert.deepEqual(contextPaths(context), ["planned.txt"]);
    await new AiCommitPlanService(root).execute(
      context,
      oneGroupPlan("feat: update planned file", ["planned.txt"])
    );

    assert.equal(await runGit(["ls-files", "--stage", "ita.txt"], root), "");
    assert.equal(await runGit(["show", "HEAD:planned.txt"], root), "planned\n");
    assert.equal(await runGit(["status", "--porcelain"], root), "");
  });
});

test("all은 assume-unchanged와 skip-worktree의 숨은 WT 내용을 계획과 commit에서 제외한다", async () => {
  await withRepo(async (root) => {
    await put(root, "assumed.txt", "base assumed\n");
    await put(root, "skipped.txt", "base skipped\n");
    await put(root, "planned.txt", "base planned\n");
    await commitAll(root);
    await runGit(["update-index", "--assume-unchanged", "assumed.txt"], root);
    await runGit(["update-index", "--skip-worktree", "skipped.txt"], root);
    await put(root, "assumed.txt", "hidden assumed edit\n");
    await put(root, "skipped.txt", "hidden skipped edit\n");
    await put(root, "planned.txt", "visible planned edit\n");

    const context = await readAiCommitPlanContext(root, "all");
    assert.deepEqual(contextPaths(context), ["planned.txt"]);
    assert.equal(context.diff.includes("assumed.txt"), false);
    assert.equal(context.diff.includes("skipped.txt"), false);
    assert.equal(context.diff.includes("hidden assumed edit"), false);
    assert.equal(context.diff.includes("hidden skipped edit"), false);
    await new AiCommitPlanService(root).execute(
      context,
      oneGroupPlan("feat: keep hidden paths out", ["planned.txt"])
    );

    assert.equal(await runGit(["show", "HEAD:assumed.txt"], root), "base assumed\n");
    assert.equal(await runGit(["show", "HEAD:skipped.txt"], root), "base skipped\n");
    assert.equal(await readFile(path.join(root, "assumed.txt"), "utf8"), "hidden assumed edit\n");
    assert.equal(await readFile(path.join(root, "skipped.txt"), "utf8"), "hidden skipped edit\n");
    assert.match(await runGit(["ls-files", "-v", "assumed.txt"], root), /^h /);
    assert.match(await runGit(["ls-files", "-v", "skipped.txt"], root), /^S /);
    assert.equal(await runGit(["status", "--porcelain"], root), "");
  });
});

test("staged text patch의 잘못된 UTF-8 바이트를 변환 없이 그대로 commit한다", async () => {
  await withRepo(async (root) => {
    await put(root, "nonutf8.txt", "base bytes\n");
    await put(root, "other.txt", "base other\n");
    await commitAll(root);
    const expectedBytes = Buffer.from([0x66, 0x6f, 0x80, 0x0a]);
    await writeFile(path.join(root, "nonutf8.txt"), expectedBytes);
    await put(root, "other.txt", "planned other\n");
    await runGit(["add", "nonutf8.txt", "other.txt"], root);

    const context = await readAiCommitPlanContext(root, "staged");
    await new AiCommitPlanService(root).execute(context, {
      groups: [
        { message: "fix: preserve raw text bytes", paths: ["nonutf8.txt"] },
        { message: "test: update companion", paths: ["other.txt"] },
      ],
      warnings: [],
    });

    assert.deepEqual(
      await runGitBuffer(["show", "HEAD:nonutf8.txt"], root),
      expectedBytes
    );
    assert.deepEqual(
      await runGitBuffer(["show", ":nonutf8.txt"], root),
      expectedBytes
    );
    assert.equal(await runGit(["status", "--porcelain"], root), "");
  });
});

test("file에서 directory로 바뀌는 D/F effect를 같은 그룹에 두면 정상 commit한다", async () => {
  await withRepo(async (root) => {
    await put(root, "shape", "file shape\n");
    await commitAll(root);
    await rm(path.join(root, "shape"));
    await put(root, "shape/child.txt", "directory shape\n");

    const context = await readAiCommitPlanContext(root, "all");
    assert.deepEqual(contextPaths(context), ["shape", "shape/child.txt"]);
    await new AiCommitPlanService(root).execute(
      context,
      oneGroupPlan("refactor: turn shape into directory", contextPaths(context))
    );

    assert.equal(
      await runGit(["show", "HEAD:shape/child.txt"], root),
      "directory shape\n"
    );
    assert.equal(await runGit(["status", "--porcelain"], root), "");
  });
});

test("D/F effect를 다른 그룹에 두면 암묵 path 침범을 감지하고 실제 상태를 보존한다", async () => {
  await withRepo(async (root) => {
    await put(root, "shape", "file shape\n");
    await commitAll(root);
    const originalHead = await head(root);
    const originalIndex = await stagedEntries(root);
    await rm(path.join(root, "shape"));
    await put(root, "shape/child.txt", "directory shape\n");
    const context = await readAiCommitPlanContext(root, "all");

    await assert.rejects(
      new AiCommitPlanService(root).execute(context, {
        groups: [
          { message: "feat: add shape child", paths: ["shape/child.txt"] },
          { message: "refactor: remove shape file", paths: ["shape"] },
        ],
        warnings: [],
      }),
      (error: unknown) => error instanceof AiCommitPlanError &&
        error.code === "invalid-plan"
    );

    assert.equal(await head(root), originalHead);
    assert.equal(await stagedEntries(root), originalIndex);
    assert.equal(
      await readFile(path.join(root, "shape/child.txt"), "utf8"),
      "directory shape\n"
    );
    assert.match(await runGit(["status", "--porcelain"], root), /^ D shape$/m);
  });
});

test("rename oldPath가 final source에서 재생성되면 별도 그룹 entry를 제거하지 않는다", async () => {
  await withRepo(async (root) => {
    await put(root, "old.txt", "original old\n");
    await commitAll(root);
    await put(root, "old.txt", "recreated old\n");
    await put(root, "new.txt", "original old\n");
    const context = await readAiCommitPlanContext(root, "all");
    const renamed = context.files.find((file) => file.path === "new.txt");
    assert.ok(renamed);
    renamed.status = "R";
    renamed.oldPath = "old.txt";

    await new AiCommitPlanService(root).execute(context, {
      groups: [
        { message: "feat: recreate old path", paths: ["old.txt"] },
        { message: "refactor: add renamed path", paths: ["new.txt"] },
      ],
      warnings: [],
    });

    assert.equal(await runGit(["show", "HEAD:old.txt"], root), "recreated old\n");
    assert.equal(await runGit(["show", "HEAD:new.txt"], root), "original old\n");
    assert.equal(await runGit(["status", "--porcelain"], root), "");
  });
});

test("split-index 저장소에서도 sibling source snapshot을 publish하고 clean 상태가 된다", async () => {
  await withRepo(async (root) => {
    await put(root, "split.txt", "base split\n");
    await commitAll(root);
    await runGit(["update-index", "--split-index"], root);
    await put(root, "split.txt", "planned split\n");

    const context = await readAiCommitPlanContext(root, "all");
    await new AiCommitPlanService(root).execute(
      context,
      oneGroupPlan("feat: update split index", ["split.txt"])
    );

    assert.equal(await runGit(["show", "HEAD:split.txt"], root), "planned split\n");
    assert.equal(await runGit(["status", "--porcelain"], root), "");
    assert.notEqual(
      (await runGit(["rev-parse", "--shared-index-path"], root)).trim(),
      ""
    );
  });
});

test("private Git 환경은 저장소의 builtin fsmonitor 설정을 command scope에서 끈다", async () => {
  await withRepo(async (root) => {
    await put(root, "tracked.txt", "base\n");
    await commitAll(root);
    await runGit(["config", "core.fsmonitor", "true"], root);

    const privateRepo = await AiCommitPlanPrivateRepo.create(
      root,
      await head(root)
    );
    try {
      assert.equal(
        (
          await runGit(["config", "--bool", "core.fsmonitor"], root, {
            env: privateRepo.env,
          })
        ).trim(),
        "false"
      );
    } finally {
      await privateRepo.dispose();
    }
  });
});

test(
  "fsmonitor hook 저장소에서도 private 다중 commit과 hook 자식 Git이 교착 없이 끝난다",
  { skip: process.platform === "win32" },
  async () => {
    await withRepo(async (root) => {
      await put(root, "first.txt", "base first\n");
      await put(root, "second.txt", "base second\n");
      await commitAll(root);
      await put(root, "first.txt", "planned first\n");
      await put(root, "second.txt", "planned second\n");
      await runGit(["add", "first.txt", "second.txt"], root);
      const context = await readAiCommitPlanContext(root, "staged");

      const gitDir = path.join(root, ".git");
      const fsmonitorHook = path.join(gitDir, "fsmonitor-test.sh");
      const invokedMarker = path.join(root, "fsmonitor-invoked.marker");
      await writeFile(
        fsmonitorHook,
        [
          "#!/bin/sh",
          'if [ "$GIT_SIMPLE_COMPARE_AI_PLAN_PROVISIONAL" = "1" ]; then',
          '  touch "$GIT_WORK_TREE/fsmonitor-invoked.marker"',
          "fi",
          "exit 1",
          "",
        ].join("\n"),
        "utf8"
      );
      await chmod(fsmonitorHook, 0o755);
      const preCommitHook = path.join(gitDir, "hooks", "pre-commit");
      await writeFile(
        preCommitHook,
        '#!/bin/sh\ntest "$(git config --get core.fsmonitor)" = "false"\n',
        "utf8"
      );
      await chmod(preCommitHook, 0o755);
      await runGit(["config", "core.fsmonitor", fsmonitorHook], root);

      const result = await new AiCommitPlanService(root).execute(context, {
        groups: [
          { message: "feat: update first", paths: ["first.txt"] },
          { message: "feat: update second", paths: ["second.txt"] },
        ],
        warnings: [],
      });

      assert.equal(result.commits.length, 2);
      await assert.rejects(
        readFile(invokedMarker, "utf8"),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          (error as { code?: unknown }).code === "ENOENT"
      );
    });
  }
);

test("Git command-scope override는 기존 슬롯 뒤에 추가되어 마지막 값을 우선한다", () => {
  const env = withGitConfigOverrides(
    {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "true",
    },
    { "core.fsmonitor": "false" }
  );

  assert.equal(env.GIT_CONFIG_COUNT, "2");
  assert.equal(env.GIT_CONFIG_KEY_0, "core.fsmonitor");
  assert.equal(env.GIT_CONFIG_VALUE_0, "true");
  assert.equal(env.GIT_CONFIG_KEY_1, "core.fsmonitor");
  assert.equal(env.GIT_CONFIG_VALUE_1, "false");
});

test("linked worktree의 per-worktree index sibling에서 all 계획을 안전하게 publish한다", async () => {
  await withRepo(async (root) => {
    await put(root, "linked.txt", "base linked\n");
    await commitAll(root);
    const mainHead = await head(root);
    const linkedRoot = `${root}-linked`;
    try {
      await runGit(
        ["worktree", "add", "--quiet", "-b", "linked-plan", linkedRoot],
        root
      );
      await put(linkedRoot, "linked.txt", "planned linked\n");
      const context = await readAiCommitPlanContext(linkedRoot, "all");
      await new AiCommitPlanService(linkedRoot).execute(
        context,
        oneGroupPlan("feat: update linked worktree", ["linked.txt"])
      );

      assert.equal(
        await runGit(["show", "HEAD:linked.txt"], linkedRoot),
        "planned linked\n"
      );
      assert.equal(await runGit(["status", "--porcelain"], linkedRoot), "");
      assert.equal(await head(root), mainHead);
    } finally {
      await runGit(["worktree", "remove", "--force", linkedRoot], root)
        .catch(() => undefined);
      await rm(linkedRoot, { recursive: true, force: true });
    }
  });
});

test("마지막 그룹 완료 뒤 외부 staging은 최종 lock fence에서 publish를 거부한다", async () => {
  await withRepo(async (root) => {
    await put(root, "planned.txt", "base\n");
    await commitAll(root);
    const originalHead = await head(root);
    await put(root, "planned.txt", "planned\n");
    const context = await readAiCommitPlanContext(root, "all");
    let stagedAfterLastGroup = false;

    await assert.rejects(
      new AiCommitPlanService(root).execute(
        context,
        oneGroupPlan("feat: unpublished private commit", ["planned.txt"]),
        async (progress) => {
          if (
            progress.phase !== "commit" ||
            progress.step !== "completed" ||
            stagedAfterLastGroup
          ) {
            return;
          }
          stagedAfterLastGroup = true;
          await put(root, "external-final.txt", "external final index content\n");
          await runGit(["add", "external-final.txt"], root);
        }
      ),
      (error: unknown) =>
        error instanceof AiCommitPlanError && error.code === "concurrent-change"
    );

    assert.equal(stagedAfterLastGroup, true);
    assert.equal(await head(root), originalHead);
    assert.equal(await runGit(["log", "-1", "--format=%s"], root), "base\n");
    assert.equal(
      await runGit(["show", ":external-final.txt"], root),
      "external final index content\n"
    );
  });
});

test("active merge/rebase/cherry-pick/revert marker는 context와 execute 모두 거부한다", async () => {
  await withRepo(async (root) => {
    await put(root, "base.txt", "base\n");
    await commitAll(root);
    await put(root, "planned.txt", "planned\n");
    const context = await readAiCommitPlanContext(root, "all");
    const gitDirRaw = (await runGit(["rev-parse", "--git-dir"], root)).trim();
    const gitDir = path.resolve(root, gitDirRaw);
    const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"];

    for (const marker of markers) {
      const markerPath = path.join(gitDir, marker);
      await writeFile(markerPath, `${await head(root)}\n`, "utf8");
      await assert.rejects(
        readAiCommitPlanContext(root, "all"),
        (error: unknown) =>
          error instanceof AiCommitPlanError && error.code === "active-operation"
      );
      await rm(markerPath, { force: true });
    }
    const rebaseDir = path.join(gitDir, "rebase-merge");
    await mkdir(rebaseDir, { recursive: true });
    await assert.rejects(
      readAiCommitPlanContext(root, "all"),
      (error: unknown) =>
        error instanceof AiCommitPlanError && error.code === "active-operation"
    );
    await rm(rebaseDir, { recursive: true, force: true });

    await writeFile(path.join(gitDir, "MERGE_HEAD"), `${await head(root)}\n`, "utf8");
    await assert.rejects(
      new AiCommitPlanService(root).execute(
        context,
        oneGroupPlan("feat: planned", ["planned.txt"])
      ),
      (error: unknown) =>
        error instanceof AiCommitPlanError && error.code === "active-operation"
    );
  });
});
