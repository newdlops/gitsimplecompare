import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

/** Changes History renderer를 DOM 없이 실행할 수 있는 최소 webview context를 만든다. */
function historyRenderer(historyExpanded: Record<string, boolean> = {}): (history: object) => string {
  const context = { window: {} as Record<string, unknown> };
  vm.runInNewContext(
    readFileSync(path.join(process.cwd(), "media/changes/changesHistory.js"), "utf8"),
    context
  );
  const factory = context.window.__gscChangesHistory as (options: object) => { historyBody(history: object): string };
  return factory({
    strings: { openHistoryCommit: "Open File Change", toggleSection: "Toggle section", noHistory: "No commits", noHistoryFile: "No file" },
    state: { historyExpanded },
    esc: (value: unknown) => String(value),
    fileIconHtml: (filePath: string) => `<icon>${filePath}</icon>`,
    statHtml: () => "",
    statusCodicon: () => "codicon-diff-modified",
    rootEl: null,
    vscode: { setState() {} },
    post() {},
  }).historyBody;
}

/** Changes commit controller를 DOM 없이 실행할 수 있는 최소 webview context를 만든다. */
function commitController(options: { aiHandled?: boolean } = {}): { sent: Array<Record<string, unknown>>; controller: { doCommit(operation: string): void; setCommitInProgress(active: boolean): void } } {
  const sent: Array<Record<string, unknown>> = [];
  const context = {
    window: { __gscTryAiCommitPlan: () => Boolean(options.aiHandled) } as Record<string, unknown>,
    document: { getElementById: () => null },
  };
  vm.runInNewContext(
    readFileSync(path.join(process.cwd(), "media/changes/changesCommitBox.js"), "utf8"),
    context
  );
  const factory = context.window.__gscChangesCommitBox as (options: object) => { doCommit(operation: string): void; setCommitInProgress(active: boolean): void };
  return {
    sent,
    controller: factory({
      vscode: { postMessage: (message: Record<string, unknown>) => sent.push(message) },
      getMenuApi: () => ({ closeDropdown() {}, isDropdownAnchor: () => false, openDropdown() {} }),
      getCommitMenuNodes: () => [],
    }),
  };
}

test("Changes History는 empty/error/expanded commit 상태를 서로 구분해 렌더링한다", () => {
  const render = historyRenderer({ abc123: true });

  assert.match(render({}), /No file/);
  assert.match(render({ path: "src/app.ts", message: "No history permission" }), /No history permission/);
  const html = render({
    path: "src/app.ts",
    repoRoot: "/repo",
    commits: [{ hash: "abc123", shortHash: "abc", title: "Update app", path: "src/app.ts", status: "M" }],
  });
  assert.match(html, /history-file-link/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /data-repo-root="\/repo"/);
});

test("Changes commit controller는 AI hook을 우선하고 진행 중 중복 commit을 막는다", () => {
  const planned = commitController({ aiHandled: true });
  planned.controller.doCommit("commit");
  assert.deepEqual(planned.sent, []);

  const standard = commitController();
  standard.controller.doCommit("commit");
  standard.controller.doCommit("commit");
  assert.equal(standard.sent.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(standard.sent[0])), { type: "commit", op: "commit", message: "" });

  standard.controller.setCommitInProgress(false);
  standard.controller.doCommit("amend");
  assert.deepEqual(JSON.parse(JSON.stringify(standard.sent[1])), { type: "commit", op: "amend", message: "" });
});
