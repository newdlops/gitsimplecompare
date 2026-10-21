// 실제 Native Git으로 많은 stage-0 항목을 만들며 대응하는 사용자 작업 파일은 만들지 않는다.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { runGit, runGitWithInput } from "../../src/git/gitExec";

/** 검증 자체가 큰 index Buffer를 보유하지 않도록 파일의 바이트 해시를 스트림으로 계산한다. */
export async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex");
}

/**
 * hook/사용자 설정을 격리하고 한 blob을 가리키는 많은 정상 항목을 실제 index에 기록한다.
 * @param directory 이 benchmark가 소유한 빈 임시 부모 @param entries 항목 수
 * @returns Native tree, 현재 HEAD, 실제 index 경로·바이트 수·해시와 예상 ls-files 출력 fingerprint
 */
export async function createLargeIndexFixture(directory: string, entries: number) {
  const root = path.join(directory, "repository"); await mkdir(root);
  await runGit(["-c", "init.templateDir=", "init", "-q", "--initial-branch=main"], root);
  for (const [key, value] of Object.entries({ "user.name": "Index Fixture", "user.email": "index@example.invalid",
    "core.fsmonitor": "false", "core.splitIndex": "false", "commit.gpgSign": "false", "core.hooksPath": directory })) await runGit(["config", key, value], root);
  await runGit(["commit", "--allow-empty", "-qm", "base"], root);
  const blob = (await runGitWithInput(["hash-object", "-w", "--stdin"], root, "fixture\n")).trim();
  const input: string[] = [], expected = createHash("sha256"); let outputBytes = 0;
  for (let number = 0; number < entries; number++) {
    const name = `tracked-${String(number).padStart(8, "0")}-${"x".repeat(170)}.txt`;
    input.push(`100644 ${blob}\t${name}\0`);
    const record = `100644 ${blob} 0\t${name}\0`; expected.update(record); outputBytes += Buffer.byteLength(record);
  }
  await runGitWithInput(["update-index", "-z", "--index-info"], root, input.join(""));
  const tree = (await runGit(["write-tree"], root)).trim(), index = path.join(root, ".git/index");
  return { root, index, tree, head: (await runGit(["rev-parse", "HEAD"], root)).trim(), entries, outputBytes,
    expectedFingerprint: expected.digest("hex"), indexBytes: (await stat(index)).size, sha256: await fileDigest(index) };
}
