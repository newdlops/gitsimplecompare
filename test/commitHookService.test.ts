import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { CommitHookService } from "../src/git/commitHookService";
import { buildCommitFailureReport } from "../src/git/commitHookFailure";
import { GitError, runGit } from "../src/git/gitExec";

const execFileAsync = promisify(execFile);
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * 임시 저장소에서 Git 명령을 셸 없이 실행한다.
 * @param repoRoot 명령 실행 디렉터리
 * @param args git 하위 명령과 인자
 * @returns stdout 문자열
 */
async function git(repoRoot: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.stdout;
}

/**
 * 사용자 전역 설정과 분리된 최소 Git 저장소를 만든다.
 * @returns 테스트가 자유롭게 변경하고 마지막에 삭제할 저장소 경로
 */
async function createRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-hooks-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Hook Test"]);
  await git(root, ["config", "user.email", "hook@example.com"]);
  return root;
}

/**
 * hook 테스트 본문을 임시 저장소에서 실행하고 성공/실패와 무관하게 디렉터리를 정리한다.
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
 * Unix shell hook을 지정 경로에 만들고 실행 권한을 보장한다.
 * @param filePath 생성할 hook 절대 경로
 * @param body hook 내용 식별에 쓸 본문
 */
async function writeHook(filePath: string, body = "echo checked"): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `#!/bin/sh\n${body}\n`, "utf8");
  if (process.platform !== "win32") {
    await chmod(filePath, 0o755);
  }
}

test("기본 .git/hooks에서 sample을 제외하고 active hook만 조회한다", async () => {
  await withRepo(async (root) => {
    const service = new CommitHookService(root);
    assert.deepEqual((await service.inspect()).hooks, []);
    const hookPath = path.join(root, ".git", "hooks", "pre-commit");
    await writeHook(hookPath);
    const snapshot = await service.inspect();
    assert.equal(snapshot.directory, path.join(root, ".git", "hooks"));
    assert.equal(snapshot.hooks.length, 1);
    assert.equal(snapshot.hooks[0]?.name, "pre-commit");
    assert.equal(snapshot.hooks[0]?.enabled, true);
    await assert.rejects(service.create("pre-commit"), /already exists/);
    await assert.rejects(
      service.create("../pre-commit" as never),
      /Unsupported commit hook/
    );
    await assert.rejects(
      service.create("commit-msg", path.join(root, "unexpected-hooks")),
      /hook path changed/i
    );
  });
});

test("실제 effective hooks 경로의 실행 가능한 표준 entrypoint만 빠르게 조회한다", async (context) => {
  if (process.platform === "win32") {
    context.skip("executable entrypoint filtering is Unix-specific");
    return;
  }
  await withRepo(async (root) => {
    await git(root, ["config", "core.hooksPath", ".githooks"]);
    const hooks = path.join(root, ".githooks");
    await writeHook(path.join(hooks, "commit-msg"));
    await writeHook(path.join(hooks, "pre-commit"));
    await writeHook(path.join(hooks, "post-commit.sample"));
    await writeHook(path.join(hooks, "post-rewrite"));
    await chmod(path.join(hooks, "post-rewrite"), 0o644);

    const service = new CommitHookService(root);
    assert.deepEqual(await service.enabledEntrypoints(), [
      "pre-commit",
      "commit-msg",
    ]);

    await chmod(path.join(hooks, "post-rewrite"), 0o755);
    assert.deepEqual(await service.enabledEntrypoints(), [
      "pre-commit",
      "commit-msg",
      "post-rewrite",
    ]);
  });
});

test("local hook 내용을 유지하며 실행 비트로 비활성화하고 다시 활성화한다", async (context) => {
  if (process.platform === "win32") {
    context.skip("safe executable-bit toggling is Unix-specific");
    return;
  }
  await withRepo(async (root) => {
    const service = new CommitHookService(root);
    const active = path.join(root, ".git", "hooks", "pre-commit");
    await writeHook(active, "echo keep-this-content");
    await assert.rejects(
      service.setEnabled(
        "pre-commit",
        false,
        path.join(root, "unexpected-hooks")
      ),
      /hook path changed/i
    );

    const off = await service.setEnabled("pre-commit", false);
    assert.equal(off.hooks[0]?.state, "notExecutable");
    assert.match(await readFile(active, "utf8"), /keep-this-content/);
    assert.equal((await stat(active)).mode & 0o111, 0);

    const on = await service.setEnabled("pre-commit", true);
    assert.equal(on.hooks[0]?.state, "enabled");
    assert.match(await readFile(active, "utf8"), /keep-this-content/);
    assert.equal((await stat(active)).mode & 0o111, 0o111);

    await writeHook(`${active}.disabled`, "echo duplicate");
    const conflict = await service.inspect();
    assert.equal(conflict.hooks[0]?.state, "conflict");
    assert.equal(conflict.hooks[0]?.canToggle, false);
    await unlink(active);
    const renamed = await service.inspect();
    assert.equal(renamed.hooks[0]?.state, "disabled");
    assert.equal(renamed.hooks[0]?.toggleBlockedReason, "renamed");
    await assert.rejects(
      service.setEnabled("pre-commit", true),
      /cannot be changed in its current state/
    );
  });
});

test("tracked custom hook은 작업트리 오염을 막기 위해 토글을 거부한다", async () => {
  await withRepo(async (root) => {
    await git(root, ["config", "core.hooksPath", ".githooks"]);
    const active = path.join(root, ".githooks", "pre-commit");
    await writeHook(active);
    await git(root, ["add", ".githooks/pre-commit"]);
    const service = new CommitHookService(root);
    const before = await service.inspect();
    assert.equal(before.hooks[0]?.tracked, true);
    assert.equal(before.hooks[0]?.canToggle, false);
    await assert.rejects(
      service.setEnabled("pre-commit", false),
      /cannot be toggled safely/
    );
    assert.match(await readFile(active, "utf8"), /checked/);
    await unlink(active);
    const trackedMissing = await service.inspect();
    assert.equal(trackedMissing.creatable.includes("pre-commit"), false);
    await assert.rejects(service.create("pre-commit"), /tracked by Git/);
  });
});

test("미추적 custom hook은 막고 ignore된 local hook은 안전하게 토글한다", async (context) => {
  if (process.platform === "win32") {
    context.skip("safe executable-bit toggling is Unix-specific");
    return;
  }
  await withRepo(async (root) => {
    await git(root, ["config", "core.hooksPath", ".githooks"]);
    const active = path.join(root, ".githooks", "pre-commit");
    await writeHook(active);
    const service = new CommitHookService(root);
    const visible = await service.inspect();
    assert.equal(visible.hooks[0]?.worktreeVisible, true);
    assert.equal(visible.hooks[0]?.canToggle, false);
    await assert.rejects(
      service.setEnabled("pre-commit", false),
      /could be included in the next commit/
    );

    await writeFile(
      path.join(root, ".gitignore"),
      ".githooks/pre-commit\n",
      "utf8"
    );
    const oneNameIgnored = await service.inspect();
    assert.equal(oneNameIgnored.hooks[0]?.worktreeVisible, false);
    assert.equal(oneNameIgnored.hooks[0]?.canToggle, true);

    await writeFile(path.join(root, ".gitignore"), ".githooks/\n", "utf8");
    const ignored = await service.inspect();
    assert.equal(ignored.hooks[0]?.worktreeVisible, false);
    assert.equal(ignored.hooks[0]?.canToggle, true);
    const disabled = await service.setEnabled("pre-commit", false);
    assert.equal(disabled.hooks[0]?.state, "notExecutable");
  });
});

test("Husky v9 entrypoint와 사용자 .husky hook 경로를 분리한다", async () => {
  await withRepo(async (root) => {
    await git(root, ["config", "core.hooksPath", ".husky/_"]);
    const userHook = path.join(root, ".husky", "pre-commit");
    const userMessageHook = path.join(root, ".husky", "commit-msg");
    const wrapper = path.join(root, ".husky", "_", "pre-commit");
    await writeHook(
      path.join(root, ".husky", "_", "h"),
      'hook="$(dirname "$0")/../$(basename "$0")"\n[ ! -f "$hook" ] || sh -e "$hook" "$@"'
    );
    await writeHook(wrapper, '. "$(dirname "$0")/h"');
    await writeHook(
      path.join(root, ".husky", "_", "prepare-commit-msg"),
      '. "$(dirname "$0")/h"'
    );
    await writeHook(
      path.join(root, ".husky", "_", "commit-msg"),
      '. "$(dirname "$0")/h"'
    );
    await writeFile(userHook, "echo checked\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(userHook, 0o644);
    }
    const service = new CommitHookService(root);
    const snapshot = await service.inspect();
    assert.equal(snapshot.framework, "husky");
    assert.equal(snapshot.directory, path.join(root, ".husky"));
    assert.equal(snapshot.effectiveDirectory, path.join(root, ".husky", "_"));
    assert.equal(snapshot.hooks[0]?.path, userHook);
    assert.equal(snapshot.hooks[0]?.state, "enabled");
    assert.deepEqual(await service.enabledEntrypoints(), ["pre-commit"]);

    await writeFile(userMessageHook, "echo validate message\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(userMessageHook, 0o644);
    }
    assert.deepEqual(await service.enabledEntrypoints(), [
      "pre-commit",
      "commit-msg",
    ]);
    await unlink(userMessageHook);
    assert.deepEqual(await service.enabledEntrypoints(), ["pre-commit"]);

    if (process.platform !== "win32") {
      await chmod(wrapper, 0o644);
      assert.deepEqual(await service.enabledEntrypoints(), []);
      assert.equal(
        (await service.inspect()).hooks[0]?.state,
        "entrypointMissing"
      );
      assert.equal((await service.inspect()).hooks[0]?.canToggle, false);
    }
  });
});

test("symlink 별칭으로 지정한 Husky v9 경로도 사용자 hook을 관리한다", async (context) => {
  if (process.platform === "win32") {
    context.skip("symlink permission differs on Windows");
    return;
  }
  await withRepo(async (root) => {
    const husky = path.join(root, ".husky");
    const runtime = path.join(husky, "_");
    const marker = path.join(root, "hook-ran");
    await writeHook(
      path.join(runtime, "h"),
      'n=$(basename "$0")\ns=$(dirname "$(dirname "$0")")/$n\n[ ! -f "$s" ] && exit 0\nsh -e "$s" "$@"'
    );
    await writeHook(path.join(runtime, "pre-commit"), '. "$(dirname "$0")/h"');
    await writeHook(path.join(runtime, "commit-msg"), '. "$(dirname "$0")/h"');
    await writeFile(
      path.join(root, "pre-commit"),
      `printf ran > "${marker}"\n`,
      "utf8"
    );
    await symlink(runtime, path.join(root, ".hook-alias"));
    await git(root, ["config", "core.hooksPath", ".hook-alias"]);

    const snapshot = await new CommitHookService(root).inspect();
    assert.equal(snapshot.framework, "husky");
    assert.equal(snapshot.directory, root);
    assert.equal(snapshot.hooks[0]?.path, path.join(root, "pre-commit"));
    assert.equal(snapshot.hooks[0]?.state, "enabled");
    assert.deepEqual(
      await new CommitHookService(root).enabledEntrypoints(),
      ["pre-commit"]
    );
    await writeFile(path.join(root, "staged.txt"), "staged\n", "utf8");
    await git(root, ["add", "staged.txt"]);
    await git(root, ["commit", "-q", "-m", "exercise alias hook"]);
    assert.equal(await readFile(marker, "utf8"), "ran");
  });
});

test(".husky 디렉터리 자체가 symlink여도 v9 dispatcher를 인식한다", async (context) => {
  if (process.platform === "win32") {
    context.skip("symlink permission differs on Windows");
    return;
  }
  await withRepo(async (root) => {
    const store = `${root}-husky-store`;
    try {
      await mkdir(store);
      await writeHook(path.join(store, "_", "h"), "exit 0");
      await writeHook(path.join(store, "_", "pre-commit"), '. "$(dirname "$0")/h"');
      await writeFile(path.join(store, "pre-commit"), "echo shared user hook\n", "utf8");
      await symlink(store, path.join(root, ".husky"));
      await git(root, ["config", "core.hooksPath", ".husky/_"]);

      const snapshot = await new CommitHookService(root).inspect();
      assert.equal(snapshot.framework, "husky");
      assert.equal(snapshot.directory, path.join(root, ".husky"));
      assert.equal(snapshot.shared, true);
      assert.equal(snapshot.hooks[0]?.path, path.join(root, ".husky", "pre-commit"));
      assert.equal(snapshot.hooks[0]?.state, "enabled");
      assert.equal(snapshot.hooks[0]?.canToggle, false);
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });
});

test("dispatcher h가 없는 일반 .husky/_ 경로를 Husky v9으로 오인하지 않는다", async () => {
  await withRepo(async (root) => {
    await git(root, ["config", "core.hooksPath", ".husky/_"]);
    const wrapper = path.join(root, ".husky", "_", "pre-commit");
    await writeHook(wrapper);
    const snapshot = await new CommitHookService(root).inspect();
    assert.equal(snapshot.framework, undefined);
    assert.equal(snapshot.directory, path.join(root, ".husky", "_"));
    assert.equal(snapshot.hooks[0]?.path, wrapper);
  });
});

test("빈 hooksPath와 디렉터리가 아닌 hooksPath를 기본 .git/hooks로 오인하지 않는다", async (context) => {
  if (process.platform === "win32") {
    context.skip("/dev/null fixture is Unix-specific");
    return;
  }
  await withRepo(async (root) => {
    await git(root, ["config", "core.hooksPath", ""]);
    const empty = await new CommitHookService(root).inspect();
    assert.equal(empty.configuredPath, "");
    assert.equal(empty.directory, root);

    await git(root, ["config", "core.hooksPath", "/dev/null"]);
    const disabled = await new CommitHookService(root).inspect();
    assert.equal(disabled.directoryState, "notDirectory");
    assert.deepEqual(disabled.creatable, []);
  });
});

test("symlink hook 디렉터리를 따라가고 저장소 밖 실제 경로는 shared로 표시한다", async (context) => {
  if (process.platform === "win32") {
    context.skip("symlink permission differs on Windows");
    return;
  }
  await withRepo(async (root) => {
    const inside = path.join(root, ".actual-hooks");
    await mkdir(inside);
    await symlink(inside, path.join(root, ".hook-link"));
    await git(root, ["config", "core.hooksPath", ".hook-link"]);
    await writeHook(path.join(inside, "pre-commit"));
    const local = await new CommitHookService(root).inspect();
    assert.equal(local.directoryState, "ready");
    assert.equal(local.shared, false);

    const outside = `${root}-shared`;
    try {
      await mkdir(outside);
      await symlink(outside, path.join(root, ".outside-link"));
      await git(root, ["config", "core.hooksPath", ".outside-link/new/hooks"]);
      const shared = await new CommitHookService(root).inspect();
      assert.equal(shared.shared, true);
      assert.equal(shared.directoryState, "missing");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("main과 linked worktree가 공유하는 기본 hooks 경로를 양쪽에서 shared로 표시한다", async () => {
  await withRepo(async (root) => {
    await writeFile(path.join(root, "base.txt"), "base\n", "utf8");
    await git(root, ["add", "base.txt"]);
    await git(root, ["commit", "-q", "-m", "base"]);
    const linked = `${root}-linked`;
    try {
      await git(root, ["worktree", "add", "-q", "-b", "hook-test-linked", linked]);
      assert.equal((await new CommitHookService(root).inspect()).shared, true);
      assert.equal((await new CommitHookService(linked).inspect()).shared, true);
    } finally {
      await git(root, ["worktree", "remove", "--force", linked]).catch(
        () => ""
      );
      await rm(linked, { recursive: true, force: true });
    }
  });
});

test("실제 pre-commit 실패가 HEAD를 만들지 않고 파일 진단과 staged 변경을 보존한다", async () => {
  await withRepo(async (root) => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "console.log('x');\n", "utf8");
    await git(root, ["add", "src/a.ts"]);
    await writeHook(
      path.join(root, ".git", "hooks", "pre-commit"),
      "echo 'src/a.ts:1:1: error no-console' >&2\nexit 1"
    );

    let failure: unknown;
    try {
      await runGit(["commit", "-m", "test"], root);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure instanceof GitError, true);
    const report = buildCommitFailureReport(failure, root, {
      activeHooks: ["pre-commit"],
    });
    assert.equal(report.likelyHook, true);
    assert.equal(report.items[0]?.path, "src/a.ts");
    await assert.rejects(git(root, ["rev-parse", "--verify", "HEAD"]));
    assert.match(await git(root, ["diff", "--cached", "--name-only"]), /src\/a\.ts/);
  });
});
