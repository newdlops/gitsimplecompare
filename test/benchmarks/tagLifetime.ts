// 실제 자식 프로세스의 취소 전후 수명을 동일한 Git 실행 경계에서 관측한다.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { setGitExecutableResolver } from "../../src/git/gitExec";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { sendGraphTagStatus } from "../../src/webview/graphTagStatus";

/** fixture가 직접 기록한 PID만 관측한다. 임의의 사용자 프로세스를 검색하거나 종료하지 않는다. */
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

/** 실제 소유 실행기에서 local/remote 태그 읽기의 취소를 관측하고 모든 fixture 자식을 정리한다. */
async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-tag-lifetime-")), executable = path.join(root, "git-fixture");
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');
const command=process.argv[2];if(command==='remote'){console.log('origin');process.exit(0)}
process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100));
fs.writeFileSync(path.join(process.cwd(),command+'.pid'),String(process.pid));setInterval(()=>{},1000);\n`, { mode: 0o755 });
  const restore = setGitExecutableResolver(() => executable), controller = new AbortController();
  let mutationNotifications = 0;
  const unobserveWrites = gitProcesses.onDidFinishWrite(changed => { if (changed === root) mutationNotifications++; });
  let pending: Promise<void> | undefined, settled = false, publicationsAfterAbort = 0;
  try {
    pending = sendGraphTagStatus(root, () => { if (controller.signal.aborted) publicationsAfterAbort++; }, { signal: controller.signal })
      .finally(() => { settled = true; });
    const pids: number[] = [], deadline = Date.now() + 10000;
    for (const command of ["for-each-ref", "ls-remote"]) {
      while (true) {
        try { pids.push(Number(await readFile(path.join(root, `${command}.pid`), "utf8"))); break; }
        catch { if (Date.now() >= deadline) throw new Error("Owned tag child did not start"); await new Promise(resolve => setTimeout(resolve, 20)); }
      }
    }
    assert.equal(pids.length, 2); assert.ok(pids.every(alive));
    const started = Date.now(); controller.abort();
    while (!settled && Date.now() - started < 1000) await new Promise(resolve => setTimeout(resolve, 10));
    const observed = { startedChildren: pids.length, childrenAfterAbortObservation: pids.filter(alive).length,
      observationMs: Date.now() - started, querySettled: settled, registryBusy: gitProcesses.isBusy(root) };
    await gitProcesses.dispose(); await pending;
    assert.ok(pids.every(pid => !alive(pid)));
    const result = { source: JSON.parse(process.env.GSC_BENCH_SOURCE || "null"),
      scope: "Git runner with actual local fixture children; no real network or user repository. One-second maximum abort observation, 100ms fixture close handler; not a latency benchmark.",
      ...observed, mutationNotifications, publicationsAfterAbort, childrenAfterCleanup: 0 };
    if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } finally { controller.abort(); await gitProcesses.dispose(); await pending; unobserveWrites(); restore(); await rm(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
