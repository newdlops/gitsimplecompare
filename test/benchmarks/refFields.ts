// Graph의 for-each-ref 대기를 출력 필드별로 나누는 Native 진단이다. 모든 ref는 소유 fixture에만 만든다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitOperationFixture } from "../helpers/gitOperationFixture";
import { runGit } from "../../src/git/gitExec";
import { gitProcesses } from "../../src/git/gitProcessRegistry";

const FS = "\x1f";
const formats = {
  "full-ref-and-oid": { format: ["%(refname)", "%(objectname)"].join(FS), heads: false },
  "snapshot-with-short": { format: ["%(refname)", "%(objectname)", "%(refname:short)"].join(FS), heads: false },
  "rich-local": { format: ["%(HEAD)", "%(refname:short)", "%(objectname)", "%(upstream:short)", "%(upstream:track)",
    "%(committerdate:iso8601-strict)", "%(subject)"].join(FS), heads: true },
  "rich-local-without-track": { format: ["%(HEAD)", "%(refname:short)", "%(objectname)", "%(upstream:short)", "",
    "%(committerdate:iso8601-strict)", "%(subject)"].join(FS), heads: true },
};

/** 임시 root 하나를 만들고 필드 조합의 순서를 뒤집어 반복한다. 결과의 안정성과 전체 ref 보존도 확인한다. */
async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-ref-fields-"));
  try {
    const f = await createGitOperationFixture(directory), samples = [], signatures = new Map<string, string>();
    const refs = await runGit(["for-each-ref", "--format=%(refname) %(objectname)"], f.root);
    for (let round = 0; round < 3; round++) {
      const order = Object.keys(formats) as (keyof typeof formats)[];
      for (const key of [...order, ...order.reverse()]) {
        const spec = formats[key], args = ["for-each-ref", ...(spec.heads ? ["--sort=-committerdate"] : []),
          `--format=${spec.format}`, ...(spec.heads ? ["refs/heads"] : [])];
        console.error(`Reading ${key} round ${round}...`);
        const start = performance.now(), out = await runGit(args, f.root), elapsedMs = performance.now() - start;
        const sha256 = createHash("sha256").update(out).digest("hex");
        if (signatures.has(key)) assert.equal(sha256, signatures.get(key)); else signatures.set(key, sha256);
        samples.push({ key, round, elapsedMs, rows: out.split("\n").filter(Boolean).length, sha256 });
      }
    }
    assert.equal(await runGit(["for-each-ref", "--format=%(refname) %(objectname)"], f.root), refs);
    const report = { source: JSON.parse(process.env.GSC_BENCH_SOURCE!), formats, samples,
      fixture: { files: f.files, commits: f.depth, branches: f.branches, sharedUpstreamBranches: f.sharedUpstreamBranches },
      refsUnchanged: true, scope: "Owned synthetic Native repository only. Field-cost diagnosis through the same runGit boundary, six correlated reads/format on one fixture, alternating order. No product change, CPU/memory, button or Graph latency claim." };
    await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2));
  } finally { await gitProcesses.dispose(); await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
