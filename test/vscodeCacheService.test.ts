import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";
import {
  deriveVscodeUserDataDir,
  VscodeCacheInspectionCancelledError,
  VscodeCacheLocationError,
  VscodeCacheService,
} from "../src/system/vscodeCacheService";

/** 테스트마다 실제 사용자 경로와 분리된 VS Code 저장 구조를 만든다. */
async function cacheFixture(t: test.TestContext): Promise<{
  fixtureRoot: string;
  userDataDir: string;
  globalStoragePath: string;
  service: VscodeCacheService;
}> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "gsc-vscode-cache-"));
  const userDataDir = join(fixtureRoot, "Code-Test");
  const globalStoragePath = join(
    userDataDir,
    "User",
    "globalStorage",
    "newdlops.git-simple-compare"
  );
  await mkdir(globalStoragePath, { recursive: true });
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  return {
    fixtureRoot,
    userDataDir,
    globalStoragePath,
    service: new VscodeCacheService(globalStoragePath),
  };
}

/** 정확한 바이트 수의 파일과 부모 디렉터리를 함께 만든다. */
async function writeSizedFile(filePath: string, bytes: number): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.alloc(bytes, 1));
}

/** 파일 또는 디렉터리가 남아 있는지 ENOENT만 정상 false로 바꿔 확인한다. */
async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** 표준 globalStorage 구조만 같은 VS Code user-data-dir로 역산한다. */
test("globalStorage 경로에서 안전한 VS Code user-data-dir만 계산한다", async (t) => {
  const fixture = await cacheFixture(t);
  assert.equal(
    deriveVscodeUserDataDir(fixture.globalStoragePath),
    fixture.userDataDir
  );
  assert.equal(
    deriveVscodeUserDataDir(
      join(fixture.userDataDir, "User", "workspaceStorage", "workspace")
    ),
    undefined
  );
  assert.equal(
    deriveVscodeUserDataDir(
      join(parse(fixture.userDataDir).root, "User", "globalStorage", "extension")
    ),
    undefined
  );
  assert.throws(
    () => new VscodeCacheService(join(fixture.fixtureRoot, "arbitrary")),
    VscodeCacheLocationError
  );
});

/** 허용 목록의 네 캐시 그룹만 측정하고 사용자 상태 파일은 크기에 포함하지 않는다. */
test("재생성 가능 캐시만 그룹별로 측정한다", async (t) => {
  const { userDataDir, service } = await cacheFixture(t);
  await Promise.all([
    writeSizedFile(join(userDataDir, "Cache", "http.bin"), 5),
    writeSizedFile(join(userDataDir, "CachedData", "commit", "code.bin"), 7),
    writeSizedFile(join(userDataDir, "Code Cache", "js.bin"), 11),
    writeSizedFile(
      join(userDataDir, "Service Worker", "ScriptCache", "script.bin"),
      13
    ),
    writeSizedFile(join(userDataDir, "CachedExtensionVSIXs", "ext.vsix"), 17),
    writeSizedFile(join(userDataDir, "User", "settings.json"), 101),
    writeSizedFile(
      join(userDataDir, "User", "workspaceStorage", "workspace", "state.vscdb"),
      103
    ),
    writeSizedFile(join(userDataDir, "Backups", "draft.txt"), 107),
  ]);

  const inspection = await service.inspect();
  const sizes = Object.fromEntries(
    inspection.groups.map((group) => [group.id, group.bytes])
  );
  assert.deepEqual(sizes, {
    workbench: 12,
    renderer: 11,
    webview: 13,
    extensions: 17,
  });
  assert.equal(inspection.issues.length, 0);
  assert.equal(
    inspection.groups.some((group) =>
      group.targets.some((target) => target.relativePath.includes("workspaceStorage"))
    ),
    false
  );
});

/** 선택한 그룹의 내용만 비우고 캐시 루트와 보호 대상 데이터는 그대로 둔다. */
test("선택한 캐시 내용만 정리하고 사용자 데이터와 미선택 캐시는 보존한다", async (t) => {
  const { userDataDir, service } = await cacheFixture(t);
  const cacheFile = join(userDataDir, "Cache", "http.bin");
  const webviewFile = join(
    userDataDir,
    "Service Worker",
    "ScriptCache",
    "script.bin"
  );
  const rendererFile = join(userDataDir, "Code Cache", "js.bin");
  const extensionFile = join(userDataDir, "CachedExtensionVSIXs", "ext.vsix");
  const settingsFile = join(userDataDir, "User", "settings.json");
  const workspaceState = join(
    userDataDir,
    "User",
    "workspaceStorage",
    "workspace",
    "state.vscdb"
  );
  await Promise.all([
    writeSizedFile(cacheFile, 5),
    writeSizedFile(webviewFile, 13),
    writeSizedFile(rendererFile, 11),
    writeSizedFile(extensionFile, 17),
    writeSizedFile(settingsFile, 19),
    writeSizedFile(workspaceState, 23),
  ]);

  const before = await service.inspect();
  const result = await service.cleanup(["workbench", "webview"], before);
  assert.equal(result.requestedBytes, 18);
  assert.equal(result.reclaimedBytes, 18);
  assert.equal(result.remainingBytes, 0);
  assert.equal(result.issues.length, 0);
  assert.deepEqual(await readdir(join(userDataDir, "Cache")), []);
  assert.deepEqual(
    await readdir(join(userDataDir, "Service Worker", "ScriptCache")),
    []
  );
  assert.equal(await exists(rendererFile), true);
  assert.equal(await exists(extensionFile), true);
  assert.equal((await readFile(settingsFile)).length, 19);
  assert.equal((await readFile(workspaceState)).length, 23);
});

/** 예상한 캐시 이름이 일반 파일이면 삭제하지 않고 안전 issue로 보고한다. */
test("디렉터리가 아닌 캐시 루트는 건너뛴다", async (t) => {
  const { userDataDir, service } = await cacheFixture(t);
  const unexpectedFile = join(userDataDir, "Cache");
  await writeSizedFile(unexpectedFile, 29);

  const inspection = await service.inspect();
  assert.equal(
    inspection.issues.some(
      (entry) => entry.relativePath === "Cache" && /not a directory/.test(entry.message)
    ),
    true
  );
  const result = await service.cleanup(["workbench"], inspection);
  assert.equal(await exists(unexpectedFile), true);
  assert.equal(result.issues.some((entry) => entry.stage === "cleanup"), true);
});

/** 캐시 루트 심볼릭 링크를 따라 외부 디렉터리를 읽거나 삭제하지 않는다. */
test(
  "캐시 루트 심볼릭 링크는 외부 대상을 보존한다",
  { skip: process.platform === "win32" },
  async (t) => {
    const { fixtureRoot, userDataDir, service } = await cacheFixture(t);
    const outside = join(fixtureRoot, "outside");
    const sentinel = join(outside, "sentinel.txt");
    await writeSizedFile(sentinel, 31);
    await symlink(outside, join(userDataDir, "Cache"), "dir");

    const inspection = await service.inspect();
    assert.equal(
      inspection.issues.some(
        (entry) => entry.relativePath === "Cache" && /symbolic link/.test(entry.message)
      ),
      true
    );
    const result = await service.cleanup(["workbench"], inspection);
    assert.equal(result.issues.some((entry) => /symbolic link/.test(entry.message)), true);
    assert.equal((await readFile(sentinel)).length, 31);
  }
);

/** 캐시 내부 심볼릭 링크는 링크만 제거하고 외부 파일은 따라가서 지우지 않는다. */
test(
  "캐시 내부 디렉터리 심볼릭 링크 정리는 외부 파일을 삭제하지 않는다",
  { skip: process.platform === "win32" },
  async (t) => {
    const { fixtureRoot, userDataDir, service } = await cacheFixture(t);
    const outsideDirectory = join(fixtureRoot, "outside-directory");
    const outsideFile = join(outsideDirectory, "outside.txt");
    const cacheDirectory = join(userDataDir, "Cache");
    const cacheLink = join(cacheDirectory, "outside-link");
    await writeSizedFile(outsideFile, 37);
    await mkdir(cacheDirectory, { recursive: true });
    await symlink(outsideDirectory, cacheLink, "dir");

    const before = await service.inspect();
    const result = await service.cleanup(["workbench"], before);
    assert.equal(result.issues.length, 0);
    assert.equal(await exists(cacheLink), false);
    assert.equal((await readFile(outsideFile)).length, 37);
  }
);

/** 진행 알림의 취소 신호가 들어오면 긴 재귀 탐색을 전용 오류로 즉시 끝낸다. */
test("캐시 검사는 취소 신호를 구분 가능한 오류로 전달한다", async (t) => {
  const { service } = await cacheFixture(t);
  await assert.rejects(
    service.inspect(() => true),
    VscodeCacheInspectionCancelledError
  );
});
