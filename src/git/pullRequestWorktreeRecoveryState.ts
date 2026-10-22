// 임시 PR 작업의 출처와 남은 큐를 worktree별 Git metadata에 보존한다.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { GitOperationIdentity } from "./operationControl";
import { readGitDirectory } from "./repositoryIdentity";
import { runGit, runGitWithInput } from "./gitExec";
import { PULL_REQUEST_OPERATION_COMMANDS, type PullRequestOperationCommand } from "./pullRequestOperationFormat";
import type { PullRequestInfo } from "./pullRequestInfo";

/** squash에서 하나씩 실행할 원본 patch와 merge revert의 mainline이다. */
export interface PullRequestRecoveryCommit { hash: string; mainline?: number }

/** 원래 작업트리와 detached 계산 worktree를 함께 고정한 재개 가능한 작업이다. */
export interface PullRequestWorktreeRecovery {
  version: 1 | 2;
  id: string;
  originRoot: string;
  originGitDir: string;
  worktreePath: string;
  worktreeGitDir: string;
  branch: string;
  beforeHead: string;
  command: PullRequestOperationCommand;
  pr: PullRequestInfo;
  phase: "conflicts" | "replaying" | "ready" | "applied";
  remaining: PullRequestRecoveryCommit[];
  sourceCommits: string[];
  /** false면 원래부터 파일 checkout을 생략한 결과 계산용 worktree다. */
  checkout: boolean;
  /** true면 compact replay 파일 복원이 실패해, 사용자 재개 전에 남은 S-tag를 다시 펼쳐야 한다. */
  compactReplay?: true;
  nativeOperation: GitOperationIdentity;
  afterHead?: string;
  expectedTree?: string;
  snapshotRef?: string;
  createdAt: number;
}

const DIRECTORY = "gitsimplecompare/pr-worktree-recoveries";
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[a-f0-9-]{36}$/;

/**
 * 현재 두 worktree의 실제 Git 경로를 고정해 충돌 복구 입력을 만든다.
 * @param input 작업 시작 정보와 충돌 시점의 native operation identity
 * @returns 아직 저장하지 않은 복구 레코드. 다른 저장소끼리는 결합하지 않는다.
 */
export async function createPullRequestWorktreeRecovery(
  input: Omit<PullRequestWorktreeRecovery, "version" | "id" | "originGitDir" | "worktreeGitDir" | "createdAt">
): Promise<PullRequestWorktreeRecovery> {
  const [originRoot, worktreePath, originGitDir, worktreeGitDir] = await Promise.all([
    realpath(input.originRoot), realpath(input.worktreePath),
    readGitDirectory(input.originRoot), readGitDirectory(input.worktreePath),
  ]);
  const record: PullRequestWorktreeRecovery = {
    ...input, originRoot, worktreePath, originGitDir, worktreeGitDir,
    // compact 복원 의무를 모르는 구버전은 v2를 자동 재개하지 않고 그대로 보존한다.
    version: input.compactReplay ? 2 : 1, id: randomUUID(), createdAt: Date.now(),
  };
  await assertPullRequestRecoveryIdentity(record);
  return record;
}

/**
 * 원래 worktree의 Git metadata에 원자적으로 저장한다. 사용자 파일과 공용 refs는 건드리지 않는다.
 * @param record 검증된 출처와 다음 단계 정보
 */
export async function writePullRequestWorktreeRecovery(record: PullRequestWorktreeRecovery): Promise<void> {
  if (!normalize(record)) throw new Error("Invalid PR recovery record.");
  const file = recordFile(record.originGitDir, record.id);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/**
 * 지정한 원래 worktree의 저장된 복구 기록만 읽는다.
 * @param originRoot PR 작업을 시작한 원래 worktree
 * @param id 알림 또는 목록에서 선택한 고정 ID
 * @returns 저장된 작업. 누락·손상·다른 worktree의 기록은 채택하지 않는다.
 */
export async function readPullRequestWorktreeRecovery(
  originRoot: string, id: string
): Promise<PullRequestWorktreeRecovery> {
  if (!ID.test(id)) throw new Error("Invalid PR recovery identifier.");
  const gitDir = await readGitDirectory(originRoot);
  const record = normalize(JSON.parse(await readFile(recordFile(gitDir, id), "utf8")));
  if (!record || record.id !== id || record.originGitDir !== gitDir ||
      record.originRoot !== await realpath(originRoot)) throw new Error("Cannot verify the PR recovery origin.");
  return record;
}

/**
 * 재시작 후 원래 worktree에 남은 작업을 최신순으로 찾는다. 디렉터리가 없을 때만 빈 목록이다.
 * @param originRoot 복구 작업을 시작한 저장소/worktree 루트
 * @returns 유효한 레코드 목록. 잘못된 기록은 실행 대상으로 추정하지 않는다.
 */
export async function listPullRequestWorktreeRecoveries(originRoot: string): Promise<PullRequestWorktreeRecovery[]> {
  const gitDir = await readGitDirectory(originRoot);
  let names: string[];
  try { names = await readdir(path.join(gitDir, DIRECTORY)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const records = await Promise.all(names.filter(name => ID.test(name.slice(0, -5)) && name.endsWith(".json"))
    .map(name => readPullRequestWorktreeRecovery(originRoot, name.slice(0, -5)).catch(() => undefined)));
  return records.filter((item): item is PullRequestWorktreeRecovery => Boolean(item))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 저장 경로·실제 Git directory·공유 object 저장소가 모두 같은 작업인지 다시 검증한다.
 * @param record 재개/반영 직전의 고정 입력
 * @returns 검증 실패 시 파일·브랜치·복구 기록을 그대로 두고 오류를 던진다.
 */
export async function assertPullRequestRecoveryIdentity(record: PullRequestWorktreeRecovery): Promise<void> {
  const [origin, worktree, originGitDir, worktreeGitDir, originCommon, worktreeCommon] = await Promise.all([
    realpath(record.originRoot), realpath(record.worktreePath),
    readGitDirectory(record.originRoot), readGitDirectory(record.worktreePath),
    commonDirectory(record.originRoot), commonDirectory(record.worktreePath),
  ]);
  if (origin !== record.originRoot || worktree !== record.worktreePath || origin === worktree ||
      originGitDir !== record.originGitDir || worktreeGitDir !== record.worktreeGitDir ||
      originCommon !== worktreeCommon || !path.basename(worktree).startsWith("gsc-pr-operation-")) {
    throw new Error("The PR recovery worktree changed. The saved result was left unchanged.");
  }
}

/** 반영이 완료된 자신의 레코드만 삭제한다. 보존 worktree 제거는 실행 서비스가 별도로 담당한다. */
export async function removePullRequestWorktreeRecovery(record: PullRequestWorktreeRecovery): Promise<void> {
  await rm(recordFile(record.originGitDir, record.id), { force: true });
  await runGitWithInput(["update-ref", "--stdin"], record.originRoot,
    record.sourceCommits.map((hash, index) => `delete refs/gitsimplecompare/pr-recovery-sources/${record.id}/${index} ${hash}\n`).join(""));
}

/** 남은 source commit을 GC로부터 보호한다. 임의 ref를 덮지 않고 새 UUID 경로만 만든다. */
export async function pinPullRequestRecoverySources(record: PullRequestWorktreeRecovery): Promise<void> {
  if (!record.sourceCommits.length) return;
  await runGitWithInput(["update-ref", "--stdin"], record.originRoot,
    record.sourceCommits.map((hash, index) => `create refs/gitsimplecompare/pr-recovery-sources/${record.id}/${index} ${hash}\n`).join(""));
}

/** @param root 확인할 worktree @returns symlink 표기 차이가 없는 공용 Git directory */
async function commonDirectory(root: string): Promise<string> {
  const raw = (await runGit(["rev-parse", "--git-common-dir"], root)).replace(/\r?\n$/, "");
  return realpath(path.resolve(root, raw));
}

/** @param gitDir 원래 worktree의 전용 Git directory @param id 검증된 UUID @returns metadata 파일 경로 */
function recordFile(gitDir: string, id: string): string { return path.join(gitDir, DIRECTORY, `${id}.json`); }

/** JSON의 필수 경로·OID·작업 종류를 검증한다. 출처 없는 예전 temp 디렉터리는 자동 채택하지 않는다. */
function normalize(value: unknown): PullRequestWorktreeRecovery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as PullRequestWorktreeRecovery;
  if (![1, 2].includes(item.version) || (item.version === 2 && item.compactReplay !== true) ||
      !ID.test(item.id) || !OID.test(item.beforeHead) ||
      !["originRoot", "originGitDir", "worktreePath", "worktreeGitDir"].every(key =>
        typeof item[key as keyof typeof item] === "string" && path.isAbsolute(item[key as keyof typeof item] as string)) ||
      typeof item.branch !== "string" || !item.branch ||
      !PULL_REQUEST_OPERATION_COMMANDS.includes(item.command) ||
      !["conflicts", "replaying", "ready", "applied"].includes(item.phase) ||
      !item.pr || !Number.isSafeInteger(item.pr.number) || typeof item.pr.title !== "string" ||
      !Array.isArray(item.remaining) || item.remaining.some(commit => !commit || !OID.test(commit.hash) ||
        (commit.mainline !== undefined && (!Number.isSafeInteger(commit.mainline) || commit.mainline < 1))) ||
      !Array.isArray(item.sourceCommits) || !item.sourceCommits.length || item.sourceCommits.some(hash => !OID.test(hash)) ||
      typeof item.checkout !== "boolean" ||
      (item.compactReplay !== undefined && (item.version !== 2 || item.compactReplay !== true || !item.checkout ||
        !["rebase", "rebaseRevert"].includes(item.command))) ||
      !item.nativeOperation || item.nativeOperation.gitDir !== item.worktreeGitDir ||
      !OID.test(item.nativeOperation.head) || typeof item.nativeOperation.epoch !== "string" ||
      (item.afterHead !== undefined && !OID.test(item.afterHead)) ||
      (item.expectedTree !== undefined && !OID.test(item.expectedTree)) ||
      (item.snapshotRef !== undefined && !item.snapshotRef.startsWith("refs/gitsimplecompare/pr-operation-index/")) ||
      !Number.isFinite(item.createdAt)) return undefined;
  return item;
}
