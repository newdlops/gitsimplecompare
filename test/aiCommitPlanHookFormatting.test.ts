import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { CommitPlanResult } from "../src/ai/commitPlanModel";
import { readAiCommitPlanContext } from "../src/git/aiCommitPlanContext";
import {
  AiCommitPlanError,
  AiCommitPlanService,
} from "../src/git/aiCommitPlanService";
import { runGit } from "../src/git/gitExec";

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

/** ITA entry의 stage와 tag 원문을 함께 보존하는 비교용 snapshot이다. */
interface IndexPathMetadata {
  stage: string;
  tag: string;
}

/**
 * 사용자 전역 Git 설정과 분리된 born local branch 임시 저장소를 만든다.
 * commit hook 검증이 서명이나 사용자 설정에 영향받지 않도록 identity와 서명을 고정한다.
 * @returns 테스트 종료 시 삭제할 임시 저장소 루트
 */
async function createRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-ai-hook-format-"));
  await runGit(["init", "--quiet"], root);
  await runGit(["config", "user.name", "AI Hook Format Test"], root);
  await runGit(["config", "user.email", "ai-hook-format@example.com"], root);
  await runGit(["config", "commit.gpgSign", "false"], root);
  return root;
}

/**
 * 임시 저장소를 테스트 본문에 넘기고 성공·실패와 관계없이 전체 디렉터리를 정리한다.
 * linked worktree처럼 저장소 밖 sibling을 만든 테스트는 본문 finally에서 먼저 제거해야 한다.
 * @param run 생성된 저장소 루트를 받는 비동기 테스트 본문
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
 * 저장소 상대 경로에 UTF-8 파일을 쓰고 누락된 상위 디렉터리를 함께 만든다.
 * @param repoRoot 파일이 속한 작업트리 루트
 * @param filePath 저장소 기준 상대 경로
 * @param content 저장할 UTF-8 본문
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
 * 현재 작업트리 전체를 stage하고 formatter 테스트의 기준 commit을 만든다.
 * @param repoRoot commit할 저장소 루트
 * @param message 선택 기준 commit 메시지
 */
async function commitAll(
  repoRoot: string,
  message = "base"
): Promise<void> {
  await runGit(["add", "-A"], repoRoot);
  await runGit(["commit", "-m", message], repoRoot);
}

/**
 * 현재 작업트리의 HEAD 전체 OID를 읽어 branch publish 여부를 비교한다.
 * @param repoRoot 조회할 저장소 또는 linked worktree 루트
 * @returns 현재 HEAD commit의 전체 OID
 */
async function head(repoRoot: string): Promise<string> {
  return (await runGit(["rev-parse", "HEAD"], repoRoot)).trim();
}

/**
 * Unix 실행형 pre-commit hook을 실제 common hook 디렉터리에 설치한다.
 * helper가 provisional 환경 검증과 strict shell 모드를 공통 적용해 각 테스트는 mutation만 기술한다.
 * @param repoRoot hook을 공유하는 main 저장소 루트
 * @param commands shebang 뒤에 순서대로 실행할 shell 명령
 */
async function installPreCommitHook(
  repoRoot: string,
  commands: readonly string[]
): Promise<void> {
  const gitDir = (
    await runGit(["rev-parse", "--absolute-git-dir"], repoRoot)
  ).trim();
  const hookPath = path.join(gitDir, "hooks", "pre-commit");
  await mkdir(path.dirname(hookPath), { recursive: true });
  await writeFile(
    hookPath,
    [
      "#!/bin/sh",
      "set -eu",
      'test "$GIT_SIMPLE_COMPARE_AI_PLAN_PROVISIONAL" = "1"',
      ...commands,
      "",
    ].join("\n"),
    "utf8"
  );
  await chmod(hookPath, 0o755);
}

/**
 * 두 path를 각각 독립 commit으로 소유하는 planner 호환 결과를 만든다.
 * @param firstPath 첫 번째 commit이 소유할 exact path
 * @param secondPath 두 번째 commit이 소유할 exact path
 * @returns 고정 메시지와 두 그룹을 가진 실행 계획
 */
function twoGroupPlan(
  firstPath: string,
  secondPath: string
): CommitPlanResult {
  return {
    groups: [
      { message: "feat: format first", paths: [firstPath] },
      { message: "feat: format second", paths: [secondPath] },
    ],
    warnings: [],
  };
}

/**
 * 한 path만 소유하는 formatter 실행 계획을 만든다.
 * @param filePath commit에 포함할 exact path
 * @param message 생성할 commit 메시지
 * @returns 단일 그룹 planner 호환 결과
 */
function oneGroupPlan(
  filePath: string,
  message: string
): CommitPlanResult {
  return {
    groups: [{ message, paths: [filePath] }],
    warnings: [],
  };
}

/**
 * 실제 index의 stage entry 원문을 읽어 실패 전후 semantic 보존을 비교한다.
 * @param repoRoot index를 조회할 저장소 루트
 * @returns mode/OID/stage/path를 포함한 NUL 구분 원문
 */
async function stagedEntries(repoRoot: string): Promise<string> {
  return runGit(["ls-files", "--stage", "-z"], repoRoot);
}

/**
 * 특정 index path의 stage entry와 `ls-files -v` tag를 함께 읽는다.
 * intent-to-add의 zero OID와 extended flag 성격이 formatter publish 뒤에도 유지되는지 비교한다.
 * @param repoRoot 실제 index가 속한 저장소 루트
 * @param filePath 확인할 exact path
 * @returns stage 원문과 tag 원문 snapshot
 */
async function indexPathMetadata(
  repoRoot: string,
  filePath: string
): Promise<IndexPathMetadata> {
  return {
    stage: await runGit(
      ["ls-files", "--stage", "-z", "--", filePath],
      repoRoot
    ),
    tag: await runGit(["ls-files", "-v", "-z", "--", filePath], repoRoot),
  };
}

test(
  "linked worktree의 staged 두 그룹은 현재 그룹 formatter 결과를 누적해 publish한다",
  { skip: process.platform === "win32" },
  async () => {
    await withRepo(async (root) => {
      await put(root, "first.txt", "base first\n");
      await put(root, "second.txt", "base second\n");
      await commitAll(root);
      const mainHead = await head(root);
      const linkedRoot = `${root}-linked`;
      try {
        await runGit(
          ["worktree", "add", "--quiet", "-b", "hook-format", linkedRoot],
          root
        );
        await installPreCommitHook(root, [
          'current=$(git diff --cached --name-only)',
          'case "$current" in',
          "  first.txt)",
          '    printf "planned first\\nhook formatted first\\n" > "$GIT_WORK_TREE/first.txt"',
          '    git add -- "first.txt"',
          "    ;;",
          "  second.txt)",
          '    printf "planned second\\nhook formatted second\\n" > "$GIT_WORK_TREE/second.txt"',
          '    git add -- "second.txt"',
          "    ;;",
          "  *) exit 41 ;;",
          "esac",
        ]);
        await put(linkedRoot, "first.txt", "planned first\n");
        await put(linkedRoot, "second.txt", "planned second\n");
        await runGit(["add", "first.txt", "second.txt"], linkedRoot);
        const context = await readAiCommitPlanContext(linkedRoot, "staged");

        const result = await new AiCommitPlanService(linkedRoot).execute(
          context,
          twoGroupPlan("first.txt", "second.txt")
        );

        assert.equal(result.commits.length, 2);
        assert.equal(
          await runGit(["show", "HEAD~1:first.txt"], linkedRoot),
          "planned first\nhook formatted first\n"
        );
        assert.equal(
          await runGit(["show", "HEAD~1:second.txt"], linkedRoot),
          "base second\n"
        );
        assert.equal(
          await runGit(["show", "HEAD:second.txt"], linkedRoot),
          "planned second\nhook formatted second\n"
        );
        assert.equal(await runGit(["diff", "--cached"], linkedRoot), "");
        assert.equal(await runGit(["diff"], linkedRoot), "");
        assert.equal(await runGit(["status", "--porcelain"], linkedRoot), "");
        assert.equal(await head(root), mainHead);
      } finally {
        await runGit(["worktree", "remove", "--force", linkedRoot], root)
          .catch(() => undefined);
        await rm(linkedRoot, { recursive: true, force: true });
      }
    });
  }
);

test(
  "staged와 unstaged가 함께 있는 path를 hook이 add하면 ignorestat에서도 거부한다",
  { skip: process.platform === "win32" },
  async () => {
    await withRepo(async (root) => {
      await put(root, "partial.txt", "base\n");
      await commitAll(root);
      await put(root, "partial.txt", "base\nstaged\n");
      await runGit(["add", "partial.txt"], root);
      await put(root, "partial.txt", "base\nstaged\nunstaged\n");
      await runGit(["config", "core.ignorestat", "true"], root);
      const context = await readAiCommitPlanContext(root, "staged");
      assert.equal(context.files[0]?.unstaged, true);
      const originalHead = await head(root);
      const originalIndex = await stagedEntries(root);
      await installPreCommitHook(root, [
        'printf "base\\nstaged\\nunstaged\\nhook formatted\\n" > "$GIT_WORK_TREE/partial.txt"',
        'git add -- "partial.txt"',
      ]);

      await assert.rejects(
        new AiCommitPlanService(root).execute(
          context,
          oneGroupPlan("partial.txt", "feat: format partial")
        ),
        (error: unknown) =>
          error instanceof AiCommitPlanError &&
          error.code === "commit-tree-mismatch"
      );

      assert.equal(await head(root), originalHead);
      assert.equal(await stagedEntries(root), originalIndex);
      assert.equal(await runGit(["show", ":partial.txt"], root), "base\nstaged\n");
      assert.equal(
        await readFile(path.join(root, "partial.txt"), "utf8"),
        "base\nstaged\nunstaged\nhook formatted\n"
      );
    });
  }
);

test(
  "unrelated intent-to-add metadata는 staged formatter publish 뒤에도 보존한다",
  { skip: process.platform === "win32" },
  async () => {
    await withRepo(async (root) => {
      await put(root, "formatted.txt", "base\n");
      await commitAll(root);
      await put(root, "formatted.txt", "planned\n");
      await runGit(["add", "formatted.txt"], root);
      await put(root, "intent.txt", "intent worktree content\n");
      await runGit(["add", "-N", "--", "intent.txt"], root);
      const context = await readAiCommitPlanContext(root, "staged");
      assert.deepEqual(context.files.map((file) => file.path), ["formatted.txt"]);
      const intentBefore = await indexPathMetadata(root, "intent.txt");
      assert.notEqual(intentBefore.stage, "");
      assert.notEqual(intentBefore.tag, "");
      await installPreCommitHook(root, [
        'printf "planned\\nhook formatted\\n" > "$GIT_WORK_TREE/formatted.txt"',
        'git add -- "formatted.txt"',
      ]);

      const result = await new AiCommitPlanService(root).execute(
        context,
        oneGroupPlan("formatted.txt", "feat: preserve intent-to-add")
      );

      assert.equal(result.commits.length, 1);
      assert.equal(
        await runGit(["show", "HEAD:formatted.txt"], root),
        "planned\nhook formatted\n"
      );
      assert.deepEqual(
        await indexPathMetadata(root, "intent.txt"),
        intentBefore
      );
      assert.equal(
        await runGit(["diff", "--cached", "--", "formatted.txt"], root),
        ""
      );
      const status = await runGit(["status", "--porcelain"], root);
      assert.doesNotMatch(status, /formatted\.txt/);
      assert.match(status, /^ A intent\.txt$/m);
    });
  }
);

test(
  "staged formatter publish는 split-index와 unrelated index flags를 보존한다",
  { skip: process.platform === "win32" },
  async () => {
    await withRepo(async (root) => {
      await put(root, "formatted.txt", "base formatted\n");
      await put(root, "assumed.txt", "base assumed\n");
      await put(root, "skipped.txt", "base skipped\n");
      await commitAll(root);
      await runGit(["update-index", "--split-index"], root);
      await runGit(["update-index", "--assume-unchanged", "assumed.txt"], root);
      await runGit(["update-index", "--skip-worktree", "skipped.txt"], root);
      await put(root, "formatted.txt", "planned formatted\n");
      await runGit(["add", "formatted.txt"], root);
      const context = await readAiCommitPlanContext(root, "staged");
      const assumedBefore = await indexPathMetadata(root, "assumed.txt");
      const skippedBefore = await indexPathMetadata(root, "skipped.txt");
      assert.notEqual(
        (await runGit(["rev-parse", "--shared-index-path"], root)).trim(),
        ""
      );
      await installPreCommitHook(root, [
        'printf "planned formatted\\nhook formatted\\n" > "$GIT_WORK_TREE/formatted.txt"',
        'git add -- "formatted.txt"',
      ]);

      const result = await new AiCommitPlanService(root).execute(
        context,
        oneGroupPlan("formatted.txt", "feat: preserve split index flags")
      );

      assert.equal(result.commits.length, 1);
      assert.equal(
        await runGit(["show", "HEAD:formatted.txt"], root),
        "planned formatted\nhook formatted\n"
      );
      assert.deepEqual(
        await indexPathMetadata(root, "assumed.txt"),
        assumedBefore
      );
      assert.deepEqual(
        await indexPathMetadata(root, "skipped.txt"),
        skippedBefore
      );
      assert.notEqual(
        (await runGit(["rev-parse", "--shared-index-path"], root)).trim(),
        ""
      );
      assert.equal(await runGit(["status", "--porcelain"], root), "");
    });
  }
);

test(
  "hook이 첫 commit에서 미래 그룹 path까지 stage하면 전체 publish를 거부한다",
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
      const originalHead = await head(root);
      const originalIndex = await stagedEntries(root);
      await installPreCommitHook(root, [
        'current=$(git diff --cached --name-only)',
        'if test "$current" = "first.txt"; then',
        '  git add -- "second.txt"',
        "fi",
      ]);

      await assert.rejects(
        new AiCommitPlanService(root).execute(
          context,
          twoGroupPlan("first.txt", "second.txt")
        ),
        (error: unknown) =>
          error instanceof AiCommitPlanError &&
          error.code === "commit-tree-mismatch"
      );

      assert.equal(await head(root), originalHead);
      assert.equal(await stagedEntries(root), originalIndex);
      assert.equal(await runGit(["show", ":first.txt"], root), "planned first\n");
      assert.equal(await runGit(["show", ":second.txt"], root), "planned second\n");
    });
  }
);

test(
  "all scope formatter 결과는 HEAD와 index에 반영하고 작업트리를 clean으로 만든다",
  { skip: process.platform === "win32" },
  async () => {
    await withRepo(async (root) => {
      await put(root, "all.txt", "base\n");
      await commitAll(root);
      await put(root, "all.txt", "planned all\n");
      const context = await readAiCommitPlanContext(root, "all");
      await installPreCommitHook(root, [
        'printf "planned all\\nhook formatted all\\n" > "$GIT_WORK_TREE/all.txt"',
        'git add -- "all.txt"',
      ]);

      const result = await new AiCommitPlanService(root).execute(
        context,
        oneGroupPlan("all.txt", "feat: format all scope")
      );

      const expected = "planned all\nhook formatted all\n";
      assert.equal(result.commits.length, 1);
      assert.equal(await runGit(["show", "HEAD:all.txt"], root), expected);
      assert.equal(await runGit(["show", ":all.txt"], root), expected);
      assert.equal(await readFile(path.join(root, "all.txt"), "utf8"), expected);
      assert.equal(await runGit(["diff", "--cached"], root), "");
      assert.equal(await runGit(["diff"], root), "");
      assert.equal(await runGit(["status", "--porcelain"], root), "");
    });
  }
);
