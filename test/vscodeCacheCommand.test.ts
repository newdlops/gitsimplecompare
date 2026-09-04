import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { cleanupVscodeCache } from "../src/commands/cleanupVscodeCache";
import type { CommandDeps } from "../src/commands/shared";
import {
  __executedCommands,
  __informationMessages,
  __outputLines,
  __quickPickItems,
  __resetOutputLines,
  __resetWindowMessages,
  __setQuickPickResult,
  __setWarningMessageResult,
  __warningMessages,
} from "./helpers/vscodeMock";

/** 명령 테스트용 user-data-dir과 최소 CommandDeps를 실제 사용자 데이터 밖에 만든다. */
async function commandFixture(
  t: test.TestContext,
  scheme = "file"
): Promise<{
  userDataDir: string;
  cacheFile: string;
  settingsFile: string;
  deps: CommandDeps;
}> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "gsc-vscode-cache-command-"));
  const userDataDir = join(fixtureRoot, "Code-Test");
  const globalStoragePath = join(
    userDataDir,
    "User",
    "globalStorage",
    "newdlops.git-simple-compare"
  );
  const cacheFile = join(userDataDir, "Cache", "cached.bin");
  const settingsFile = join(userDataDir, "User", "settings.json");
  await Promise.all([
    mkdir(globalStoragePath, { recursive: true }),
    writeFixtureFile(cacheFile, "cache"),
    writeFixtureFile(settingsFile, "settings"),
  ]);
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  return {
    userDataDir,
    cacheFile,
    settingsFile,
    deps: {
      globalStorageUri: {
        scheme,
        fsPath: globalStoragePath,
      },
    } as unknown as CommandDeps,
  };
}

/** 부모 디렉터리를 포함해 작은 텍스트 fixture 파일을 만든다. */
async function writeFixtureFile(filePath: string, contents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

/** 데스크톱 vscode-userdata URI에서도 선택과 확인 뒤 지정 캐시만 정리하는지 검증한다. */
test("vscode-userdata 캐시 정리 명령은 선택 그룹만 삭제한다", async (t) => {
  const fixture = await commandFixture(t, "vscode-userdata");
  __resetWindowMessages();
  __resetOutputLines();
  __setQuickPickResult((items) =>
    items.filter(
      (item) => (item as { group?: { id?: string } }).group?.id === "workbench"
    )
  );
  __setWarningMessageResult("Clean Cache");

  await cleanupVscodeCache(fixture.deps);

  assert.equal(__quickPickItems.length, 1);
  assert.equal(
    (__quickPickItems[0]?.[0] as { description?: string }).description,
    "5 B · 1 item(s)"
  );
  assert.match(__warningMessages[0] ?? "", /Remove approximately 5 B/);
  assert.deepEqual(await readdir(join(fixture.userDataDir, "Cache")), []);
  assert.equal(await readFile(fixture.settingsFile, "utf8"), "settings");
  assert.equal(
    __informationMessages.some((message) =>
      message.includes("cache cleanup finished")
    ),
    true
  );
  assert.equal(
    __outputLines.some((line) => line.includes("VS Code cache cleanup completed")),
    true
  );
  assert.equal(
    __executedCommands.some(
      (command) => command.id === "workbench.action.reloadWindow"
    ),
    false
  );
});

/** 선택창을 닫은 취소 흐름에서는 확인이나 파일 삭제가 일어나지 않는지 검증한다. */
test("캐시 그룹 선택을 취소하면 파일을 그대로 둔다", async (t) => {
  const fixture = await commandFixture(t);
  __resetWindowMessages();
  __resetOutputLines();
  __setQuickPickResult(undefined);

  await cleanupVscodeCache(fixture.deps);

  assert.equal(await readFile(fixture.cacheFile, "utf8"), "cache");
  assert.equal(__warningMessages.length, 0);
  assert.equal(
    __outputLines.some((line) =>
      line.includes('"stage":"selection"')
    ),
    true
  );
});
