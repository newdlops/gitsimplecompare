// 격리 작업 결과 반영 중 reset --keep이 staged 파일을 지우지 않도록 실제 index lock 안에서 보호한다.
import { withConflictIndexTransaction } from "./conflictIndexTransaction";
import { runGit, runGitBuffer, runGitWithInput, withGitConfigOverrides } from "./gitExec";
import { logInfo } from "../ui/outputLog";
import { assertCurrentBranchHead } from "./refSafety";

/** reset 직전 보존할 stage-0 변경의 mode/OID/원본 경로다. 삭제는 mode 0으로 복원한다. */
interface StagedChange { mode: string; hash: string; file: Buffer; addition: boolean }

/**
 * 사용자 index를 잠근 상태에서 임시 index로 격리 작업 결과를 반영하고 원래 stage를 복구한다.
 * - 추가 파일은 reset 동안 untracked로 취급해 sparse checkout에서도 파일 삭제를 막는다.
 * - 결과가 같은 경로나 상위/하위 경로를 변경하면 사용자 내용을 건드리기 전에 중단한다.
 * @param repoRoot 결과를 반영할 실제 작업트리
 * @param targetRef 시작 HEAD에서 파생된, 이미 검증한 결과 commit
 * @param expected 있으면 실제 index lock을 얻은 뒤에도 원래 branch/HEAD가 유지되는지 검사한다.
 * @param label 오류와 OUTPUT에 표시할 작업 이름. 기존 PR 호출은 기본 이름을 유지한다.
 * @returns index 게시까지 끝나면 완료한다. 실패 시 원본 index와 복구 snapshot을 유지한다.
 */
export async function resetOperationResult(
  repoRoot: string, targetRef: string, expected?: { branch: string; head: string }, label = "PR"
): Promise<void> {
  const preserved = await withConflictIndexTransaction(repoRoot, true, async ({ indexEnv }) => {
    if (expected) await assertCurrentBranchHead(repoRoot, expected.branch, expected.head, `applying ${label} result with the index locked`);
    const env = withGitConfigOverrides(indexEnv, { "core.fsmonitor": "false" });
    const raw = await runGitBuffer([
      "diff", "--cached", "--raw", "--no-renames", "--no-abbrev", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "-z",
    ], repoRoot, { env });
    const changes = stagedChanges(raw, label), additions = changes.filter(change => change.addition);
    if (changes.length) {
      const incoming = nulRecords(await runGitBuffer([
        "diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "-z", "HEAD", targetRef, "--",
      ], repoRoot, { env }));
      if (hasOverlappingPaths(changes, incoming)) {
        const kind = additions.length === changes.length ? "staged new files" : "staged changes";
        throw new Error(`The ${label} result overlaps ${kind}. Your index and working files were kept.`);
      }
    }
    if (additions.length) {
      await runGitWithInput(["update-index", "--force-remove", "-z", "--stdin"], repoRoot,
        Buffer.concat(additions.flatMap(addition => [addition.file, Buffer.from([0])])), { env });
    }
    if (expected) await assertCurrentBranchHead(repoRoot, expected.branch, expected.head, `applying ${label} result with the index locked`);
    await runGit(["reset", "--keep", targetRef], repoRoot, { env, retryOnLock: false });
    if (changes.length) {
      await runGitWithInput(["update-index", "-z", "--index-info"], repoRoot,
        Buffer.concat(changes.flatMap(change => [Buffer.from(`${change.mode} ${change.hash}\t`), change.file, Buffer.from([0])])), { env });
    }
    return changes.length;
  });
  if (preserved) logInfo(`${label} staged changes preserved`, { repoRoot, count: preserved });
}

/** Git의 NUL raw 형식을 읽고 잘리거나 해석할 수 없는 index 정보는 반영 전에 거부한다. */
function stagedChanges(raw: Buffer, label: string): StagedChange[] {
  const parts = nulRecords(raw);
  if (parts.length % 2 !== 0) throw new Error(`Cannot safely read staged files before applying the ${label} result.`);
  const result: StagedChange[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const match = /^:\d{6} (000000|100644|100755|120000|160000) [a-f0-9]{40}(?:[a-f0-9]{24})? ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([AMDT])$/.exec(parts[index].toString("ascii"));
    if (!match) throw new Error(`Cannot safely preserve staged files before applying the ${label} result.`);
    result.push({ mode: match[1] === "000000" ? "0" : match[1], hash: match[2], file: parts[index + 1], addition: match[3] === "A" });
  }
  return result;
}

/** NUL 구분 레코드를 원본 바이트로 나눠 특수·비 UTF-8 파일명도 손실 없이 보호한다. */
function nulRecords(raw: Buffer): Buffer[] {
  const records: Buffer[] = [];
  for (let offset = 0; offset < raw.length;) {
    const end = raw.indexOf(0, offset);
    if (end <= offset) throw new Error("Cannot safely read Git paths before applying the operation result.");
    records.push(raw.subarray(offset, end)); offset = end + 1;
  }
  return records;
}

/**
 * staged×incoming 전체 조합 대신 경로와 상위 디렉터리 집합으로 겹침을 찾는다.
 * latin1은 바이트와 문자 사이가 일대일이므로 비 UTF-8 이름도 원본 경로와 같은 비교 결과를 낸다.
 * @param changes 보호할 staged 변경 @param incoming 결과가 바꿀 경로
 * @returns 같은 파일 또는 부모/자식 경로가 있으면 true. 비용은 경로 수와 각 경로 깊이에 비례한다.
 */
function hasOverlappingPaths(changes: StagedChange[], incoming: Buffer[]): boolean {
  const targets = new Set<string>(), parents = new Set<string>();
  for (const file of incoming) {
    const value = file.toString("latin1"); targets.add(value);
    for (let slash = value.indexOf("/"); slash >= 0; slash = value.indexOf("/", slash + 1)) {
      parents.add(value.slice(0, slash));
    }
  }
  for (const change of changes) {
    const value = change.file.toString("latin1");
    if (targets.has(value) || parents.has(value)) return true;
    for (let slash = value.indexOf("/"); slash >= 0; slash = value.indexOf("/", slash + 1)) {
      if (targets.has(value.slice(0, slash))) return true;
    }
  }
  return false;
}
