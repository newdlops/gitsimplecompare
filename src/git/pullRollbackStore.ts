// Pull 복구 stash와 해당 worktree에서 시작한 작업의 관계를 보존한다.
// - stash 목록은 worktree가 공유하므로 목록의 최신 항목만으로 복구 대상을 선택하지 않는다.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { detectOperation } from "./conflictService";
import { GitError, runGit } from "./gitExec";
import { runStash } from "./stashExec";

const PREFIX = "GSC_PULL_ROLLBACK";
const STATE_FILE = "gitsimplecompare/pull-rollback.json";
type Phase = "prepared" | "pull" | "restoreLocalChanges";
type Purpose = "rollback" | "automatic" | "resolvedPull" | "resolvedRestore";

/** 이동 가능한 stash 순번과 구분되는 복구 ID·객체 OID·원래 브랜치 정보다. */
export interface PullRollbackSnapshot {
  id: string;
  ref: string;
  hash: string;
  head: string;
  branch: string;
  createdAt: number;
}

interface Marker { text: string; stamp: string }
interface Binding {
  version: 1;
  snapshot: PullRollbackSnapshot;
  gitDir: string;
  phase: Phase;
  expectedHead: string;
  headLog: string;
  merge?: Marker;
}

/**
 * 하나의 worktree에서 시작한 pull만 복구하도록 stash와 Git 작업 표식을 함께 관리한다.
 * - 기존 버전의 stash도 목록에서는 보존하지만 작업 연결 정보가 없으면 자동 복원/삭제하지 않는다.
 */
export class PullRollbackStore {
  constructor(private readonly repoRoot: string) {}

  /**
   * 로컬 변경을 stash하고 생성 당시 브랜치·HEAD·worktree에 복구 기록을 연결한다.
   * @param head pull 시작 전에 읽은 HEAD OID
   * @param branch pull 시작 전에 읽은 로컬 브랜치
   * @param includeUntracked 미추적 파일도 pull을 막은 경우에만 true
   * @returns 실제 stash가 생성됐으면 그 복구 정보
   */
  async create(head: string, branch: string, includeUntracked: boolean): Promise<PullRollbackSnapshot | undefined> {
    await this.assertOrigin(branch, head);
    const id = randomUUID();
    const marker = [PREFIX, id, head, Date.now(), encodeURIComponent(branch)].join("|");
    await runStash(["push", ...(includeUntracked ? ["-u"] : []), "-m", marker], this.repoRoot, { retryOnLock: false });
    const snapshot = (await this.list()).find(item => item.id === id);
    if (snapshot) await this.bind(snapshot, "prepared", head);
    return snapshot;
  }

  /**
   * pull 충돌 또는 로컬 수정 복원 단계의 HEAD와 작업 표식을 원자적으로 저장한다.
   * @param snapshot 이 pull이 생성한 stash
   * @param phase 저장할 실행 단계
   * @param expectedHead 이 단계에서 작업 중이어야 할 HEAD
   */
  async bind(snapshot: PullRollbackSnapshot, phase: Phase, expectedHead: string): Promise<void> {
    await this.assertOrigin(snapshot.branch, expectedHead);
    const gitDir = await this.gitDir();
    const operation = await detectOperation(this.repoRoot);
    const merge = phase === "pull" ? await readMarker(path.join(gitDir, "MERGE_HEAD")) : undefined;
    if ((phase === "pull" && (operation !== "merge" || !merge)) ||
        (phase !== "pull" && operation !== "none")) throw staleRecovery();
    const binding: Binding = {
      version: 1, snapshot, gitDir, phase, expectedHead,
      headLog: await fileStamp(path.join(gitDir, "logs/HEAD")), merge,
    };
    const file = path.join(gitDir, STATE_FILE);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(binding), { flag: "wx" });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /**
   * 요청한 후속 작업에 현재 브랜치·HEAD·작업 표식이 맞는 복구 항목만 반환한다.
   * @param purpose rollback, 자동 오류 복구, merge 완료 후 복원, stash 충돌 해결 후 정리 중 하나
   * @returns 일치하는 stash. 다른 작업/브랜치 또는 사라진 기록이면 undefined
   */
  async find(purpose: Purpose = "rollback"): Promise<PullRollbackSnapshot | undefined> {
    const binding = await this.readBinding();
    if (!binding) return undefined;
    const branch = await this.currentBranch();
    if (branch !== binding.snapshot.branch) return undefined;
    const head = (await runGit(["rev-parse", "--verify", "HEAD"], this.repoRoot)).trim();
    const operation = await detectOperation(this.repoRoot);
    if (purpose === "resolvedPull") {
      if (binding.phase !== "pull" || operation !== "none" || !binding.merge) return undefined;
      const parents = (await runGit(["show", "-s", "--format=%P", "HEAD"], this.repoRoot)).trim();
      const expected = [binding.expectedHead, ...binding.merge.text.trim().split(/\s+/)].join(" ");
      if (parents !== expected) return undefined;
    } else {
      if (head !== binding.expectedHead ||
          await fileStamp(path.join(binding.gitDir, "logs/HEAD")) !== binding.headLog) return undefined;
      if (binding.phase === "pull") {
        if (purpose === "resolvedRestore" || operation !== "merge") return undefined;
        const current = await readMarker(path.join(binding.gitDir, "MERGE_HEAD"));
        if (!current || !binding.merge || current.stamp !== binding.merge.stamp ||
            current.text !== binding.merge.text) return undefined;
      } else {
        if (operation !== "none") return undefined;
        if (binding.phase === "prepared" && purpose !== "automatic") return undefined;
        if (purpose === "resolvedRestore" && binding.phase !== "restoreLocalChanges") return undefined;
        if (purpose === "rollback" && !(await runGit(
          ["diff", "--name-only", "--diff-filter=U", "-z"], this.repoRoot
        )).length) return undefined;
      }
    }
    return (await this.list()).find(snapshot =>
      snapshot.id === binding.snapshot.id && snapshot.hash === binding.snapshot.hash &&
      snapshot.branch === binding.snapshot.branch && snapshot.head === binding.snapshot.head
    );
  }

  /** 승인된 복구 ID가 여전히 현재 작업에 해당하는지 변경 명령 바로 전에 확인한다. */
  async assertCurrent(snapshot: PullRollbackSnapshot, purpose: Purpose): Promise<void> {
    const current = await this.find(purpose);
    if (!current || current.id !== snapshot.id || current.hash !== snapshot.hash) throw staleRecovery();
  }

  /**
   * abort 이후에도 원래 브랜치와 예상 HEAD인지 확인해 다른 작업을 hard reset하지 않는다.
   * @param branch 기대하는 로컬 브랜치
   * @param head 기대하는 HEAD OID
   */
  async assertOrigin(branch: string, head: string): Promise<void> {
    const currentBranch = await this.currentBranch();
    const currentHead = (await runGit(["rev-parse", "--verify", "HEAD"], this.repoRoot)).trim();
    if (currentBranch !== branch || currentHead !== head) throw staleRecovery();
  }

  /**
   * 현재 stash 순번에 의존하지 않고 승인된 객체 OID를 작업트리에 적용한다.
   * @param snapshot 적용할 복구 객체
   * @param resetHead rollback의 reset이 끝났으면 그 HEAD. 일반 복원은 저장된 작업 연결을 검증한다.
   */
  async apply(snapshot: PullRollbackSnapshot, resetHead?: string): Promise<void> {
    if (!(await this.list()).some(item => item.hash === snapshot.hash && item.id === snapshot.id)) throw staleRecovery();
    if (resetHead) {
      if (await detectOperation(this.repoRoot) !== "none") throw staleRecovery();
      await this.assertOrigin(snapshot.branch, resetHead);
    } else {
      await this.assertCurrent(snapshot, "automatic");
    }
    await runStash(["apply", "--index", snapshot.hash], this.repoRoot, { retryOnLock: false });
  }

  /**
   * 같은 stash 객체가 남아 있을 때만 최신 순번으로 제거하고 해당 worktree 연결 정보를 정리한다.
   * @param snapshot 복원에 성공했거나 사용자가 해결한 stash
   */
  async drop(snapshot: PullRollbackSnapshot): Promise<void> {
    const current = (await this.list()).find(item => item.hash === snapshot.hash && item.id === snapshot.id);
    if (!current) throw staleRecovery();
    const oid = (await runGit(["rev-parse", "--verify", current.ref], this.repoRoot)).trim();
    if (oid !== snapshot.hash) throw staleRecovery();
    await runStash(["drop", current.ref], this.repoRoot, { retryOnLock: false });
    const binding = await this.readBinding();
    if (binding?.snapshot.id === snapshot.id) await rm(path.join(binding.gitDir, STATE_FILE), { force: true });
  }

  /** stash 목록 조회 실패를 숨기지 않고, 유효한 복구 marker가 있는 항목만 해석한다. */
  private async list(): Promise<PullRollbackSnapshot[]> {
    const output = await runStash(["list", "--format=%gd%x1f%gs%x1f%H%x1e"], this.repoRoot);
    return output.split("\x1e").map(parseSnapshot).filter((item): item is PullRollbackSnapshot => Boolean(item));
  }

  /** linked worktree의 개별 git-dir를 실제 경로로 정규화하여 상태 파일을 분리한다. */
  private async gitDir(): Promise<string> {
    const directory = (await runGit(["rev-parse", "--absolute-git-dir"], this.repoRoot)).trim();
    return realpath(directory);
  }

  /** detached HEAD만 정상 결측으로 취급하고 실행/설정 오류는 호출부로 전달한다. */
  private async currentBranch(): Promise<string | undefined> {
    try {
      return (await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], this.repoRoot)).trim();
    } catch (error) {
      if (error instanceof GitError && error.code === 1) return undefined;
      throw error;
    }
  }

  /** 저장된 작업 정보는 필수 식별자가 유효하고 이 worktree에 속할 때만 사용한다. */
  private async readBinding(): Promise<Binding | undefined> {
    const gitDir = await this.gitDir();
    let raw: string;
    try {
      raw = await readFile(path.join(gitDir, STATE_FILE), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let binding: Binding;
    try { binding = JSON.parse(raw) as Binding; } catch { throw staleRecovery(); }
    if (binding?.version !== 1 || binding.gitDir !== gitDir ||
        !["prepared", "pull", "restoreLocalChanges"].includes(binding.phase) ||
        typeof binding.expectedHead !== "string" || typeof binding.headLog !== "string" ||
        typeof binding.snapshot?.id !== "string" || typeof binding.snapshot.hash !== "string" ||
        typeof binding.snapshot.branch !== "string" || typeof binding.snapshot.head !== "string") throw staleRecovery();
    return binding;
  }
}

/** stash subject에서 복구 정보를 파싱한다. 잘못된 외부 marker는 자동 복구 후보에서 제외한다. */
function parseSnapshot(record: string): PullRollbackSnapshot | undefined {
  const [rawRef, subject, rawHash] = record.split("\x1f");
  if (!rawRef || !subject || !rawHash) return undefined;
  const marker = subject.indexOf(`${PREFIX}|`);
  if (marker < 0) return undefined;
  const parts = subject.slice(marker).split("|");
  if (parts.length !== 5) return undefined;
  const [, id, head, timestamp, encodedBranch] = parts;
  const createdAt = Number(timestamp);
  if (!id || !/^[a-f0-9]{40,64}$/.test(head) || !Number.isFinite(createdAt)) return undefined;
  try {
    return { id, head, createdAt, branch: decodeURIComponent(encodedBranch), ref: rawRef.trim(), hash: rawHash.trim() };
  } catch { return undefined; }
}

/** Git 표식이 교체/재작성됐는지 확인할 파일 identity를 읽고 정상적인 부재만 빈 값으로 반환한다. */
async function fileStamp(file: string): Promise<string> {
  try {
    const info = await stat(file, { bigint: true });
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** merge 대상과 marker 파일의 세대를 함께 읽어 abort 후 새 merge를 이전 pull로 오인하지 않는다. */
async function readMarker(file: string): Promise<Marker | undefined> {
  const stamp = await fileStamp(file);
  if (!stamp) return undefined;
  try {
    const text = await readFile(file, "utf8");
    if (await fileStamp(file) !== stamp) throw staleRecovery();
    return { text, stamp };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 복구 대상이 달라졌을 때 stash를 보존하고 작업을 멈추는 공통 오류를 만든다. */
function staleRecovery(): Error {
  return new Error("Pull recovery no longer matches this branch or operation. Refresh and try again. Saved changes remain in the stash.");
}
