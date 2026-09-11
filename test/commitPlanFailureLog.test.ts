import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommitPlanFailureLog } from "../src/webview/commitPlanFailureLog";
import { CommitPlanPanel } from "../src/webview/commitPlanPanel";
import { parseCommitPlanFromWebview } from "../src/webview/commitPlanProtocol";
import { presentCommitPlanExecutionFailure } from "../src/webview/commitPlanExecutionPresentation";
import { buildCommitFailureReport, commitFailureOutput } from "../src/git/commitHookFailure";
import { AiCommitPlanService } from "../src/git/aiCommitPlanService";
import { readAiCommitPlanContext } from "../src/git/aiCommitPlanContext";
import { runGit } from "../src/git/gitExec";
import * as vscodeMock from "./helpers/vscodeMock";

test("로그 표시에서는 제어 문자만 제거하고 전체 복사는 stdout·stderr 원문을 보존한다", async () => {
  vscodeMock.__resetWindowMessages();
  const raw = "\u001b[31mfailed\u001b[0m\r\n  detail\n\n<script>throw 1</script>\n";
  const logs = new CommitPlanFailureLog();
  const preview = logs.capture(raw);
  assert.equal(preview.text, "failed\n  detail\n\n<script>throw 1</script>\n");
  assert.equal(preview.truncated, false);
  assert.equal((await logs.copy(preview.id)).success, true);
  assert.deepEqual(vscodeMock.__clipboardWrites, [raw]);
});

test("긴 로그의 앞뒤 미리보기를 제한해도 복사에는 중간 내용까지 모두 포함한다", async () => {
  vscodeMock.__resetWindowMessages();
  const logs = new CommitPlanFailureLog();
  const raw = "START\n" + "😀검사 출력\n".repeat(30_000) + "\nFINAL FAILURE";
  const preview = logs.capture(raw);
  assert(preview.text.startsWith("START"));
  assert(preview.text.endsWith("FINAL FAILURE"));
  assert(preview.text.length <= 128_000);
  assert(preview.truncated);
  assert.equal(Buffer.from(preview.text).toString(), preview.text);
  await logs.copy(preview.id);
  assert.equal(vscodeMock.__clipboardWrites[0], raw);
});

test("이전 실행·다른 패널·해제된 로그 ID와 빈 로그는 클립보드를 바꾸지 않는다", async () => {
  vscodeMock.__resetWindowMessages();
  const logs = new CommitPlanFailureLog();
  const old = logs.capture("old failure");
  const current = logs.capture("current failure");
  const other = new CommitPlanFailureLog().capture("another repository");
  for (const id of [old.id, other.id, "unknown"]) assert.equal((await logs.copy(id)).success, false);
  logs.clear();
  assert.equal((await logs.copy(current.id)).success, false);
  const empty = logs.capture("\n  \n");
  assert.equal(empty.canCopy, false);
  assert.equal((await logs.copy(empty.id)).success, false);
  assert.deepEqual(vscodeMock.__clipboardWrites, []);
});

test("클립보드 실패는 원문을 유지하고 다음 복사 요청에서 다시 시도할 수 있다", async (t) => {
  vscodeMock.__resetWindowMessages();
  const logs = new CommitPlanFailureLog();
  const preview = logs.capture("kept failure output");
  const write = t.mock.method(vscodeMock.env.clipboard, "writeText", async () => { throw new Error("clipboard offline"); });
  const failed = await logs.copy(preview.id);
  assert.equal(failed.success, false);
  assert.match(failed.message, /Could not copy/);
  write.mock.restore();
  assert.equal((await logs.copy(preview.id)).success, true);
  assert.deepEqual(vscodeMock.__clipboardWrites, ["kept failure output"]);
});

test("복사 protocol은 ID만 허용하고 웹뷰가 보낸 로그 본문과 잘못된 ID를 거부한다", () => {
  const id = new CommitPlanFailureLog().capture("trusted").id;
  assert.deepEqual(parseCommitPlanFromWebview({ type: "copyFailureLog", failureId: id, output: "forged" }),
    { type: "copyFailureLog", failureId: id });
  for (const failureId of [undefined, 1, {}, "", "x".repeat(1000)]) {
    assert.equal(parseCommitPlanFromWebview({ type: "copyFailureLog", failureId }), undefined);
  }
});

/**
 * VS Code 창 생성 대신 실제 패널 prototype에 메시지·클립보드 경계만 주입한다.
 * @param context 실행할 Git 컨텍스트 @param execute 실제 Git 또는 실패를 만드는 실행 콜백
 * @returns 실제 라우터·실행·오류·세션 메서드를 호출할 패널과 관찰 메시지
 */
function panelFixture(context: any, execute: (...args: any[]) => Promise<unknown>) {
  const posted: any[] = [];
  const panel: any = Object.assign(Object.create(CommitPlanPanel.prototype), {
    context, sessionRevision: 0, disposed: false, webviewReady: true, disposables: [],
    failureLog: new CommitPlanFailureLog(), prompt: "", pendingAutoGenerate: false,
    panel: { webview: { postMessage: (value: unknown) => { posted.push(value); return Promise.resolve(true); } } },
    actions: {
      execute, reportError: async () => {}, formatError: (error: Error) => error.message,
      executionFailureOutput: commitFailureOutput,
      formatExecutionFailure: (error: unknown) => presentCommitPlanExecutionFailure(buildCommitFailureReport(error, context.repoRoot)),
    },
  });
  return { panel, posted };
}

test("실제 두 번째 커밋 hook 실패의 출력만 패널에 전달하고 전체 복사하며 실제 HEAD·index를 보존한다", async (t) => {
  if (process.platform === "win32") { t.skip("실행형 shell hook 검사"); return; }
  vscodeMock.__resetWindowMessages();
  vscodeMock.__setWarningMessageResult("Create Planned Commits");
  const root = await mkdtemp(join(tmpdir(), "gsc-plan-failure-log-"));
  const git = (args: string[]) => runGit(args, root, { env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  try {
    await git(["init", "--quiet"]);
    await git(["config", "user.name", "Commit Log Test"]);
    await git(["config", "user.email", "commit-log@example.test"]);
    await git(["config", "commit.gpgsign", "false"]);
    await writeFile(join(root, "first.txt"), "base first\n");
    await writeFile(join(root, "second.txt"), "base second\n");
    await git(["add", "-A"]);
    await git(["commit", "-m", "base"]);
    await writeFile(join(root, "first.txt"), "changed first\n");
    await writeFile(join(root, "second.txt"), "changed second\n");
    await git(["add", "-A"]);
    const originalHead = await git(["rev-parse", "HEAD"]);
    const originalIndex = await git(["write-tree"]);
    const hook = join(root, ".git", "hooks", "pre-commit");
    await writeFile(hook, '#!/bin/sh\nif test "$(git log -1 --pretty=%s)" = "feat: first"; then\n  printf "second commit stdout\\n"\n  printf "second commit stderr\\n" >&2\n  exit 1\nfi\nprintf "first commit passed\\n"\n');
    await chmod(hook, 0o755);
    const context = await readAiCommitPlanContext(root, "staged");
    const plan = { groups: [{ message: "feat: first", paths: ["first.txt"] }, { message: "feat: second", paths: ["second.txt"] }], warnings: [] };
    const { panel, posted } = panelFixture(context, (ctx, result, progress) => new AiCommitPlanService(root).execute(ctx, result, progress));
    await panel.receiveMessage({ type: "execute", result: plan });
    const failure = posted.find(message => message.type === "error" && message.operation === "execute");
    assert(failure?.log);
    assert.match(failure.log.text, /second commit stdout/);
    assert.match(failure.log.text, /second commit stderr/);
    assert.doesNotMatch(failure.log.text, /first commit passed/);
    const progress = posted.filter(message => message.type === "executionProgress").at(-1).progress;
    assert.equal(progress.current, 1);
    assert.equal(progress.step, "started");
    await panel.receiveMessage({ type: "copyFailureLog", failureId: failure.log.id, output: "forged output" });
    assert.equal(posted.at(-1).type, "failureLogCopied");
    assert.equal(posted.at(-1).success, true);
    assert.equal(vscodeMock.__clipboardWrites[0], failure.log.text);
    assert.equal(await git(["rev-parse", "HEAD"]), originalHead);
    assert.equal(await git(["write-tree"]), originalIndex);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("실행 취소는 현재 로그를 유지하고 승인된 재실행·세션 교체·패널 종료는 이전 로그를 무효화한다", async () => {
  vscodeMock.__resetWindowMessages();
  const context = { repoRoot: "/fixture", files: [{ path: "one.txt" }], scope: "staged" };
  const plan = { groups: [{ message: "fix: one", paths: ["one.txt"] }], warnings: [] };
  let attempt = 0;
  const { panel, posted } = panelFixture(context, async () => { throw new Error(`attempt ${++attempt}`); });
  vscodeMock.__setWarningMessageResult("Create Planned Commits");
  await panel.receiveMessage({ type: "execute", result: plan });
  const first = posted.find(message => message.log)?.log;
  vscodeMock.__setWarningMessageResult(undefined);
  await panel.receiveMessage({ type: "execute", result: plan });
  await panel.receiveMessage({ type: "copyFailureLog", failureId: first.id });
  assert.equal(posted.at(-1).success, true);
  vscodeMock.__setWarningMessageResult("Create Planned Commits");
  await panel.receiveMessage({ type: "execute", result: plan });
  const second = posted.filter(message => message.log).at(-1).log;
  await panel.receiveMessage({ type: "copyFailureLog", failureId: first.id });
  assert.equal(posted.at(-1).success, false);
  await panel.receiveMessage({ type: "copyFailureLog", failureId: second.id });
  assert.equal(posted.at(-1).success, true);
  panel.replaceSession(context, panel.actions, { prompt: "", autoGenerate: false });
  await panel.receiveMessage({ type: "copyFailureLog", failureId: second.id });
  assert.equal(posted.at(-1).success, false);
  await panel.receiveMessage({ type: "execute", result: plan });
  const third = posted.filter(message => message.log).at(-1).log;
  panel.dispose();
  assert.equal((await panel.failureLog.copy(third.id)).success, false);
  assert.deepEqual(vscodeMock.__clipboardWrites, ["attempt 1", "attempt 2"]);
});
