import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadLocalOnlyBranchMap } from "../src/git/gitLocalOnlyBranches";
import { runGitWithInput } from "../src/git/gitExec";
import { gitProcesses } from "../src/git/gitProcessRegistry";

for (const mode of ["cancel", "native failure"]) {
  test(`target groups join real owned children after ${mode} and preserve the original error`, { skip: process.platform === "win32", timeout: 15000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "gsc-local-only-process-")), executable = path.join(root, "git-reader");
    await writeFile(executable, `#!${process.execPath}\nlet input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{if(${mode === "native failure"}&&input.includes('tip-a')){process.stderr.write('fixture failure');setTimeout(()=>process.exit(42),50)}else setInterval(()=>{},1000)});\n`, { mode: 0o755 });
    const owner = new AbortController(), pids: number[] = []; let enter!: () => void, calls = 0;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const register = gitProcesses.register.bind(gitProcesses);
    t.mock.method(gitProcesses, "register", (...args: Parameters<typeof register>) => {
      const id = register(...args); if (args[0].pid) pids.push(args[0].pid); if (pids.length === 2) enter(); return id;
    });
    t.after(async () => { owner.abort(); await gitProcesses.dispose(); await rm(root, { recursive: true, force: true }); });
    const pending = loadLocalOnlyBranchMap(root, ["a", "b"].map(name => ({ name, hash: `tip-${name}`, upstream: `origin/${name}`,
      ahead: 1, behind: 0, current: false, gone: false, dateIso: "", subject: "" })),
    ["a", "b"].map(name => ({ name: `origin/${name}`, hash: `base-${name}` })), owner.signal, (args, cwd, options) => {
      if (++calls === 1) return Promise.resolve("");
      return runGitWithInput(args, cwd, options?.input ?? "", { executable, signal: options?.signal, retryOnLock: false });
    });
    const outcome = assert.rejects(pending, (error: any) => mode === "cancel" ? error.code === "ABORT_ERR" : error.code === 42 && /fixture failure/.test(error.stderr));
    await entered; if (mode === "cancel") owner.abort(); await outcome;
    assert.equal(calls, 3); assert.equal(gitProcesses.isBusy(root), false);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}
