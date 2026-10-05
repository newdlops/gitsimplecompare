import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { readProcessIdentities } from "../src/git/processIdentity";

/**
 * 독립 프로세스 그룹의 부모·자식을 만들고 테스트 종료 때 해당 그룹만 회수한다.
 * @param t 자식이 남지 않도록 종료 후 정리 함수를 등록할 테스트 컨텍스트
 * @returns 실제 그룹 리더와 조회 결과를 검증할 부모·자식 PID 목록
 */
async function groupFixture(t: TestContext): Promise<{ leader: ChildProcess; pids: number[] }> {
  const leader = spawn(process.execPath, ["-e", `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
    child.once('spawn', () => process.stdout.write(JSON.stringify([process.pid, child.pid])));
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (leader.exitCode !== null || leader.signalCode !== null || !leader.pid) return;
    const closed = once(leader, "close");
    process.kill(-leader.pid, "SIGTERM");
    await closed;
  });
  const [data] = await once(leader.stdout!, "data", { signal: AbortSignal.timeout(10000) });
  return { leader, pids: JSON.parse(data.toString()) };
}

test("process group inspection includes detached descendants and excludes unrelated processes", { skip: process.platform === "win32" }, async t => {
  const fixture = await groupFixture(t);
  const rows = await readProcessIdentities({ processGroup: fixture.leader.pid! });
  assert.deepEqual(rows.map(row => row.pid).sort(), fixture.pids.sort());
  for (const row of rows) assert.equal(row.pgid, fixture.leader.pid);
});

test("PID and group selectors form a union without dropping known group members", { skip: process.platform === "win32" }, async t => {
  const fixture = await groupFixture(t);
  const rows = await readProcessIdentities({ pids: [process.pid], processGroup: fixture.leader.pid! });
  assert.deepEqual(rows.map(row => row.pid).sort(), [...fixture.pids, process.pid].sort());
});

test("known PID inspection retains the full identity fields used to reject PID reuse", { skip: process.platform === "win32" }, async () => {
  const rows = await readProcessIdentities({ pids: [process.pid, process.pid] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, process.pid);
  assert.equal(rows[0].uid, process.getuid?.());
  assert.ok(rows[0].started);
  assert.ok(rows[0].executable);
  assert.ok(Number.isInteger(rows[0].pgid));
});

test("an empty selection cannot accidentally inspect every process", { skip: process.platform === "win32" }, async () => {
  assert.deepEqual(await readProcessIdentities({ pids: [] }), []);
});

test("invalid selectors are rejected before running an OS command", { skip: process.platform === "win32" }, async () => {
  for (const selection of [{ pids: [-1] }, { pids: [1.5] }, { processGroup: 0 }]) {
    await assert.rejects(readProcessIdentities(selection), /Invalid process ownership selection/);
  }
});

test("a fully exited selection returns no identities", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const closed = once(child, "close");
  await once(child, "spawn");
  const pid = child.pid!;
  await closed;
  assert.deepEqual(await readProcessIdentities({ pids: [pid] }), []);
});

test("OS inspection failures are propagated instead of becoming an empty selection", { skip: process.platform !== "darwin" }, async () => {
  await assert.rejects(readProcessIdentities({ pids: [2147483000] }), /process id too large/);
});
