import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** 캐시 정리 명령이 팔레트와 최상위 뷰 액션에서 번역 가능한 제목으로 노출되는지 검증한다. */
test("VS Code 캐시 정리 명령 contribution과 최상위 뷰 제목 액션을 제공한다", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const commands = manifest.contributes.commands.filter(
    (command: { command: string }) =>
      command.command === "gitSimpleCompare.cleanupVscodeCache"
  );
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], {
    command: "gitSimpleCompare.cleanupVscodeCache",
    title: "%cmd.cleanupVscodeCache.tooltip%",
    shortTitle: "%cmd.cleanupVscodeCache%",
    category: "Git Simple Compare",
    icon: "$(clear-all)",
  });

  const menuItems = manifest.contributes.menus["view/title"].filter(
    (item: { command: string }) =>
      item.command === "gitSimpleCompare.cleanupVscodeCache"
  );
  assert.deepEqual(menuItems, [
    {
      command: "gitSimpleCompare.cleanupVscodeCache",
      when: "view == gitSimpleCompare.changes",
      group: "navigation@5",
    },
  ]);

  for (const file of ["package.nls.json", "package.nls.ko.json"]) {
    const messages = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(typeof messages["cmd.cleanupVscodeCache"], "string");
    assert.equal(typeof messages["cmd.cleanupVscodeCache.tooltip"], "string");
    assert.notEqual(messages["cmd.cleanupVscodeCache"].trim(), "");
    assert.notEqual(messages["cmd.cleanupVscodeCache.tooltip"].trim(), "");
  }
});

/** 서비스 허용 목록에 사용자 상태 경로가 실수로 추가되지 않도록 정적 안전 경계를 고정한다. */
test("캐시 서비스는 사용자 상태·백업 경로를 삭제 대상으로 선언하지 않는다", () => {
  const source = readFileSync(
    "src/system/vscodeCacheService.ts",
    "utf8"
  );
  for (const protectedPath of [
    "workspaceStorage",
    "globalStorage",
    "Backups",
    "Local Storage",
    "Session Storage",
  ]) {
    const definitions = source.slice(
      source.indexOf("const CACHE_GROUP_DEFINITIONS"),
      source.indexOf("export type CacheCancellationProbe")
    );
    assert.equal(
      definitions.includes(`\"${protectedPath}\"`),
      false,
      `${protectedPath} must not be a cache cleanup target`
    );
  }
});

/** 캐시 정리 UI에서 쓰는 모든 정적 런타임 문자열에 한국어 번역이 있는지 검증한다. */
test("캐시 정리 런타임 메시지는 한국어 bundle에 모두 등록된다", () => {
  const source = readFileSync(
    "src/commands/cleanupVscodeCache.ts",
    "utf8"
  );
  const korean = JSON.parse(
    readFileSync("l10n/bundle.l10n.ko.json", "utf8")
  );
  const messagePattern = /vscode\.l10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g;
  const messages = [...source.matchAll(messagePattern)].map((match) =>
    JSON.parse(`"${match[1]}"`)
  );
  assert.ok(messages.length > 20, "cache cleanup should expose its full UI copy");
  for (const message of messages) {
    assert.equal(
      typeof korean[message],
      "string",
      `Missing Korean runtime translation: ${message}`
    );
  }
});
