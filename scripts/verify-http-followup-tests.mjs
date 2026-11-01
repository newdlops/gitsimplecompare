// renderer를 포함한 모든 unit 파일을 누락/중복 없는 두 순차 그룹으로 검증한다. 기존 15분/3-worker 한계는 보존한다.
import { readdir, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd(), output = process.env.GSC_FOLLOWUP_VERIFY_DIR || "/private/tmp/gsc-http-followup-verification";
const excluded = new Set(["webview", "a11y", "extension", "visual"]);
/** 기존 runner와 동일한 unit discovery 조건을 적용한다. */
async function discover(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && !excluded.has(entry.name)) files.push(...await discover(file));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path.relative(root, file));
  }
  return files.sort();
}
const files = await discover(path.join(root, "test")), groups = [files.slice(0, Math.ceil(files.length / 2)), files.slice(Math.ceil(files.length / 2))];
if (new Set(groups.flat()).size !== files.length || groups.flat().length !== files.length) throw Error("Incomplete or overlapping full-suite partition");
await mkdir(output, { recursive: true });
const record = { sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), node: process.version,
  rendererVerification: true, concurrency: 3, timeoutMsPerGroup: 900000, allFiles: files, groups: [], complete: false,
  inputHash: createHash("sha256").update((await Promise.all(files.map(async file => file + "\0" + await readFile(path.join(root,file),"utf8")))).join("\0")).digest("hex") };
for (let index = 0; index < groups.length; index++) {
  const log = path.join(output, `full-group-${index + 1}.log`), descriptor = await open(log, "w"), start = Date.now();
  console.log(JSON.stringify({ group: index + 1, files: groups[index].length, totalFiles: files.length, log }));
  let code;
  try { code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/run-node-tests.mjs", ...groups[index]], { cwd: root, stdio: ["ignore", descriptor.fd, descriptor.fd],
      env: { ...process.env, GSC_VERIFY_PR_RENDERER: "1" } });
    child.once("error", reject); child.once("close", code => resolve(code ?? 1));
  }); } finally { await descriptor.close(); }
  const text = await readFile(log, "utf8"), summary = Object.fromEntries([...text.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm)].map(match => [match[1], Number(match[2])]));
  record.groups.push({ group: index + 1, files: groups[index], code, elapsedMs: Date.now() - start, summary });
  await writeFile(path.join(output, "full-suite.json"), JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify({ group: index + 1, code, summary }));
  if (code !== 0) throw Error(`Full-suite group ${index + 1} failed; inspect ${log}`);
}
record.complete = true; await writeFile(path.join(output, "full-suite.json"), JSON.stringify(record, null, 2) + "\n");
