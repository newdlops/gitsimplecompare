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
import {
  CommitHookPreflightError,
  CommitHookPreflightService,
} from "../src/git/commitHookPreflightService";
import {
  buildCommitFailureReport,
} from "../src/git/commitHookFailure";
import { runGit } from "../src/git/gitExec";

process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL =
  process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * 사용자 전역 설정과 분리된 임시 Git 저장소를 만들고 commit identity를 설정한다.
 * @returns 테스트가 finally에서 제거해야 하는 저장소 루트
 */
async function createRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-hook-preflight-"));
  await runGit(["init", "--quiet"], root);
  await runGit(["config", "user.name", "Hook Preflight Test"], root);
  await runGit(
    ["config", "user.email", "hook-preflight@example.com"],
    root
  );
  await runGit(["config", "commit.gpgSign", "false"], root);
  return root;
}

/**
 * 임시 저장소 생명주기를 테스트 callback과 묶어 실패 시에도 파일을 남기지 않는다.
 * @param run 생성된 저장소를 사용하는 테스트 본문
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
 * 저장소 상대 경로에 UTF-8 파일을 쓰고 필요한 상위 디렉터리를 만든다.
 * @param repoRoot 임시 저장소 루트
 * @param filePath 저장소 상대 경로
 * @param content 기록할 본문
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
 * 현재 파일 전체를 stage해 테스트 기준점 commit을 만든다.
 * @param repoRoot 임시 저장소 루트
 * @param message 기준점 메시지
 */
async function commitAll(
  repoRoot: string,
  message = "base"
): Promise<void> {
  await runGit(["add", "-A"], repoRoot);
  await runGit(["commit", "--quiet", "-m", message], repoRoot);
}

/**
 * 실제 hooks 디렉터리에 실행 가능한 POSIX shell hook을 만든다.
 * @param repoRoot 임시 저장소 루트
 * @param name 표준 hook 파일 이름
 * @param body shebang 뒤에 붙일 shell 본문
 */
async function writeHook(
  repoRoot: string,
  name: "pre-commit" | "prepare-commit-msg" | "commit-msg",
  body: string
): Promise<void> {
  const gitDir = (
    await runGit(["rev-parse", "--absolute-git-dir"], repoRoot)
  ).trim();
  const hookPath = path.join(gitDir, "hooks", name);
  await writeFile(hookPath, `#!/bin/sh\nset -eu\n${body}\n`, "utf8");
  if (process.platform !== "win32") {
    await chmod(hookPath, 0o755);
  }
}

/**
 * 현재 실제 index가 stage한 path를 NUL 안전 출력으로 읽어 정렬한다.
 * @param repoRoot 임시 저장소 루트
 * @returns 실제 index의 staged path 목록
 */
async function stagedPaths(repoRoot: string): Promise<string[]> {
  const raw = await runGit(
    ["diff", "--cached", "--name-only", "-z", "--"],
    repoRoot
  );
  return raw.split("\0").filter(Boolean).sort();
}

test("pre-commit은 staged snapshot만 보고 hook의 git add는 실제 index를 바꾸지 않는다", async (context) => {
  if (process.platform === "win32") {
    context.skip("executable shell hook test is Unix-specific");
    return;
  }
  await withRepo(async (root) => {
    await put(root, "tracked.txt", "base\n");
    await commitAll(root);
    const originalHead = (
      await runGit(["rev-parse", "HEAD"], root)
    ).trim();
    await put(root, "tracked.txt", "base\nstaged\n");
    await runGit(["add", "tracked.txt"], root);
    await put(root, "tracked.txt", "base\nstaged\nunstaged\n");
    await put(root, "untracked.txt", "not staged\n");
    await writeHook(
      root,
      "pre-commit",
      [
        'test "$GIT_SIMPLE_COMPARE_HOOK_PREFLIGHT" = "1"',
        "git diff --cached --name-only > hook-seen.txt",
        "printf 'generated\\n' > generated.txt",
        "git add generated.txt",
        "printf 'successful stderr\\n' >&2",
      ].join("\n")
    );

    const result = await new CommitHookPreflightService(root).run(
      "feat: preview hooks"
    );

    assert.equal(result.stagedFileCount, 1);
    assert.deepEqual(
      result.executions.map(({ hook }) => hook),
      ["pre-commit"]
    );
    assert.match(result.executions[0]?.stderr ?? "", /successful stderr/);
    assert.match(result.transcript, /\[pre-commit\] PASSED/);
    assert.equal(
      await readFile(path.join(root, "hook-seen.txt"), "utf8"),
      "tracked.txt\n"
    );
    assert.deepEqual(await stagedPaths(root), ["tracked.txt"]);
    await assert.rejects(
      runGit(["show", ":generated.txt"], root)
    );
    assert.equal(
      (await runGit(["rev-parse", "HEAD"], root)).trim(),
      originalHead
    );
  });
});

test("실패 hook의 원문과 이름을 보존해 기존 파일 진단 카드가 재사용한다", async (context) => {
  if (process.platform === "win32") {
    context.skip("executable shell hook test is Unix-specific");
    return;
  }
  await withRepo(async (root) => {
    await put(root, "src/a.ts", "console.log('x');\n");
    await runGit(["add", "src/a.ts"], root);
    await writeHook(
      root,
      "pre-commit",
      "printf 'src/a.ts:1:1: error no-console\\n' >&2\nexit 1"
    );

    let failure: unknown;
    try {
      await new CommitHookPreflightService(root).run("test: fail checks");
    } catch (error) {
      failure = error;
    }

    assert.equal(failure instanceof CommitHookPreflightError, true);
    const typed = failure as CommitHookPreflightError;
    assert.equal(typed.code, "hookFailed");
    assert.equal(typed.hookName, "pre-commit");
    assert.match(typed.transcript, /src\/a\.ts:1:1: error no-console/);
    const report = buildCommitFailureReport(typed, root, {
      knownHookName: typed.hookName,
      operation: "staged",
      origin: "hookPreflight",
    });
    assert.equal(report.likelyHook, true);
    assert.equal(report.origin, "hookPreflight");
    assert.equal(report.items[0]?.path, "src/a.ts");
    assert.deepEqual(await stagedPaths(root), ["src/a.ts"]);
  });
});

test("prepare-commit-msg가 바꾼 메시지를 commit-msg가 같은 순서로 검사한다", async (context) => {
  if (process.platform === "win32") {
    context.skip("executable shell hook test is Unix-specific");
    return;
  }
  await withRepo(async (root) => {
    await put(root, "message.txt", "staged\n");
    await runGit(["add", "message.txt"], root);
    await writeHook(
      root,
      "pre-commit",
      "printf 'pre-commit\\n' >> hook-order.txt"
    );
    await writeHook(
      root,
      "prepare-commit-msg",
      [
        'test "$2" = "message"',
        "printf '\\nPrepared-by-hook\\n' >> \"$1\"",
        "printf 'prepare-commit-msg\\n' >> hook-order.txt",
      ].join("\n")
    );
    await writeHook(
      root,
      "commit-msg",
      [
        "grep -q 'Prepared-by-hook' \"$1\"",
        "printf 'commit-msg\\n' >> hook-order.txt",
      ].join("\n")
    );

    const result = await new CommitHookPreflightService(root).run(
      "feat: validate message"
    );

    assert.deepEqual(
      result.executions.map(({ hook }) => hook),
      ["pre-commit", "prepare-commit-msg", "commit-msg"]
    );
    assert.deepEqual(result.skippedHooks, []);
    assert.equal(
      await readFile(path.join(root, "hook-order.txt"), "utf8"),
      "pre-commit\nprepare-commit-msg\ncommit-msg\n"
    );
  });
});

test("빈 메시지는 pre-commit만 실행하고 설치된 메시지 hook을 명시적으로 건너뛴다", async (context) => {
  if (process.platform === "win32") {
    context.skip("executable shell hook test is Unix-specific");
    return;
  }
  await withRepo(async (root) => {
    await put(root, "empty-message.txt", "staged\n");
    await runGit(["add", "empty-message.txt"], root);
    await writeHook(root, "pre-commit", "printf 'ran\\n' > pre-ran.txt");
    await writeHook(root, "prepare-commit-msg", "exit 91");
    await writeHook(root, "commit-msg", "exit 92");

    const result = await new CommitHookPreflightService(root).run("   ");

    assert.deepEqual(
      result.executions.map(({ hook }) => hook),
      ["pre-commit"]
    );
    assert.deepEqual(result.skippedHooks, [
      "prepare-commit-msg",
      "commit-msg",
    ]);
    assert.match(result.transcript, /commit-msg\] SKIPPED/);
  });
});

test("첫 commit 전 unborn 저장소에서도 staged pre-commit을 실행한다", async (context) => {
  if (process.platform === "win32") {
    context.skip("executable shell hook test is Unix-specific");
    return;
  }
  await withRepo(async (root) => {
    await put(root, "initial.txt", "initial\n");
    await runGit(["add", "initial.txt"], root);
    await writeHook(
      root,
      "pre-commit",
      "git diff --cached --name-only | grep -q '^initial.txt$'"
    );

    const result = await new CommitHookPreflightService(root).run(
      "feat: initial"
    );

    assert.equal(result.stagedFileCount, 1);
    assert.deepEqual(
      result.executions.map(({ hook }) => hook),
      ["pre-commit"]
    );
    await assert.rejects(
      runGit(["rev-parse", "--verify", "HEAD"], root)
    );
    assert.deepEqual(await stagedPaths(root), ["initial.txt"]);
  });
});
