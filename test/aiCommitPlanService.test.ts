import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { CommitPlanResult } from "../src/ai/commitPlanModel";
import {
  readAiCommitPlanContext,
} from "../src/git/aiCommitPlanContext";
import {
  AiCommitPlanError,
  AiCommitPlanService,
  type CommitPlanProgress,
} from "../src/git/aiCommitPlanService";
import { runGit } from "../src/git/gitExec";

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * 사용자 전역 Git 설정과 분리된 실제 임시 저장소를 만든다.
 * @returns 테스트가 종료 시 삭제해야 하는 저장소 루트
 */
async function createRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-ai-plan-"));
  await runGit(["init", "--quiet"], root);
  await runGit(["config", "user.name", "AI Plan Test"], root);
  await runGit(["config", "user.email", "ai-plan@example.com"], root);
  await runGit(["config", "commit.gpgSign", "false"], root);
  return root;
}

/**
 * 임시 저장소를 생성해 테스트 본문에 넘기고 성공/실패와 관계없이 디렉터리를 정리한다.
 * @param run 생성된 저장소 루트를 받는 테스트 본문
 */
async function withRepo(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const root = await createRepo();
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * 저장소 상대 경로에 UTF-8 파일을 쓰고 필요한 상위 디렉터리를 만든다.
 * @param repoRoot Git 저장소 루트
 * @param filePath 저장소 상대 파일 경로
 * @param content 저장할 파일 본문
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
 * 현재 파일들을 stage하고 테스트 기준점 커밋을 만든다.
 * @param repoRoot Git 저장소 루트
 * @param message 기준점 커밋 메시지
 */
async function commitAll(
  repoRoot: string,
  message = "base"
): Promise<void> {
  await runGit(["add", "-A"], repoRoot);
  await runGit(["commit", "-m", message], repoRoot);
}

/**
 * 현재 HEAD 전체 해시를 읽는다.
 * @param repoRoot Git 저장소 루트
 * @returns HEAD 전체 해시
 */
async function head(repoRoot: string): Promise<string> {
  return (await runGit(["rev-parse", "HEAD"], repoRoot)).trim();
}

/**
 * 컨텍스트 파일 순서와 무관하게 두 path를 각각 한 커밋으로 만드는 계획을 생성한다.
 * @param first 첫 번째 커밋 메시지와 path
 * @param second 두 번째 커밋 메시지와 path
 * @returns 실행 서비스가 받을 planner 호환 결과
 */
function twoGroupPlan(
  first: [message: string, filePath: string],
  second: [message: string, filePath: string]
): CommitPlanResult {
  return {
    groups: [
      { message: first[0], paths: [first[1]] },
      { message: second[0], paths: [second[1]] },
    ],
    warnings: [],
  };
}

test("staged 부분 변경을 보존하며 계획 순서대로 여러 일반 커밋을 만든다", async () => {
  await withRepo(async (root) => {
    await put(root, "partial.txt", "base\n");
    await commitAll(root);

    // partial.txt의 첫 변경만 stage한 뒤 두 번째 변경은 working tree에 남긴다.
    await put(root, "partial.txt", "base\nstaged\n");
    await runGit(["add", "partial.txt"], root);
    await put(root, "partial.txt", "base\nstaged\nunstaged\n");
    await put(root, "second.txt", "second\n");
    await runGit(["add", "second.txt"], root);

    const context = await readAiCommitPlanContext(root, "commit");
    assert.equal(context.scope, "staged");
    assert.equal(
      context.files.find((file) => file.path === "partial.txt")?.unstaged,
      true
    );
    const progress: CommitPlanProgress[] = [];
    const result = await new AiCommitPlanService(root).execute(
      context,
      twoGroupPlan(
        ["feat: commit staged portion", "partial.txt"],
        ["feat: add second file", "second.txt"]
      ),
      (item) => progress.push(item)
    );

    assert.equal(result.commits.length, 2);
    assert.equal(result.head, await head(root));
    assert.deepEqual(
      (await runGit(["log", "-2", "--format=%s"], root)).trim().split("\n"),
      ["feat: add second file", "feat: commit staged portion"]
    );
    assert.equal(
      await runGit(["show", "HEAD~1:partial.txt"], root),
      "base\nstaged\n"
    );
    assert.equal(
      await readFile(path.join(root, "partial.txt"), "utf8"),
      "base\nstaged\nunstaged\n"
    );
    assert.equal(await runGit(["diff", "--cached"], root), "");
    assert.match(await runGit(["status", "--porcelain"], root), /^ M partial\.txt/m);
    assert.deepEqual(progress.map(({ phase, current, step }) => `${phase}:${current}:${step ?? ""}`),
      ["validate:0:", "commit:0:started", "commit:1:completed", "commit:1:started", "commit:2:completed", "complete:2:"]);
  });
});

test("플랜의 여러 줄 커밋 메시지를 subject와 body까지 그대로 기록한다", async () => {
  await withRepo(async (root) => {
    await put(root, "message.txt", "before\n");
    await commitAll(root);
    await put(root, "message.txt", "after\n");
    await runGit(["add", "message.txt"], root);
    const context = await readAiCommitPlanContext(root, "commit");
    const message = [
      "feat: improve planned messages",
      "",
      "Explain the non-obvious behavior in a concise body.",
    ].join("\n");

    await new AiCommitPlanService(root).execute(context, {
      groups: [{ message, paths: ["message.txt"] }],
      warnings: [],
    });

    assert.equal(
      (await runGit(["log", "-1", "--format=%B"], root)).trimEnd(),
      message
    );
  });
});

test("all 범위는 미추적 파일 내용을 snapshot과 실제 다중 커밋에 포함한다", async () => {
  await withRepo(async (root) => {
    await put(root, "tracked.txt", "before\n");
    await put(root, "flagged.txt", "preserve flags\n");
    await commitAll(root);
    await runGit(["update-index", "--assume-unchanged", "flagged.txt"], root);
    await put(root, "tracked.txt", "after\n");
    await put(root, "new.txt", "untracked\n");

    const context = await readAiCommitPlanContext(root, "all");
    assert.equal(context.scope, "all");
    assert.deepEqual(
      context.files.map((file) => file.path).sort(),
      ["new.txt", "tracked.txt"]
    );
    const result = await new AiCommitPlanService(root).execute(
      context,
      twoGroupPlan(
        ["feat: update tracked file", "tracked.txt"],
        ["feat: add untracked file", "new.txt"]
      )
    );

    assert.equal(result.commits.length, 2);
    assert.equal(await runGit(["status", "--porcelain"], root), "");
    assert.equal(await runGit(["show", "HEAD:new.txt"], root), "untracked\n");
    assert.match(await runGit(["ls-files", "-v", "flagged.txt"], root), /^h /);
  });
});

test("계획 생성 뒤 all 범위 파일이 바뀌면 stale snapshot으로 실행을 거부한다", async () => {
  await withRepo(async (root) => {
    await put(root, "base.txt", "base\n");
    await commitAll(root);
    const originalHead = await head(root);
    await put(root, "new.txt", "first\n");
    const context = await readAiCommitPlanContext(root, "commit");
    await put(root, "new.txt", "changed after plan\n");

    await assert.rejects(
      new AiCommitPlanService(root).execute(context, {
        groups: [{ message: "feat: add new file", paths: ["new.txt"] }],
        warnings: [],
      }),
      (error: unknown) =>
        error instanceof AiCommitPlanError && error.code === "stale-snapshot"
    );
    assert.equal(await head(root), originalHead);
    assert.equal(
      await readFile(path.join(root, "new.txt"), "utf8"),
      "changed after plan\n"
    );
  });
});

test("중간 hook 실패 시 HEAD를 원복하고 실제 index의 기존 staged 상태를 보존한다", async (context) => {
  if (process.platform === "win32") {
    context.skip("executable shell hook rollback test is Unix-specific");
    return;
  }
  await withRepo(async (root) => {
    await put(root, "first.txt", "before first\n");
    await put(root, "second.txt", "before second\n");
    await commitAll(root);
    const originalHead = await head(root);

    await put(root, "first.txt", "after first\n");
    await runGit(["add", "first.txt"], root);
    await put(root, "second.txt", "after second\n");
    const cachedBefore = await runGit(["diff", "--cached", "--binary"], root);
    const contextBefore = await readAiCommitPlanContext(root, "all");

    const gitDir = (await runGit(["rev-parse", "--git-dir"], root)).trim();
    const hookPath = path.resolve(root, gitDir, "hooks", "pre-commit");
    await put(
      root,
      path.relative(root, hookPath),
      [
        "#!/bin/sh",
        "if test \"$(git log -1 --pretty=%s)\" = \"feat: first group\"; then",
        "  echo \"intentional second-group failure\" >&2",
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n")
    );
    await chmod(hookPath, 0o755);

    await assert.rejects(
      new AiCommitPlanService(root).execute(
        contextBefore,
        twoGroupPlan(
          ["feat: first group", "first.txt"],
          ["feat: second group", "second.txt"]
        )
      ),
      /intentional second-group failure|pre-commit/i
    );

    assert.equal(await head(root), originalHead);
    assert.equal(await runGit(["log", "-1", "--format=%s"], root), "base\n");
    assert.equal(await runGit(["diff", "--cached", "--binary"], root), cachedBefore);
    assert.equal(
      await readFile(path.join(root, "first.txt"), "utf8"),
      "after first\n"
    );
    assert.equal(
      await readFile(path.join(root, "second.txt"), "utf8"),
      "after second\n"
    );
  });
});

test("누락 또는 중복 path 계획은 Git 변경 전에 정확성 검증에서 거부한다", async () => {
  await withRepo(async (root) => {
    await put(root, "base.txt", "base\n");
    await commitAll(root);
    const originalHead = await head(root);
    await put(root, "one.txt", "one\n");
    await put(root, "two.txt", "two\n");
    const context = await readAiCommitPlanContext(root, "all");

    await assert.rejects(
      new AiCommitPlanService(root).execute(context, [
        { message: "first", paths: ["one.txt"] },
        { message: "duplicate", paths: ["one.txt"] },
      ]),
      (error: unknown) =>
        error instanceof AiCommitPlanError && error.code === "invalid-plan"
    );
    assert.equal(await head(root), originalHead);
    assert.equal(
      (await runGit(["status", "--porcelain"], root)).includes("two.txt"),
      true
    );
  });
});

test("해결되지 않은 merge 충돌이 있으면 계획 컨텍스트 생성을 거부한다", async () => {
  await withRepo(async (root) => {
    await put(root, "conflict.txt", "base\n");
    await commitAll(root);
    const mainBranch = (await runGit(["branch", "--show-current"], root)).trim();
    await runGit(["checkout", "-b", "conflicting-side"], root);
    await put(root, "conflict.txt", "side\n");
    await commitAll(root, "side change");
    await runGit(["checkout", mainBranch], root);
    await put(root, "conflict.txt", "main\n");
    await commitAll(root, "main change");

    await assert.rejects(
      runGit(["merge", "conflicting-side"], root),
      /conflict|automatic merge failed/i
    );
    await assert.rejects(
      readAiCommitPlanContext(root, "all"),
      /active merge|resolve merge conflicts/i
    );
    assert.match(await runGit(["status", "--porcelain"], root), /^UU conflict\.txt/m);
  });
});

test("큰 AI용 diff는 파일별 예산을 나눠 뒤쪽 파일도 포함한 채 deterministic하게 자른다", async () => {
  await withRepo(async (root) => {
    await put(root, "base.txt", "base\n");
    await commitAll(root);
    const paths: string[] = [];
    for (let index = 0; index < 12; index++) {
      const filePath = `large/file-${String(index).padStart(2, "0")}.txt`;
      paths.push(filePath);
      await put(root, filePath, `${String(index).repeat(12000)}\n`);
    }

    const first = await readAiCommitPlanContext(root, "all");
    const second = await readAiCommitPlanContext(root, "all");
    assert.equal(first.diff, second.diff);
    assert.equal(first.snapshot, second.snapshot);
    assert.ok(first.diff.length < 32100);
    assert.match(first.diff, /diff truncated/);
    for (const filePath of paths) {
      assert.equal(first.diff.includes(filePath), true, filePath);
    }
  });
});

test("all 실행 중 작업파일이 바뀌어도 고정 source 내용만 커밋하고 새 편집은 남긴다", async () => {
  await withRepo(async (root) => {
    await put(root, "first.txt", "base first\n");
    await put(root, "second.txt", "base second\n");
    await commitAll(root);
    await put(root, "first.txt", "planned first\n");
    await put(root, "second.txt", "planned second\n");
    const context = await readAiCommitPlanContext(root, "all");
    let changed = false;

    await new AiCommitPlanService(root).execute(
      context,
      twoGroupPlan(
        ["feat: first frozen group", "first.txt"],
        ["feat: second frozen group", "second.txt"]
      ),
      async (progress) => {
        if (progress.phase === "commit" && progress.current === 1 && !changed) {
          changed = true;
          await put(root, "second.txt", "edited while plan runs\n");
        }
      }
    );

    assert.equal(await runGit(["show", "HEAD:second.txt"], root), "planned second\n");
    assert.equal(
      await readFile(path.join(root, "second.txt"), "utf8"),
      "edited while plan runs\n"
    );
    assert.match(await runGit(["status", "--porcelain"], root), /^ M second\.txt/m);
  });
});

test("그룹 사이 외부 HEAD 커밋을 감지하면 외부 ref를 보존하고 rollback하지 않는다", async () => {
  await withRepo(async (root) => {
    await put(root, "first.txt", "base first\n");
    await put(root, "second.txt", "base second\n");
    await commitAll(root);
    await put(root, "first.txt", "planned first\n");
    await put(root, "second.txt", "planned second\n");
    const context = await readAiCommitPlanContext(root, "all");
    let externalHead = "";

    await assert.rejects(
      new AiCommitPlanService(root).execute(
        context,
        twoGroupPlan(
          ["feat: first before external head", "first.txt"],
          ["feat: second after external head", "second.txt"]
        ),
        async (progress) => {
          if (progress.phase !== "commit" || progress.current !== 1 || externalHead) {
            return;
          }
          const ourHead = await head(root);
          const tree = (await runGit(["rev-parse", `${ourHead}^{tree}`], root)).trim();
          externalHead = (await runGit(
            ["commit-tree", tree, "-p", ourHead, "-m", "external concurrent commit"],
            root
          )).trim();
          await runGit(["update-ref", "HEAD", externalHead, ourHead], root);
        }
      ),
      (error: unknown) =>
        error instanceof AiCommitPlanError && error.code === "concurrent-change"
    );

    assert.equal(await head(root), externalHead);
    assert.equal(
      await runGit(["log", "-1", "--format=%s"], root),
      "external concurrent commit\n"
    );
    assert.equal(
      (await runGit(["log", "--format=%s"], root)).includes("feat: second after external head"),
      false
    );
  });
});

test("그룹 사이 외부 staging을 감지하면 실제 index와 이미 만든 HEAD를 그대로 보존한다", async () => {
  await withRepo(async (root) => {
    await put(root, "first.txt", "base first\n");
    await put(root, "second.txt", "base second\n");
    await commitAll(root);
    await put(root, "first.txt", "planned first\n");
    await put(root, "second.txt", "planned second\n");
    const context = await readAiCommitPlanContext(root, "all");
    let firstPlanHead = "";
    let staged = false;

    await assert.rejects(
      new AiCommitPlanService(root).execute(
        context,
        twoGroupPlan(
          ["feat: first before external stage", "first.txt"],
          ["feat: second after external stage", "second.txt"]
        ),
        async (progress) => {
          if (progress.phase !== "commit" || progress.current !== 1 || staged) {
            return;
          }
          staged = true;
          firstPlanHead = await head(root);
          await put(root, "externally-staged.txt", "external index content\n");
          await runGit(["add", "externally-staged.txt"], root);
        }
      ),
      (error: unknown) =>
        error instanceof AiCommitPlanError && error.code === "concurrent-change"
    );

    assert.equal(await head(root), firstPlanHead);
    assert.match(
      await runGit(["status", "--porcelain"], root),
      /^A  externally-staged\.txt/m
    );
    assert.equal(
      await runGit(["show", ":externally-staged.txt"], root),
      "external index content\n"
    );
  });
});

test("hook이 private index에 계획 밖 파일을 stage하면 실제 branch/index를 바꾸지 않는다", async (context) => {
  if (process.platform === "win32") {
    context.skip("executable shell hook test is Unix-specific");
    return;
  }
  await withRepo(async (root) => {
    await put(root, "planned.txt", "base\n");
    await commitAll(root);
    const originalHead = await head(root);
    await put(root, "planned.txt", "planned\n");
    const planContext = await readAiCommitPlanContext(root, "all");
    const gitDir = (await runGit(["rev-parse", "--absolute-git-dir"], root)).trim();
    const hookPath = path.join(gitDir, "hooks", "pre-commit");
    await put(root, path.relative(root, hookPath), [
      "#!/bin/sh",
      "test \"$GIT_SIMPLE_COMPARE_AI_PLAN_PROVISIONAL\" = \"1\" || exit 42",
      "printf 'hook extra\\n' > hook-extra.txt",
      "git add hook-extra.txt",
      "",
    ].join("\n"));
    await chmod(hookPath, 0o755);

    await assert.rejects(
      new AiCommitPlanService(root).execute(planContext, {
        groups: [{ message: "feat: planned only", paths: ["planned.txt"] }],
        warnings: [],
      }),
      (error: unknown) => error instanceof AiCommitPlanError &&
        error.code === "commit-tree-mismatch"
    );
    assert.equal(await head(root), originalHead);
    assert.equal(await runGit(["diff", "--cached"], root), "");
    assert.match(await runGit(["status", "--porcelain"], root), /\?\? hook-extra\.txt/);
  });
});

test("같은 OID의 다른 symbolic branch로 바뀌면 private 결과를 publish하지 않는다", async () => {
  await withRepo(async (root) => {
    await put(root, "one.txt", "base one\n");
    await put(root, "two.txt", "base two\n");
    await commitAll(root);
    const originalBranch = (await runGit(["branch", "--show-current"], root)).trim();
    const originalHead = await head(root);
    await put(root, "one.txt", "planned one\n");
    await put(root, "two.txt", "planned two\n");
    const planContext = await readAiCommitPlanContext(root, "all");
    let switched = false;

    await assert.rejects(new AiCommitPlanService(root).execute(
      planContext,
      twoGroupPlan(["feat: private one", "one.txt"], ["feat: private two", "two.txt"]),
      async (progress) => {
        if (progress.phase === "commit" && progress.current === 1 && !switched) {
          switched = true;
          await runGit(["branch", "same-oid-branch", originalHead], root);
          await runGit(["symbolic-ref", "HEAD", "refs/heads/same-oid-branch"], root);
        }
      }
    ), (error: unknown) => error instanceof AiCommitPlanError &&
      error.code === "concurrent-change");
    assert.equal(await head(root), originalHead);
    assert.equal((await runGit(["branch", "--show-current"], root)).trim(), "same-oid-branch");
    assert.equal((await runGit(["rev-parse", originalBranch], root)).trim(), originalHead);
  });
});

test("pathspec magic 파일명도 NUL index entry로 서로 다른 커밋에 정확히 분리한다", async () => {
  await withRepo(async (root) => {
    await put(root, "literal*.txt", "base star\n");
    await put(root, "literal-other.txt", "base other\n");
    await commitAll(root);
    await put(root, "literal*.txt", "planned star\n");
    await put(root, "literal-other.txt", "planned other\n");
    const planContext = await readAiCommitPlanContext(root, "all");
    await new AiCommitPlanService(root).execute(planContext, twoGroupPlan(
      ["feat: exact star path", "literal*.txt"],
      ["feat: exact other path", "literal-other.txt"]
    ));
    assert.deepEqual(
      (await runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD~1"], root)).trim().split("\n"),
      ["literal*.txt"]
    );
    assert.deepEqual(
      (await runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], root)).trim().split("\n"),
      ["literal-other.txt"]
    );
  });
});

test("detached HEAD에서는 publish할 local branch가 없어 context 생성을 거부한다", async () => {
  await withRepo(async (root) => {
    await put(root, "detached.txt", "base\n");
    await commitAll(root);
    await runGit(["checkout", "--detach"], root);
    await put(root, "detached.txt", "changed\n");
    await assert.rejects(readAiCommitPlanContext(root, "all"), (error: unknown) =>
      error instanceof AiCommitPlanError && error.code === "unsupported-head");
  });
});
