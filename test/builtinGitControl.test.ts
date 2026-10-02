import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as vscode from "vscode";
import { toggleBuiltinGit } from "../src/commands/viewState";
import { VscodeGitStatusProvider } from "../src/providers/vscodeGitStatusProvider";
import {
  __errorMessages,
  __executedCommands,
  __informationMessages,
  __outputLines,
  __resetOutputLines,
  __resetWindowMessages,
} from "./helpers/vscodeMock";

/**
 * 설정 변경을 메모리로 격리하고 테스트 종료 시 VS Code 대역을 원래 상태로 복원한다.
 * @param context 설정 대역의 정리 콜백을 등록할 테스트 컨텍스트
 * @returns 내장 Git 상태, 저장 기록 및 실패·지연을 주입할 수 있는 테스트 상태
 */
function configurationFixture(context: TestContext) {
  const workspace = vscode.workspace as unknown as {
    workspaceFolders?: unknown[];
    getConfiguration: (...args: unknown[]) => unknown;
  };
  const originalFolders = workspace.workspaceFolders;
  const originalConfiguration = workspace.getConfiguration;
  const fixture = {
    enabled: true,
    folderOverride: undefined as boolean | undefined,
    writes: [] as Array<{ key: string; value: unknown; target: unknown }>,
    beforeWrite: async (): Promise<void> => {},
  };
  workspace.workspaceFolders = [{ uri: vscode.Uri.file("/repo"), name: "repo", index: 0 }];
  workspace.getConfiguration = (_section, resource) => ({
    get: (key: string, fallback: unknown) => key === "enabled"
      ? (resource ? fixture.folderOverride ?? fixture.enabled : fixture.enabled)
      : fallback,
    inspect: () => ({ workspaceFolderValue: resource ? fixture.folderOverride : undefined }),
    update: async (key: string, value: boolean, target: unknown) => {
      fixture.writes.push({ key, value, target });
      await fixture.beforeWrite();
      if (target === vscode.ConfigurationTarget.WorkspaceFolder) fixture.folderOverride = value;
      else fixture.enabled = value;
    },
  });
  __resetWindowMessages();
  __resetOutputLines();
  context.after(() => {
    workspace.workspaceFolders = originalFolders;
    workspace.getConfiguration = originalConfiguration;
    __resetWindowMessages();
    __resetOutputLines();
  });
  return fixture;
}

/** 워크스페이스 설정만 반전하며 다른 사용자 설정을 저장하지 않는지 검증한다. */
test("내장 Git 중단·재개는 현재 워크스페이스 git.enabled만 변경한다", async (context) => {
  const fixture = configurationFixture(context);
  await toggleBuiltinGit();
  assert.equal(fixture.enabled, false);
  await toggleBuiltinGit();
  assert.equal(fixture.enabled, true);
  assert.deepEqual(fixture.writes, [
    { key: "enabled", value: false, target: vscode.ConfigurationTarget.Workspace },
    { key: "enabled", value: true, target: vscode.ConfigurationTarget.Workspace },
  ]);
  assert.match(__informationMessages[0], /stopped/);
  assert.match(__informationMessages[1], /started/);
  assert.ok(__outputLines.some((line) => line.includes('"enabled":false')));
  assert.ok(__outputLines.some((line) => line.includes('"enabled":true')));
});

/** 워크스페이스 중단 설정을 덮어쓰는 폴더별 true도 실제로 중단하고 재개하는지 검증한다. */
test("폴더 override가 켜져 있어도 워크스페이스 전체의 내장 Git을 중단한다", async (context) => {
  const fixture = configurationFixture(context);
  fixture.enabled = false;
  fixture.folderOverride = true;
  await toggleBuiltinGit();
  assert.equal(fixture.enabled, false);
  assert.equal(fixture.folderOverride, false);
  await toggleBuiltinGit();
  assert.equal(fixture.enabled, true);
  assert.equal(fixture.folderOverride, true);
  assert.deepEqual(fixture.writes.map((write) => write.target), [
    vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.WorkspaceFolder,
    vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.WorkspaceFolder,
  ]);
});

/** 저장 중 추가 호출이 상태를 다시 뒤집거나 설정 쓰기를 중복하지 않는지 검증한다. */
test("설정 저장 중 중복 토글은 무시하고 메뉴 busy 상태를 해제한다", async (context) => {
  const fixture = configurationFixture(context);
  let finishWrite!: () => void;
  fixture.beforeWrite = () => new Promise<void>((resolve) => { finishWrite = resolve; });
  const first = toggleBuiltinGit();
  await toggleBuiltinGit();
  assert.equal(fixture.writes.length, 1);
  finishWrite();
  await first;
  assert.equal(fixture.enabled, false);
  assert.deepEqual(__executedCommands.filter((command) => command.args[0] === "gitSimpleCompare.builtinGit.busy")
    .map((command) => command.args), [
    ["gitSimpleCompare.builtinGit.busy", true],
    ["gitSimpleCompare.builtinGit.busy", false],
  ]);
});

/** 저장 실패를 성공으로 알리지 않으며 실패 뒤 재시도가 가능한지 검증한다. */
test("설정 저장 실패는 OUTPUT·오류 알림으로 남기고 다음 토글을 허용한다", async (context) => {
  const fixture = configurationFixture(context);
  fixture.beforeWrite = async () => { throw new Error("settings are read-only"); };
  await toggleBuiltinGit();
  assert.equal(fixture.enabled, true);
  assert.equal(__informationMessages.length, 0);
  assert.equal(__errorMessages.length, 1);
  assert.ok(__outputLines.some((line) => line.includes("settings are read-only")));
  fixture.beforeWrite = async () => {};
  await toggleBuiltinGit();
  assert.equal(fixture.enabled, false);
});

/** 폴더가 없는 창에서 사용자의 전역 Git 설정으로 폴백하지 않는지 검증한다. */
test("워크스페이스 없는 창에서는 전역 설정을 건드리지 않는다", async (context) => {
  const fixture = configurationFixture(context);
  Object.assign(vscode.workspace, { workspaceFolders: undefined });
  await toggleBuiltinGit();
  assert.equal(fixture.writes.length, 0);
  assert.match(__informationMessages[0], /Open a folder or workspace/);
});

/**
 * 중단 직후 내장 Git API에 저장소가 남아 있어도 오래된 상태를 사용하지 않는지 검증한다.
 * - 설정이 꺼진 채 최초 조회할 때 강제 활성화하지 않는 경로도 함께 확인한다.
 */
test("중단된 내장 Git은 강제 활성화하거나 기존 API snapshot을 재사용하지 않는다", async (context) => {
  const fixture = configurationFixture(context);
  const extensions = vscode.extensions as unknown as { getExtension: (id: string) => unknown };
  const originalExtension = extensions.getExtension;
  const event = () => ({ dispose() {} });
  let extensionReads = 0;
  let apiReady = true;
  extensions.getExtension = () => {
    extensionReads++;
    return {
      isActive: true,
      exports: {
        onDidChangeEnablement: event,
        getAPI: () => {
          if (!apiReady) throw new Error("Git model not found");
          return {
          repositories: [{
            rootUri: vscode.Uri.file("/repo"),
            state: {
              HEAD: { name: "main", commit: "head" },
              indexChanges: [], workingTreeChanges: [], untrackedChanges: [], mergeChanges: [],
              onDidChange: event,
            },
          }],
          onDidOpenRepository: event,
          onDidCloseRepository: event,
          };
        },
      },
    };
  };
  const provider = new VscodeGitStatusProvider(() => {});
  context.after(() => { provider.dispose(); extensions.getExtension = originalExtension; });

  fixture.enabled = false;
  assert.equal(await provider.ensureReady(), false);
  assert.equal(await provider.getRepositories(), undefined);
  assert.equal(await provider.getStatusGroups("/repo"), undefined);
  assert.equal(extensionReads, 0);

  fixture.enabled = true;
  apiReady = false;
  assert.equal(await provider.ensureReady(), false);
  apiReady = true;
  assert.equal(await provider.ensureReady(), true);
  assert.deepEqual(await provider.getRepositories(), [{ root: "/repo", branch: "main" }]);
  assert.deepEqual(await provider.getStatusGroups("/repo"), { staged: [], unstaged: [] });
  assert.equal(provider.getStatusRevision("/repo"), 0);

  fixture.enabled = false;
  assert.equal(await provider.ensureReady(), false);
  assert.equal(await provider.getRepositories(), undefined);
  assert.equal(await provider.getStatusGroups("/repo"), undefined);
  assert.equal(provider.getStatusRevision("/repo"), undefined);

  fixture.enabled = true;
  fixture.folderOverride = false;
  assert.equal(await provider.getStatusGroups("/repo"), undefined);
  assert.equal(await provider.getRepositories(), undefined);
  fixture.folderOverride = true;
  assert.deepEqual(await provider.getStatusGroups("/repo"), { staged: [], unstaged: [] });
});
